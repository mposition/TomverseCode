import type { ModelEntry, TaskBudgetOutcome, TaskBudgetState } from "@tomverse/protocol";
import {
  createBudgetLedger,
  effectiveMaxOutputTokens,
  maxCallCostUsd,
  validateApprovedLimit,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  type BudgetEvent,
  type BudgetLedger,
  type CostEstimate,
  type LedgerState,
  type Reservation,
  type Settlement,
} from "../budget/ledger.js";

/**
 * 태스크 하나의 예산 강제 — `BudgetLedger`를 **제품 호출 경로에** 붙인다.
 *
 * # 이 파일이 생기기 전까지의 상태
 *
 * `budget/ledger.ts`는 처음부터 제품 패키지에 있었지만, 예약을 강제하는 것은 가설 게이트뿐이었고
 * 제품은 상한 없이 호출했다(multi-engine-routing.md 10.6절). 파일이 제품 패키지에 있다는 것만으로
 * 보호된다고 읽으면 안 되는 상태였고, 이 파일이 그 간극을 닫는다.
 *
 * # 무엇을 막고 무엇을 막지 못하는가
 *
 * 막는 것: 우리 코드의 폭주다. FIX_LOOP가 상한까지 도는 것, 대조로 실행자가 둘이 되는 것,
 * 재시도가 겹치는 것 — 전부 사용자 돈이고 전부 이 경로를 지난다.
 *
 * **막지 못하는 것: 장악당한 sidecar다.** API 키는 이미 이 프로세스 안에 있으므로(원칙 2가
 * 지키는 것은 파일·셸·자격증명이고, 공급자 HTTP 호출은 Node가 직접 한다), Node가 장악되면
 * 상한도 함께 무너진다. 강제를 Rust로 옮겨도 Rust가 HTTP를 대신 하지 않는 한 달라지지 않는다.
 * 이건 보호의 성질이지 구현의 결함이 아니므로 여기 적어두고, 문서도 같은 말을 한다.
 *
 * # 가격을 모르면 강제할 수 없다
 *
 * 레지스트리에 없는 모델이나 단가가 비어 있는 모델은 최대 비용을 계산할 수 없다. 그때
 * **0으로 대체하지 않는다** — 0은 "공짜"라는 뜻이고 그 순간 상한이 아무것도 막지 못한다.
 * 상한이 설정되어 있으면 호출을 거부하고(fail closed), 상한이 없으면 그대로 진행하되
 * 그 호출을 `unpricedCalls`로 센다. 후자에서 `spentUsd`는 **하한이다.**
 */

/** 호출 한 건의 예약 결과. 실패하면 **호출하지 않는다.** */
export type CallBudget =
  | { ok: true; reservation: Reservation | null }
  | { ok: false; reason: string; state: TaskBudgetState };

export interface SettleInput {
  costUsd: number | undefined;
  usage: { inputTokens: number; outputTokens: number } | undefined;
  providerKind: "real" | "fake";
  requestedModelId?: string;
  providerReportedModelId?: string;
  providerRequestId?: string;
}

/**
 * 예산 강제기.
 *
 * 상한이 `null`이면 원장을 만들지 않는다 — 원장은 상한과 비교하는 물건이고, 비교할 값이 없는
 * 원장은 "예약이 언제나 통과하는 원장"이라 있는 것과 없는 것을 구별할 수 없게 만든다.
 * 대신 지출을 계속 세고, 그 사실이 `state: "not_enforced"`로 결과에 남는다.
 */
export class TaskBudget {
  private readonly ledger: BudgetLedger | null;
  /**
   * 가격을 모르는 모델로 나간 호출 수.
   *
   * **예약 시점에만 센다.** 정산 시점의 "비용을 계산할 수 없음"은 같은 사실(레지스트리에
   * 가격이 없음)에서 나오므로, 양쪽에서 세면 한 호출이 둘로 세어진다.
   */
  private unpricedCalls = 0;
  /** 상한이 없을 때의 지출 합계. 원장이 있으면 원장이 정본이므로 쓰지 않는다. */
  private unenforcedSpentUsd = 0;
  private lastReason: string | null = null;

  private constructor(
    private readonly limitUsd: number | null,
    ledger: BudgetLedger | null
  ) {
    this.ledger = ledger;
  }

