import type { ModelEntry } from "@tomverse/protocol";

/**
 * 예산 ledger — **유료 호출 전에 비용을 예약한다.**
 *
 * # 왜 사후 검사로 부족한가
 *
 * 예전 가설 게이트는 각 기록이 끝난 **뒤에** 누적 비용을 검사했다. 그러면 마지막 호출 하나의
 * 비용만큼 사용자 승인 상한을 넘길 수 있다. 호출 하나가 $2인 실험에서 이건 "상한을 지켰다"고
 * 말할 수 없는 크기다.
 *
 * 그래서 순서를 뒤집는다: **호출을 시작하기 전에 그 호출이 낼 수 있는 최대 비용을 예약하고,**
 * 예약할 수 없으면 호출하지 않는다. 완료 후 실제 사용량으로 정산한다.
 *
 * # 왜 sidecar(제품)에 있는가 — 그리고 **지금 제품은 이걸 쓰지 않는다**
 *
 * 측정 도구에만 두면 제품의 유료 호출 경로에는 같은 보호가 없게 된다. 사용자 돈을 쓰는 것은
 * 제품도 마찬가지이므로, 계약은 제품 쪽에 두고 가설 게이트가 그걸 **가져다 쓴다.**
 * 게이트는 (fixture, arm, 반복) 단위로, 제품은 provider 호출 단위로 예약한다 —
 * 같은 인터페이스로 둘 다 표현된다.
 *
 * **다만 `Orchestrator`의 provider 호출 경로에는 아직 예약이 없다.** 이 파일이 제품 패키지에
 * 있다는 것만으로 "제품이 보호된다"고 읽으면 안 된다. 지금 예약을 강제하는 것은 가설 게이트뿐이고,
 * 제품에 적용하기 위한 선행 조건 세 가지(승인 상한을 받는 UI, 예약 거부 시의 태스크 종료 사유,
 * SQLite `budget_events` 영속)는 `docs/design/multi-engine-routing.md` 10.6절에 적혀 있다.
 * 그것들이 정해지기 전에 끼워 넣으면 "상한 초과로 거부됐는데 태스크가 조용히 실패"가 먼저 생긴다.
 *
 * # 병렬 실행
 *
 * 지금은 순차 실행만 지원하지만(protocol v1), `reserve()`가 **예약 시점에 즉시 차감**하므로
 * 나중에 동시 실행을 붙여도 double-spend가 생기지 않는다. 두 호출이 동시에 예약을 요청하면
 * 남은 예산이 부족한 쪽이 거부된다.
 */

/**
 * 예산 원장 이벤트 — **append-only 감사 추적.**
 *
 * 예산과 승인 상태가 프로세스 메모리에만 있으면 재시작 후 아무것도 설명할 수 없다.
 * 원장은 이벤트를 만들기만 하고, 어디에 쓸지는 sink가 정한다(가설 게이트는 JSONL에 쓴다).
 *
 * **자격증명·API 키·authorization 헤더는 담지 않는다.** 이 이벤트는 저장되고 사람이 읽는다.
 */
export type BudgetEventType =
  | "approval_created"
  | "approval_raised"
  | "reservation_opened"
  | "reservation_released"
  | "reservation_settled"
  | "provider_usage_recorded"
  | "budget_estimate_breached"
  | "run_blocked";

export interface BudgetEvent {
  type: BudgetEventType;
  at: string;
  /** 어느 실행인가. 재시작 후 같은 원장을 이어받는 근거다. */
  runId: string;
  stage: string;
  /** 예약/호출 상관관계 ID — 어느 호출의 이야기인지 잇는다. */
  correlationId?: string;
  provider?: string;
  model?: string;
  approvedLimitUsd: number;
  reservedUsd?: number;
  actualUsd?: number;
  cumulativeUsd: number;
  reason?: string;
}

export interface LedgerContext {
  runId: string;
  stage: string;
  onEvent?: (event: BudgetEvent) => void;
  /** 시각 주입 — 테스트가 결정론적으로 검증할 수 있어야 한다. */
  now?: () => string;
}

