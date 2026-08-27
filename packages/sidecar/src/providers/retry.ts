import type { NormalizedProviderError, TokenUsage } from "@tomverse/protocol";
import type { DispatchState } from "../budget/ledger.js";
import { isRetryableKind, normalizeProviderError } from "./errors.js";
import { ProviderCallFailure } from "./types.js";

/**
 * 공급자 호출 인프라 재시도 — docs/design/state-machine-and-protocol.md 9절.
 *
 * `toolRetries`/`reviseRounds`/`fixLoopRounds`와 **완전히 다른 축**이다: 429나 5xx는 모델의
 * 판단과 무관한 전송 계층 문제이므로 의미론적 루프 카운터와 섞으면 안 된다.
 */

export interface RetryPolicy {
  /** 최대 시도 횟수 (첫 시도 포함이 아니라 재시도 상한 — 9절 표의 "최대 3") */
  maxRetries: number;
  rateLimitBaseMs: number;
  rateLimitCapMs: number;
  transientBaseMs: number;
  transientCapMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  rateLimitBaseMs: 2_000,
  rateLimitCapMs: 60_000,
  transientBaseMs: 1_000,
  transientCapMs: 30_000,
};

/**
 * 재시도까지 끝난 뒤의 최종 실패.
 *
 * # 왜 `facts`가 필요한가 (§2.6)
 *
 * 예전에는 이 클래스가 `NormalizedProviderError`만 실었다. 그런데 어댑터가 던지는
 * `ProviderCallFailure`에는 **과금 판정에 필요한 사실**(요청이 나갔는가, usage를 받았는가,
 * 응답 envelope의 모델 ID는 무엇인가)이 들어 있고, 그것이 여기서 통째로 사라졌다.
 * 사실이 사라지면 호출자는 "모른다"를 "안 썼다"로 읽는 쪽으로 기울게 된다.
 *
 * 마지막 시도의 사실만이 아니라 **모든 attempt의 사실**을 보존한다 — 첫 시도가 과금되고
 * 재시도가 거절당한 경우, 마지막만 보면 과금이 보이지 않는다.
 */
export interface ProviderAttemptFacts {
  attempt: number;
  dispatchState: DispatchState;
  usage?: TokenUsage;
  providerReportedModelId?: string;
  providerRequestId?: string;
  errorKind: string;
}

export class ProviderCallFailed extends Error {
  constructor(
    readonly normalized: NormalizedProviderError,
    readonly attempts: number,
    readonly exhausted: boolean,
    /** 시도별 dispatch 사실. 어댑터가 `ProviderCallFailure`를 던진 시도만 채워진다. */
    readonly facts: ProviderAttemptFacts[] = []
  ) {
    super(normalized.message);
    this.name = "ProviderCallFailed";
  }
}

/** 어댑터 오류에서 보존해야 하는 사실을 뽑는다. 평범한 `Error`면 dispatch를 모른다. */
export function attemptFacts(attempt: number, raw: unknown, kind: string): ProviderAttemptFacts {
  if (raw instanceof ProviderCallFailure) {
    return {
      attempt,
      dispatchState: raw.dispatchState,
      ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
      ...(raw.providerReportedModelId !== undefined
        ? { providerReportedModelId: raw.providerReportedModelId }
        : {}),
      ...(raw.providerRequestId !== undefined ? { providerRequestId: raw.providerRequestId } : {}),
      errorKind: kind,
    };
  }
  /**
   * **추론 전 반려는 아는 사실이다.**
   *
   * 429·401·403이 아닌 4xx는 공급자가 요청을 검증 단계에서 되돌린 것이므로 생성이 시작되지
   * 않았고 과금도 없다 — 이 저장소에서 실측으로 확인했다(strict 스키마 400 거절이 공급자 청구
   * 내역에 없었다). 이걸 `dispatched_no_response`로 두면 "돈을 썼는지 모른다"가 되어 예약을
   * 해제할 수 없고, **그 한 건이 실행 전체를 멈춘다.**
   *
   * 5xx·타임아웃과는 반대 방향의 사실이라는 점이 요점이다. 저쪽은 응답을 만든 뒤 실패했을 수
   * 있으므로 모른다고 해야 하고, 이쪽은 만들기 전에 거절당했으므로 안다고 할 수 있다.
   */
  if (kind === "rejected") {
    return { attempt, dispatchState: "not_dispatched", errorKind: kind };
  }
  // **모르면 불확실로 본다.** 어댑터 안쪽에서 난 오류는 요청이 나간 뒤일 수 있다.
  return { attempt, dispatchState: "dispatched_no_response", errorKind: kind };
}