  /**
   * 상한을 검증하고 강제기를 만든다.
   *
   * **여기서 걸러야 첫 호출 전에 멈춘다.** 상한이 NaN이거나 0 이하인 채로 시작하면 태스크가
   * 한참 돈 뒤에 첫 유료 호출에서 죽고, 사용자는 무엇이 잘못됐는지 모른다.
   */
  static create(
    limitUsd: number | null,
    ctx: { taskId: string; onEvent: (event: BudgetEvent) => void }
  ): { ok: true; budget: TaskBudget } | { ok: false; reason: string } {
    if (limitUsd === null) {
      return { ok: true, budget: new TaskBudget(null, null) };
    }
    const valid = validateApprovedLimit(limitUsd);
    if (!valid.ok) return { ok: false, reason: valid.reason };
    const ledger = createBudgetLedger(limitUsd, {
      runId: ctx.taskId,
      stage: "task",
      onEvent: ctx.onEvent,
      // **타임아웃 하나가 태스크의 남은 호출을 전부 막으면 안 된다.** 타임아웃은 재시도
      // 대상으로 설계된 정상적인 실패인데(원칙 5), 그것 때문에 태스크가 "예산이 모자랍니다"로
      // 끝나면 사용자는 틀린 이유를 보게 된다. 막지 않아도 상한은 지켜진다 — 미해결액은
      // 남은 예산에서 계속 빠져 있으므로 이미 쓴 것으로 취급된다.
      blockOnUnresolved: false,
    });
    return { ok: true, budget: new TaskBudget(limitUsd, ledger) };
  }

  /** 상한을 강제하고 있는가. 화면과 결과가 이걸 구별해야 한다. */
  get enforced(): boolean {
    return this.ledger !== null;
  }

  /**
   * 이 호출의 최대 비용을 예약한다.
   *
   * `entry`가 없거나 가격이 없으면 최대 비용을 알 수 없다 — 상한이 있으면 거부하고, 없으면
   * 통과시키되 센다.
   */
  reserve(entry: ModelEntry | undefined, label: string): CallBudget {
    const estimate = estimateCall(entry);
    if (estimate === null) {
      this.unpricedCalls += 1;
      if (this.ledger === null) return { ok: true, reservation: null };
      const reason =
        `${label}: 이 모델의 가격을 알 수 없어 예산 상한을 강제할 수 없습니다. ` +
        `상한을 강제하려면 모델의 단가가 레지스트리에 있어야 하고, 그렇지 않으면 상한을 끄고 실행해야 합니다.`;
      this.ledger.recordBlocked(reason);
      this.lastReason = reason;
      return { ok: false, reason, state: "blocked" };
    }
    if (this.ledger === null) return { ok: true, reservation: null };

    const outcome = this.ledger.reserve(estimate, label);
    if (outcome.ok) return { ok: true, reservation: outcome.reservation };

    // 상한이 한 호출의 최대 비용보다 작으면 첫 호출부터 거부된다. 그 경우 "예산 부족"만
    // 말하면 사용자는 상한을 조금 올리며 같은 실패를 반복한다 — 두 숫자를 함께 낸다.
    const reason =
      `${outcome.reason} (이 호출의 최대 비용 $${estimate.maxUsd.toFixed(4)}, ` +
      `남은 예산 $${outcome.availableUsd.toFixed(4)}, 상한 $${(this.limitUsd ?? 0).toFixed(2)})`;
    this.lastReason = reason;
    return { ok: false, reason, state: outcome.state ? "blocked" : "limit_reached" };
  }