export interface LedgerOptions extends Partial<LedgerContext> {
  /**
   * 이전 실행에서 **이미 확정된** 비용.
   *
   * # 이것이 없으면 승인 한도가 무의미해진다
   *
   * 예전에는 재개할 때 원장을 `createBudgetLedger(limit)`로 새로 만들었다. 그러면
   * `committed`가 0에서 시작하므로 **$25 한도에서 $20을 쓴 뒤 재개하면 추가로 $25를 더 쓸 수
   * 있었다.** 재시작 횟수만큼 한도가 늘어나는 것이므로 "승인 한도"라는 말이 성립하지 않는다.
   */
  initialCommittedUsd?: number;
}

/** 이 호출/작업이 낼 수 있는 **최대** 비용과 그 근거. */
export interface CostEstimate {
  maxUsd: number;
  /** 사람이 읽는 산출 근거 — Run Card와 오류 메시지에 그대로 나간다. */
  basis: string;
}

export interface Reservation {
  readonly id: string;
  readonly reservedUsd: number;
  /** 실제 사용량이 확정됐을 때. 예약을 풀고 확정 비용을 누적한다. */
  settle(actualUsd: number): void;
  /** 호출이 취소·타임아웃·오류로 끝나 비용이 발생하지 않았을 때. */
  release(): void;
  /** 이미 정산/해제됐는가 — 이중 정산을 막는다. */
  readonly settled: boolean;
}

export type ReserveOutcome =
  | { ok: true; reservation: Reservation }
  | {
      ok: false;
      /** 왜 예약할 수 없는가. 사용자에게 그대로 보여준다. */
      reason: string;
      requestedUsd: number;
      availableUsd: number;
    };

export interface BudgetLedger {
  /** 사용자가 승인한 상한. 이 값을 코드가 스스로 올리지 않는다. */
  readonly approvedLimitUsd: number;
  /** 이전 실행들에서 이미 확정된 비용 (재개 시 복원한 값). */
  historicalCommittedUsd(): number;
  /** 이번 프로세스에서 확정된 비용. */
  sessionCommittedUsd(): number;
  /** 전체 확정 비용 = historical + session. **승인 한도와 비교되는 값이다.** */
  cumulativeCommittedUsd(): number;
  /** 진행 중인 호출을 위해 잡아둔 금액. */
  reservedUsd(): number;
  /** 지금 새 호출에 쓸 수 있는 금액 = 상한 − historical − session − 예약. */
  availableUsd(): number;
  /**
   * 추정이 실제를 감당하지 못한 사실이 확인됐는가.
   * 한 번 true가 되면 이후 예약은 전부 거부된다 — 추정을 신뢰할 수 없는 상태에서
   * 유료 호출을 계속하는 것은 예산 상한이 없는 것과 같다.
   */
  estimateBreached(): boolean;
  /** 예약을 시도한다. 남은 금액이 부족하면 **호출하지 않는다**는 뜻의 실패를 돌려준다. */
  reserve(estimate: CostEstimate, label: string): ReserveOutcome;
  /** 상한을 올린 사실을 기록한다. 코드가 스스로 부르지 않고 사용자 승인이 있을 때만 부른다. */
  recordApprovalRaised(newLimitUsd: number, reason: string): void;
  /** 실행이 차단된 사실을 감사 추적에 남긴다. */
  recordBlocked(reason: string): void;
  /** 지금까지의 지출 요약 — 리포트/Run Card용. */
  snapshot(): BudgetSnapshot;
}

export interface BudgetSnapshot {
  approvedLimitUsd: number;
  historicalCommittedUsd: number;
  sessionCommittedUsd: number;
  cumulativeCommittedUsd: number;
  reservedUsd: number;
  availableUsd: number;
  estimateBreached: boolean;
  reservationsOpened: number;
  reservationsSettled: number;
  reservationsReleased: number;
}

/**
 * 승인 상한 검증. **여기서 걸러야 API 호출 전에 멈춘다.**
 *
 * 0과 음수를 거부하는 이유: "상한 0"은 "무제한"으로 오해될 여지가 있고, 실제로는
 * 아무것도 못 돌리는 값이다. 둘 다 사용자가 의도한 값일 가능성이 낮으므로 되묻게 한다.
 */
export function validateApprovedLimit(value: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(value)) {
    return { ok: false, reason: "예산 상한이 유한한 수가 아닙니다 (NaN 또는 Infinity)" };
  }
  if (value <= 0) {
    return { ok: false, reason: `예산 상한은 0보다 커야 합니다 (받은 값: ${value})` };
  }
  return { ok: true };
}