export interface RetryHooks {
  /** 재시도할 때마다 호출된다 — 이벤트 로그에 PROVIDER_RETRY를 남기기 위한 통로 */
  onRetry?: (info: { attempt: number; delayMs: number; error: NormalizedProviderError }) => void;
  /** 테스트에서 실제로 기다리지 않도록 주입 가능하게 둔다 */
  sleep?: (ms: number) => Promise<void>;
}

export function backoffDelayMs(error: NormalizedProviderError, attempt: number, policy: RetryPolicy): number {
  // Retry-After 헤더가 있으면 그것을 우선 존중한다 (9절 표).
  if (error.kind === "rate_limit" && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, policy.rateLimitCapMs);
  }
  const [base, cap] =
    error.kind === "rate_limit"
      ? [policy.rateLimitBaseMs, policy.rateLimitCapMs]
      : [policy.transientBaseMs, policy.transientCapMs];
  return Math.min(base * 2 ** (attempt - 1), cap);
}

/**
 * 재시도 래퍼.
 *
 * 상한에 도달하면 `exhausted: true`인 `ProviderCallFailed`를 던진다 — Orchestrator가 이걸
 * `provider_retry_exhausted`로, 재시도 불가 오류를 `provider_config_error`로 매핑한다.
 */
export async function callWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  hooks: RetryHooks = {}
): Promise<{ value: T; attempts: number }> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  // **모든 attempt의 사실을 모은다.** 첫 시도가 과금되고 재시도가 거절당한 경우,
  // 마지막 시도만 보면 그 과금이 보이지 않는다(§2.6).
  const facts: ProviderAttemptFacts[] = [];

  for (;;) {
    attempt += 1;
    try {
      const value = await fn(attempt - 1);
      return { value, attempts: attempt };
    } catch (raw) {
      const normalized = normalizeProviderError(raw);
      facts.push(attemptFacts(attempt - 1, raw, normalized.kind));

      // 취소는 재시도 대상이 아니다 — 사용자가 멈추라고 한 것을 다시 부르면 안 된다.
      if (normalized.kind === "cancelled") {
        throw new ProviderCallFailed(normalized, attempt, false, facts);
      }
      if (!isRetryableKind(normalized.kind) || !normalized.retryable) {
        throw new ProviderCallFailed(normalized, attempt, false, facts);
      }
      if (attempt > policy.maxRetries) {
        throw new ProviderCallFailed(normalized, attempt, true, facts);
      }

      const delayMs = backoffDelayMs(normalized, attempt, policy);
      hooks.onRetry?.({ attempt, delayMs, error: normalized });
      await sleep(delayMs);
    }
  }
}

export interface ScopedSignal {
  signal: AbortSignal;
  /**
   * 이 호출이 **타임아웃 때문에** 중단됐는지. 사용자 취소와 구별해야 하는 이유:
   * 취소는 재시도 대상이 아니고 태스크가 CANCELLED로 끝나야 하지만, 타임아웃은 재시도 대상이며
   * 상한 초과 시 FAILED가 되어야 한다. SDK는 둘 다 AbortError로 던지므로 신호를 만든 쪽이 기억해야 한다.
   */
  timedOut: () => boolean;
  dispose: () => void;
}

/** 호출 하나에 타임아웃 + 취소를 붙인다. 상한 없는 대기를 만들지 않는다(CLAUDE.md 원칙 5). */
export function withTimeout(parentSignal: AbortSignal, timeoutMs: number): ScopedSignal {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    const error = new Error(`공급자 호출이 ${timeoutMs}ms 후 타임아웃됨`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut && !parentSignal.aborted,
    dispose: () => {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}

/** 타임아웃으로 중단된 호출의 오류를 타임아웃으로 다시 표기한다. */
export function asTimeoutError(cause: unknown, timeoutMs: number): Error {
  const error = new Error(`공급자 호출이 ${timeoutMs}ms 후 타임아웃됨 (${describe(cause)})`);
  error.name = "TimeoutError";
  return error;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