  /**
   * 실제 사용량으로 정산한다.
   *
   * **비용을 모르는 것과 0달러를 구별한다.** `costUsd`가 `undefined`면 측정 실패로 정산하고,
   * 원장은 그 시점부터 새 예약을 받지 않는다 — 비용을 모르는 채로 유료 호출을 계속하는 것은
   * 상한이 없는 것과 같기 때문이다.
   */
  settle(reservation: Reservation | null, input: SettleInput): void {
    if (this.ledger === null) {
      // 상한이 없으면 원장도 없으므로 여기서 센다. 모르는 비용은 더하지 않는다 —
      // 0으로 더하면 이 숫자가 "썼는데 안 썼다"고 말하게 되고, 그 사실은
      // `unpricedCalls`가 대신 말한다.
      if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd)) {
        this.unenforcedSpentUsd += input.costUsd;
      }
      return;
    }
    if (reservation === null || reservation.settled) return;

    const settlement: Settlement = {
      cost:
        typeof input.costUsd === "number" && Number.isFinite(input.costUsd)
          ? { measured: true, usd: input.costUsd }
          : { measured: false, reason: "레지스트리에 이 모델의 가격이 없어 비용을 계산할 수 없습니다" },
      usage: input.usage
        ? { measured: true, inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens }
        : { measured: false, reason: "공급자 응답에 usage가 없습니다" },
      providerKind: input.providerKind,
      requestedModelId: input.requestedModelId,
      providerReportedModelId: input.providerReportedModelId,
      providerRequestId: input.providerRequestId,
    };
    const outcome = reservation.settle(settlement);
    if (!outcome.ok) this.lastReason = outcome.reason;
  }

  /**
   * 호출이 **나가지 않은 채** 끝났다 / 나갔는지 알 수 없는 채 끝났다.
   *
   * 둘을 타입으로 구별하는 것이 원장 계약의 요점이므로 여기서도 섞지 않는다. 보낸 뒤의
   * 실패를 해제하면 쓴 돈을 안 쓴 것으로 만든다.
   */
  abandon(reservation: Reservation | null, dispatched: boolean, reason: string): void {
    if (reservation === null || reservation.settled) return;
    if (dispatched) {
      reservation.markUnresolved({ dispatchState: "dispatched_no_response", reason });
    } else {
      reservation.release({ dispatchState: "not_dispatched", reason });
    }
  }

  /** 결과에 실을 요약. 실패한 태스크에도 담긴다 — 돈은 결과와 무관하게 나갔다. */
  outcome(): TaskBudgetOutcome {
    if (this.ledger === null) {
      return {
        limitUsd: null,
        spentUsd: round6(this.unenforcedSpentUsd),
        unresolvedUsd: 0,
        unpricedCalls: this.unpricedCalls,
        state: "not_enforced",
      };
    }
    const snap = this.ledger.snapshot();
    const state = classify(snap.state, this.lastReason !== null && snap.state === "OK");
    return {
      limitUsd: snap.approvedLimitUsd,
      spentUsd: round6(snap.cumulativeCommittedUsd),
      unresolvedUsd: round6(snap.unresolvedUsd),
      unpricedCalls: this.unpricedCalls,
      state,
      ...(snap.state === "OK" ? {} : { detail: snap.state }),
    };
  }
}

/**
 * 원장의 다섯 상태를 화면이 구별해야 하는 넷으로 접는다.
 *
 * `OK`인데 거부가 있었던 경우가 `limit_reached`다 — 원장은 정상이고 돈이 모자랐을 뿐이다.
 */
function classify(state: LedgerState, refusedWhileOk: boolean): TaskBudgetState {
  if (state !== "OK") return "blocked";
  return refusedWhileOk ? "limit_reached" : "ok";
}

/**
 * 이 호출이 낼 수 있는 **최대** 비용. 가격을 모르면 `null`이다.
 *
 * 입력 토큰은 컨텍스트 예산 상한을, 출력 토큰은 어댑터가 실제로 요청하는 값을 쓴다 —
 * 추정과 실제 요청이 **같은 상수**를 읽어야 예약이 실제 청구와 어긋나지 않는다.
 */
export function estimateCall(entry: ModelEntry | undefined): CostEstimate | null {
  if (!entry) return null;
  const maxOutputTokens = effectiveMaxOutputTokens(entry);
  const maxUsd = maxCallCostUsd(entry, {
    maxInputTokens: DEFAULT_CONTEXT_TOKEN_BUDGET,
    maxOutputTokens,
  });
  if (maxUsd === undefined) return null;
  return {
    maxUsd,
    basis: `${entry.modelId}: 입력 ≤${DEFAULT_CONTEXT_TOKEN_BUDGET} 토큰 × $${entry.economics.inputPerMTok}/MTok + 출력 ≤${maxOutputTokens} 토큰 × $${entry.economics.outputPerMTok}/MTok`,
  };
}

/** 부동소수 누적의 꼬리를 자른다 — 화면에 `0.30000000000000004`가 나가면 안 된다. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * 예산 때문에 호출하지 않았다는 신호.
 *
 * **공급자 오류 계층을 지나가지만 공급자 오류가 아니다.** `normalizeProviderError`는 모르는
 * 예외를 `transient`(재시도 불가)로 접으므로 재시도는 일어나지 않지만, 그 분류를 그대로
 * 보고하면 사용자는 키나 네트워크를 의심한다. 그래서 호출부가 거부 사실을 따로 기억하고
 * 그쪽을 먼저 본다 — 이 클래스는 스택 추적에서 원인이 읽히게 하는 역할이다.
 */
export class BudgetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetRefused";
  }
}