/**
 * 이전 실행에서 복원한 확정 비용 검증.
 *
 * 여기서 fail closed하는 것이 요점이다 — 복원값이 수상하면 "0으로 보고 계속"이 아니라 멈춘다.
 */
export function validateInitialCommitted(value: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `복원한 누적 비용이 유한한 수가 아닙니다 (${value})` };
  }
  if (value < 0) {
    return { ok: false, reason: `복원한 누적 비용이 음수입니다 (${value})` };
  }
  return { ok: true };
}

export function createBudgetLedger(approvedLimitUsd: number, options: LedgerOptions = {}): BudgetLedger {
  const check = validateApprovedLimit(approvedLimitUsd);
  if (!check.ok) throw new Error(check.reason);

  const historical = options.initialCommittedUsd ?? 0;
  const historicalCheck = validateInitialCommitted(historical);
  if (!historicalCheck.ok) throw new Error(historicalCheck.reason);

  const runId = options.runId ?? "(unknown-run)";
  const stage = options.stage ?? "(unknown-stage)";
  const now = options.now ?? ((): string => new Date().toISOString());
  const emit = (event: Omit<BudgetEvent, "at" | "runId" | "stage" | "approvedLimitUsd" | "cumulativeUsd">): void => {
    options.onEvent?.({
      ...event,
      at: now(),
      runId,
      stage,
      approvedLimitUsd,
      cumulativeUsd: historical + session,
    });
  };

  let session = 0;
  let reserved = 0;
  let opened = 0;
  let settledCount = 0;
  let releasedCount = 0;
  let breached = false;

  const available = (): number => approvedLimitUsd - historical - session - reserved;

  emit({ type: "approval_created", reason: `초기 승인 상한 $${approvedLimitUsd}, 복원된 누적 $${historical}` });

  return {
    approvedLimitUsd,
    historicalCommittedUsd: () => historical,
    sessionCommittedUsd: () => session,
    cumulativeCommittedUsd: () => historical + session,
    reservedUsd: () => reserved,
    availableUsd: available,
    estimateBreached: () => breached,

    reserve(estimate, label) {
      // **추정이 한 번 틀린 것이 확인되면 더 이상 유료 호출을 시작하지 않는다.**
      if (breached) {
        const reason =
          `${label}: 이전 호출의 실제 비용이 예약액을 초과했습니다 (BUDGET_ESTIMATE_BREACH). ` +
          `추정을 신뢰할 수 없는 상태로는 유료 호출을 계속하지 않습니다.`;
        emit({ type: "run_blocked", correlationId: label, reason });
        return { ok: false, reason, requestedUsd: estimate.maxUsd, availableUsd: available() };
      }
      if (!Number.isFinite(estimate.maxUsd) || estimate.maxUsd < 0) {
        // 비용을 계산할 수 없으면 **추측해서 진행하지 않는다.** 예산 상한이 아무것도 막지
        // 못하는 상태로 유료 호출을 시작하는 것이 이 ledger가 존재하는 이유와 정면으로 어긋난다.
        const reason = `${label}: 예상 비용을 계산할 수 없습니다 (${estimate.maxUsd}). ${estimate.basis}`;
        emit({ type: "run_blocked", correlationId: label, reason });
        return { ok: false, reason, requestedUsd: Number.NaN, availableUsd: available() };
      }
      if (estimate.maxUsd > available()) {
        const reason =
          `${label}: 예상 최대 비용 $${estimate.maxUsd.toFixed(4)}가 남은 예산 ` +
          `$${available().toFixed(4)}를 초과합니다 (승인 상한 $${approvedLimitUsd}, ` +
          `이미 확정 $${(historical + session).toFixed(4)} = 이전 $${historical.toFixed(4)} + ` +
          `이번 $${session.toFixed(4)}). ${estimate.basis}`;
        emit({ type: "run_blocked", correlationId: label, reason });
        return { ok: false, reason, requestedUsd: estimate.maxUsd, availableUsd: available() };
      }

      reserved += estimate.maxUsd;
      opened += 1;
      const amount = estimate.maxUsd;
      const id = `${label}#${opened}`;
      emit({ type: "reservation_opened", correlationId: id, reservedUsd: amount, reason: estimate.basis });

      let done = false;
      const reservation: Reservation = {
        id,
        reservedUsd: amount,
        get settled() {
          return done;
        },
        settle(actualUsd: number) {
          if (done) throw new Error(`예약 ${id}이(가) 이미 정산되었습니다`);
          done = true;
          settledCount += 1;
          reserved -= amount;
          // 실제 비용이 예약보다 클 수 있다(추정이 틀린 경우). 그때도 **실제 값을 기록한다** —
          // 예약액으로 깎아 기록하면 장부가 실제 청구액과 어긋난다.
          const actual = Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0;
          session += actual;
          emit({ type: "reservation_settled", correlationId: id, reservedUsd: amount, actualUsd: actual });
          emit({ type: "provider_usage_recorded", correlationId: id, actualUsd: actual });

          // **예약보다 실제가 크면 추정이 틀렸다는 뜻이다.** 조용히 넘기면 available이 음수인
          // 상태로 계속 돌 수 있고, 그건 승인 한도가 없는 것과 같다.
          if (actual > amount) {
            breached = true;
            emit({
              type: "budget_estimate_breached",
              correlationId: id,
              reservedUsd: amount,
              actualUsd: actual,
              reason:
                `실제 비용 $${actual.toFixed(4)}이 예약액 $${amount.toFixed(4)}을 초과했습니다. ` +
                `이후 유료 호출을 차단합니다.`,
            });
          }
        },
        release() {
          if (done) throw new Error(`예약 ${id}이(가) 이미 정산되었습니다`);
          done = true;
          releasedCount += 1;
          reserved -= amount;
          emit({ type: "reservation_released", correlationId: id, reservedUsd: amount });
        },
      };
      return { ok: true, reservation };
    },

    recordApprovalRaised(newLimitUsd, reason) {
      // 상한 자체는 바꾸지 않는다 — 새 상한으로는 **새 원장**을 만들어야 한다.
      // 여기서는 "사용자가 올렸다"는 사실만 감사 추적에 남긴다.
      emit({ type: "approval_raised", reason: `${reason} (새 상한 $${newLimitUsd})` });
    },

    recordBlocked(reason) {
      emit({ type: "run_blocked", reason });
    },

    snapshot: () => ({
      approvedLimitUsd,
      historicalCommittedUsd: historical,
      sessionCommittedUsd: session,
      cumulativeCommittedUsd: historical + session,
      reservedUsd: reserved,
      availableUsd: available(),
      estimateBreached: breached,
      reservationsOpened: opened,
      reservationsSettled: settledCount,
      reservationsReleased: releasedCount,
    }),
  };
}

// ---------------------------------------------------------------------------
// 비용 추정
// ---------------------------------------------------------------------------

/**
 * 컨텍스트 엔진이 한 호출에 넣는 토큰 예산의 기본값.
 * `packages/sidecar/src/context/engine.ts`의 `primaryBudget` 기본값과 같아야 한다.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 60_000;

/**
 * 한 번의 provider 호출에 요청하는 **출력 토큰 상한.**
 *
 * # 왜 모델 최대치를 쓰지 않는가
 *
 * 어댑터는 `max_output_tokens`에 `entry.capabilities.maxOutputTokens`를 그대로 넘겼다.
 * gpt-4.1은 32,768, claude-sonnet-5는 64,000이다. 그 값이 **비용 상한을 지배한다** —
 * 가설 게이트 P1의 보수적 최대 비용에서 출력 토큰이 약 85%를 차지했다.
 *
 * 우리가 모델에게 요청하는 것은 patch가 담긴 JSON 하나다. 6만 토큰 출력은 필요하지 않고,
 * 지연에도 불리하다(출력 토큰 수가 곧 생성 시간이다).
 *
 * # 왜 더 낮추지 않는가
 *
 * 너무 낮으면 출력이 잘려 구조화 출력이 스키마를 만족하지 못하고, 그러면
 * `schema_violation` → 재시도가 된다. **돈과 정확도를 함께 잃는 실패**이고, 게이트에서는
 * 모델 실패로 오분류될 수 있다. 그래서 현실적 필요보다 넉넉한 쪽으로 잡는다 —
 * 16,000 토큰은 수백 줄 규모의 다중 파일 patch를 담고도 여유가 있다.
 *
 * # 왜 역할별로 다르게 하지 않는가
 *
 * 검수 응답은 초안보다 짧지만, arm마다 다른 상한을 주면 A와 C/D의 비교에 상한이라는
 * 교란 변수가 들어간다. 실험 공정성을 위해 **모든 역할·모든 arm이 같은 값**을 쓴다.
 *
 * 이 값을 바꾸면 비용 추정과 실제 요청이 함께 움직여야 한다. 그래서 상수를 여기 한 곳에 두고
 * 어댑터와 게이트의 추정기가 **같은 것을 읽는다** — 한쪽만 바꾸면 예약이 실제와 어긋난다.
 */
export const MAX_OUTPUT_TOKENS_PER_CALL = 16_000;

/**
 * 이 모델에 실제로 요청할 출력 토큰 수.
 *
 * 모델이 우리 상한보다 작은 최대치를 가질 수 있으므로(예: 8,192) 더 작은 쪽을 쓴다.
 */
export function effectiveMaxOutputTokens(entry: ModelEntry): number {
  return Math.min(entry.capabilities.maxOutputTokens, MAX_OUTPUT_TOKENS_PER_CALL);
}

export interface CallCostInput {
  /** 이 호출에 넣을 입력 토큰 상한. 모델의 maxContextTokens를 넘지 못한다. */
  maxInputTokens: number;
  /** provider에 실제로 전달하는 최대 출력 토큰. */
  maxOutputTokens: number;
}

/**
 * 한 번의 provider 호출이 낼 수 있는 최대 비용.
 *
 * **모델에 가격 정보가 없으면 `undefined`다.** 0으로 대체하지 않는다 — 0은 "공짜"라는 뜻이고,
 * 그건 fake provider에만 참이다. 모르는 것을 0으로 적으면 예산 상한이 아무것도 막지 못한다.
 */
export function maxCallCostUsd(entry: ModelEntry, input: CallCostInput): number | undefined {
  const { inputPerMTok, outputPerMTok } = entry.economics;
  if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) return undefined;
  if (inputPerMTok < 0 || outputPerMTok < 0) return undefined;

  const inputTokens = Math.min(input.maxInputTokens, entry.capabilities.maxContextTokens);
  // 호출자가 넘긴 값과 모델 최대치 중 작은 쪽. 호출자는 `effectiveMaxOutputTokens`를 넘기므로
  // 추정과 실제 요청이 같은 수를 쓴다 — 어긋나면 예약이 실제 청구와 맞지 않는다.
  const outputTokens = Math.min(input.maxOutputTokens, entry.capabilities.maxOutputTokens);
  return (inputTokens / 1_000_000) * inputPerMTok + (outputTokens / 1_000_000) * outputPerMTok;
}

/**
 * 가격 정보가 실제로 쓸 수 있는 상태인가.
 *
 * 기준일이 없으면 "언제 기준인지 모르는 가격"이고, 그걸로 계산한 예산은 신뢰할 수 없다.
 * 단가가 전부 0인 것은 fake provider만 정당하다 — 실제 공급자가 0이면 데이터 결함이다.
 */
export function pricingIsUsable(entry: ModelEntry, options: { allowZero: boolean }): { ok: true } | { ok: false; reason: string } {
  const { inputPerMTok, outputPerMTok, pricingAsOf } = entry.economics;
  if (typeof pricingAsOf !== "string" || pricingAsOf.trim().length === 0) {
    return { ok: false, reason: `${entry.modelId}: 가격 기준일(pricingAsOf)이 없습니다` };
  }
  if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) {
    return { ok: false, reason: `${entry.modelId}: 단가가 유한한 수가 아닙니다` };
  }
  if (inputPerMTok < 0 || outputPerMTok < 0) {
    return { ok: false, reason: `${entry.modelId}: 단가가 음수입니다` };
  }
  if (!options.allowZero && inputPerMTok === 0 && outputPerMTok === 0) {
    return {
      ok: false,
      reason: `${entry.modelId}: 실제 공급자인데 단가가 0입니다 — 가격 정보가 누락된 것으로 봅니다`,
    };
  }
  return { ok: true };
}
