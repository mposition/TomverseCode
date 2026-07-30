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
 *
 * # 왜 정산이 이벤트 하나인가
 *
 * 예전에는 정산이 `reservation_settled` + `provider_usage_recorded` 두 이벤트였다. 그 사이에
 * 프로세스가 죽으면 "정산은 됐는데 usage는 모르는" 상태가 남고, 그건 어느 쪽을 믿어야 하는지
 * 알 수 없는 상태다. 이제 **비용·usage·응답 모델 ID를 `reservation_settled` 하나에 담는다** —
 * crash window를 이벤트 사이에서 없애는 것이 목적이다. `provider_usage_recorded`는 호환을 위해
 * 남아 있지만 비용의 정본이 아니다(아래 참조).
 *
 * # 비용의 정본은 `reservation_settled`다
 *
 * 한 예약의 확정 비용은 그 예약의 **terminal 이벤트**가 말한다. `records.jsonl`은 실험 기록이고
 * 파생물이다. 둘이 다르면 어느 쪽도 믿지 않고 멈춘다(`reconcileEvents`).
 */
export type BudgetEventType =
  | "approval_created"
  | "approval_raised"
  | "reservation_opened"
  | "reservation_released"
  | "reservation_settled"
  | "provider_usage_recorded"
  | "budget_estimate_breached"
  | "run_blocked"
  /** 과금 여부를 확정할 수 없는 채로 끝난 예약. **terminal이 아니다** — 사람이 확인해야 한다. */
  | "reservation_unresolved"
  /** 정산 값이 수치 검증을 통과하지 못했다. 이후 유료 호출을 차단한다. */
  | "budget_ledger_invalid";

/**
 * 이벤트 스키마 버전.
 *
 * 읽는 쪽이 **모르는 버전을 만나면 해석하지 않고 멈춘다.** 새 필드를 무시하고 계속하면
 * "그 필드에 담긴 비용을 못 본 채로 재개"가 가능해지고, 그건 이 원장이 막으려는 것과 같은 사고다.
 */
export const BUDGET_EVENT_VERSION = 2;

/** provider 요청이 실제로 나갔는가 — 과금 가능성을 판정하는 축 (§6). */
export type DispatchState =
  /** 요청을 보내지 않았다. 과금 없음이 확실하다. */
  | "not_dispatched"
  /** 보냈지만 응답을 받지 못했다. **과금 여부 불확실.** */
  | "dispatched_no_response"
  /** 응답을 받았고 usage가 있다. 실제 비용으로 정산할 수 있다. */
  | "response_received_with_usage"
  /** 응답을 받았지만 usage가 없다. **과금됐을 수 있으나 금액을 모른다.** */
  | "response_received_without_usage";

export interface BudgetEvent {
  /** 스키마 버전. 모르는 버전은 해석하지 않는다. */
  eventVersion: number;
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
  /** 정산 이벤트에 함께 담는 사용량. 이벤트 사이 crash window를 없애기 위한 것이다. */
  usage?: { inputTokens: number; outputTokens: number };
  /** 우리가 요청한 모델 ID. */
  requestedModelId?: string;
  /** **공급자 응답 envelope이 실어 온** 모델 ID. 조용한 대체를 사후에 감사할 근거다. */
  providerReportedModelId?: string;
  /** 공급자 요청 ID(제공되는 경우). 공급자 지원 문의에 쓸 수 있다. */
  providerRequestId?: string;
  dispatchState?: DispatchState;
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
  /**
   * 이전 실행에서 **미해결로 남은 예약액**.
   *
   * 열린 예약은 "쓰지 않은 돈"이 아니다 — 공급자가 요청을 처리하고 과금했을 수 있다.
   * 그래서 사용 가능한 예산으로 되돌리지 않고 상한에서 계속 빼둔다. 다만 이 원장은
   * 애초에 그 상태로 만들어지지 않는다(재개가 차단되므로) — 상태 조회 명령이 남은 예산을
   * 사람에게 보여줄 때 쓰는 경로다.
   */
  initialUnresolvedUsd?: number;
}

/** 이 호출/작업이 낼 수 있는 **최대** 비용과 그 근거. */
export interface CostEstimate {
  maxUsd: number;
  /** 사람이 읽는 산출 근거 — Run Card와 오류 메시지에 그대로 나간다. */
  basis: string;
}

/**
 * 측정된 값과 **측정하지 못한 값을 타입으로 구별한다** (§7).
 *
 * 예전에는 `settle(actualUsd: number)`였고, NaN·Infinity·음수를 0으로 바꿨다. 0은 "공짜"라는
 * 뜻이고 그건 fake에만 참이므로, 모르는 것을 0으로 적으면 예산 상한이 아무것도 막지 못한다.
 * 숫자 하나로는 "0달러였다"와 "모른다"를 구별할 수 없으니 타입을 나눈다.
 */
export type CostMeasurement =
  | { measured: true; usd: number }
  | { measured: false; reason: string };

export type UsageMeasurement =
  | { measured: true; inputTokens: number; outputTokens: number }
  | { measured: false; reason: string };

/** 정산에 필요한 사실 전부. 하나의 terminal 이벤트에 함께 들어간다. */
export interface Settlement {
  cost: CostMeasurement;
  usage: UsageMeasurement;
  /**
   * 실제 공급자였는가. `real`이면 입력·출력 토큰이 **둘 다 0인 것은 측정 실패로 본다** —
   * 실제 호출이 0 토큰을 쓰는 일은 없다. fake는 0이 정상이다.
   */
  providerKind: "real" | "fake";
  requestedModelId?: string;
  providerReportedModelId?: string;
  providerRequestId?: string;
  dispatchState?: DispatchState;
}

/** 원장이 더 이상 유료 호출을 허용하지 않는 상태들. */
export type LedgerState =
  | "OK"
  /** 실제 비용이 예약액을 초과했다 — 추정을 신뢰할 수 없다. */
  | "BUDGET_ESTIMATE_BREACH"
  /** 비용을 측정할 수 없었다. */
  | "COST_UNMEASURABLE"
  /** 정산 값이 수치 검증을 통과하지 못했다(NaN/Infinity/음수 등). */
  | "BUDGET_LEDGER_INVALID"
  /** 과금 여부가 불확실한 예약이 남았다. */
  | "UNRESOLVED_RESERVATION";

export type SettleOutcome =
  | { ok: true; committedUsd: number }
  | {
      ok: false;
      /** 이 실패로 원장이 들어간 상태. 이후 예약은 전부 거부된다. */
      state: LedgerState;
      reason: string;
    };

export interface Reservation {
  readonly id: string;
  readonly reservedUsd: number;
  /**
   * 실제 사용량이 확정됐을 때. 예약을 풀고 확정 비용을 누적한다.
   *
   * **수치 검증을 통과하지 못하면 예약을 풀지 않는다.** 조용히 0으로 정산하면 그 순간
   * 상한이 사라지므로, 예약을 열린 채로 남기고 원장을 차단 상태로 만든다 —
   * 그러면 재개도 막히고 사람이 확인하게 된다.
   */
  settle(settlement: Settlement): SettleOutcome;
  /**
   * 요청이 **나가지 않았을 때만** 예약을 해제한다.
   *
   * 인자로 `dispatchState: "not_dispatched"`를 요구하는 것이 요점이다 — 타입이 "보냈는데
   * 해제"를 막는다. 보낸 뒤의 실패는 과금 여부를 모르므로 `markUnresolved`다.
   */
  release(grounds: { dispatchState: "not_dispatched"; reason: string }): void;
  /**
   * 과금 여부를 확정할 수 없는 채로 끝났다. **예약을 풀지 않는다.**
   *
   * 공급자가 응답을 만들고 과금한 뒤 파싱이나 스키마 검증에서 실패했을 수 있다.
   * 그 경우 "해제"는 쓴 돈을 안 쓴 것으로 만드는 것이므로, 미해결로 남기고 멈춘다.
   */
  markUnresolved(grounds: { dispatchState: DispatchState; reason: string }): void;
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
      /** 원장이 차단 상태여서 거부된 경우 그 상태. */
      state?: LedgerState;
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
  /** 과금 여부가 불확실해 미해결로 남은 금액. 사용 가능한 예산으로 돌아오지 않는다. */
  unresolvedUsd(): number;
  /** 지금 새 호출에 쓸 수 있는 금액 = 상한 − historical − session − 예약 − 미해결. */
  availableUsd(): number;
  /** 원장 상태. `OK`가 아니면 새 예약을 받지 않는다. */
  state(): LedgerState;
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
  unresolvedUsd: number;
  availableUsd: number;
  state: LedgerState;
  estimateBreached: boolean;
  reservationsOpened: number;
  reservationsSettled: number;
  reservationsReleased: number;
  reservationsUnresolved: number;
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

/**
 * 정산 값의 수치 검증 (§7).
 *
 * 순수 함수로 떼어둔 이유: 이 판정이 틀리면 실제 돈이 새고, 그때 원장 인스턴스를 만들지 않고도
 * 경계값을 직접 확인할 수 있어야 한다.
 */
export function validateSettlement(
  settlement: Settlement
): { ok: true; usd: number; inputTokens: number; outputTokens: number } | { ok: false; reason: string } {
  if (!settlement.cost.measured) {
    return { ok: false, reason: `비용을 측정하지 못했습니다: ${settlement.cost.reason}` };
  }
  const usd = settlement.cost.usd;
  if (!Number.isFinite(usd)) {
    return { ok: false, reason: `실제 비용이 유한한 수가 아닙니다 (${usd})` };
  }
  if (usd < 0) {
    return { ok: false, reason: `실제 비용이 음수입니다 (${usd})` };
  }
  if (!settlement.usage.measured) {
    return { ok: false, reason: `사용량을 측정하지 못했습니다: ${settlement.usage.reason}` };
  }
  for (const [name, value] of [
    ["inputTokens", settlement.usage.inputTokens],
    ["outputTokens", settlement.usage.outputTokens],
  ] as const) {
    if (!Number.isFinite(value)) return { ok: false, reason: `${name}이 유한한 수가 아닙니다 (${value})` };
    if (value < 0) return { ok: false, reason: `${name}이 음수입니다 (${value})` };
  }
  if (
    settlement.providerKind === "real" &&
    settlement.usage.inputTokens === 0 &&
    settlement.usage.outputTokens === 0
  ) {
    // 실제 호출이 0 토큰을 쓰는 일은 없다. 이건 "공짜였다"가 아니라 "usage를 못 읽었다"다.
    return {
      ok: false,
      reason: "실제 공급자 응답인데 입력·출력 토큰이 모두 0입니다 — usage를 읽지 못한 것으로 봅니다",
    };
  }
  return {
    ok: true,
    usd,
    inputTokens: settlement.usage.inputTokens,
    outputTokens: settlement.usage.outputTokens,
  };
}

export function createBudgetLedger(approvedLimitUsd: number, options: LedgerOptions = {}): BudgetLedger {
  const check = validateApprovedLimit(approvedLimitUsd);
  if (!check.ok) throw new Error(check.reason);

  const historical = options.initialCommittedUsd ?? 0;
  const historicalCheck = validateInitialCommitted(historical);
  if (!historicalCheck.ok) throw new Error(historicalCheck.reason);

  const initialUnresolved = options.initialUnresolvedUsd ?? 0;
  const unresolvedCheck = validateInitialCommitted(initialUnresolved);
  if (!unresolvedCheck.ok) throw new Error(unresolvedCheck.reason);

  const runId = options.runId ?? "(unknown-run)";
  const stage = options.stage ?? "(unknown-stage)";
  const now = options.now ?? ((): string => new Date().toISOString());
  const emit = (
    event: Omit<BudgetEvent, "eventVersion" | "at" | "runId" | "stage" | "approvedLimitUsd" | "cumulativeUsd">
  ): void => {
    options.onEvent?.({
      ...event,
      eventVersion: BUDGET_EVENT_VERSION,
      at: now(),
      runId,
      stage,
      approvedLimitUsd,
      cumulativeUsd: historical + session,
    });
  };

  let session = 0;
  let reserved = 0;
  let unresolved = initialUnresolved;
  let opened = 0;
  let settledCount = 0;
  let releasedCount = 0;
  let unresolvedCount = 0;
  let ledgerState: LedgerState = initialUnresolved > 0 ? "UNRESOLVED_RESERVATION" : "OK";

  const available = (): number => approvedLimitUsd - historical - session - reserved - unresolved;

  emit({
    type: "approval_created",
    reason: `초기 승인 상한 $${approvedLimitUsd}, 복원된 누적 $${historical}, 미해결 $${initialUnresolved}`,
  });

  /** 원장을 차단 상태로 만들고 감사 이벤트를 남긴다. 되돌리지 않는다. */
  const block = (state: LedgerState, correlationId: string | undefined, reason: string): void => {
    ledgerState = state;
    emit({
      type: state === "BUDGET_LEDGER_INVALID" ? "budget_ledger_invalid" : "run_blocked",
      ...(correlationId !== undefined ? { correlationId } : {}),
      reason: `[${state}] ${reason}`,
    });
  };

  return {
    approvedLimitUsd,
    historicalCommittedUsd: () => historical,
    sessionCommittedUsd: () => session,
    cumulativeCommittedUsd: () => historical + session,
    reservedUsd: () => reserved,
    unresolvedUsd: () => unresolved,
    availableUsd: available,
    state: () => ledgerState,
    estimateBreached: () => ledgerState === "BUDGET_ESTIMATE_BREACH",

    reserve(estimate, label) {
      // **원장이 한 번 차단되면 더 이상 유료 호출을 시작하지 않는다.**
      if (ledgerState !== "OK") {
        const reason =
          `${label}: 원장이 ${ledgerState} 상태입니다 — ` +
          `이 상태에서 유료 호출을 계속하는 것은 예산 상한이 없는 것과 같습니다.`;
        emit({ type: "run_blocked", correlationId: label, reason });
        return { ok: false, reason, requestedUsd: estimate.maxUsd, availableUsd: available(), state: ledgerState };
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
          `이번 $${session.toFixed(4)}, 미해결 $${unresolved.toFixed(4)}). ${estimate.basis}`;
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
        settle(settlement: Settlement): SettleOutcome {
          if (done) throw new Error(`예약 ${id}이(가) 이미 정산되었습니다`);

          const validated = validateSettlement(settlement);
          if (!validated.ok) {
            // **예약을 풀지 않는다.** 0으로 정산하면 그 금액만큼 상한이 되살아나고,
            // 그건 실제로 과금됐을 수 있는 돈을 안 쓴 것으로 만드는 것이다.
            const state: LedgerState = settlement.cost.measured ? "BUDGET_LEDGER_INVALID" : "COST_UNMEASURABLE";
            emit({
              type: "reservation_unresolved",
              correlationId: id,
              reservedUsd: amount,
              reason: validated.reason,
              ...(settlement.dispatchState ? { dispatchState: settlement.dispatchState } : {}),
              ...(settlement.requestedModelId ? { requestedModelId: settlement.requestedModelId } : {}),
              ...(settlement.providerReportedModelId
                ? { providerReportedModelId: settlement.providerReportedModelId }
                : {}),
            });
            unresolved += amount;
            reserved -= amount;
            unresolvedCount += 1;
            done = true;
            block(state, id, validated.reason);
            return { ok: false, state, reason: validated.reason };
          }

          done = true;
          settledCount += 1;
          reserved -= amount;
          const actual = validated.usd;
          session += actual;
          // **비용·usage·응답 모델 ID가 한 이벤트에 함께 들어간다.** 두 이벤트로 나누면
          // 그 사이에 죽었을 때 어느 쪽을 믿어야 하는지 알 수 없다.
          emit({
            type: "reservation_settled",
            correlationId: id,
            reservedUsd: amount,
            actualUsd: actual,
            usage: { inputTokens: validated.inputTokens, outputTokens: validated.outputTokens },
            ...(settlement.requestedModelId ? { requestedModelId: settlement.requestedModelId } : {}),
            ...(settlement.providerReportedModelId
              ? { providerReportedModelId: settlement.providerReportedModelId }
              : {}),
            ...(settlement.providerRequestId ? { providerRequestId: settlement.providerRequestId } : {}),
            ...(settlement.dispatchState ? { dispatchState: settlement.dispatchState } : {}),
          });

          // **예약보다 실제가 크면 추정이 틀렸다는 뜻이다.** 조용히 넘기면 available이 음수인
          // 상태로 계속 돌 수 있고, 그건 승인 한도가 없는 것과 같다.
          if (actual > amount) {
            ledgerState = "BUDGET_ESTIMATE_BREACH";
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
          return { ok: true, committedUsd: historical + session };
        },
        release(grounds) {
          if (done) throw new Error(`예약 ${id}이(가) 이미 정산되었습니다`);
          done = true;
          releasedCount += 1;
          reserved -= amount;
          emit({
            type: "reservation_released",
            correlationId: id,
            reservedUsd: amount,
            reason: grounds.reason,
            dispatchState: grounds.dispatchState,
          });
        },
        markUnresolved(grounds) {
          if (done) throw new Error(`예약 ${id}이(가) 이미 정산되었습니다`);
          done = true;
          unresolvedCount += 1;
          reserved -= amount;
          unresolved += amount;
          emit({
            type: "reservation_unresolved",
            correlationId: id,
            reservedUsd: amount,
            reason: grounds.reason,
            dispatchState: grounds.dispatchState,
          });
          block("UNRESOLVED_RESERVATION", id, grounds.reason);
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
      unresolvedUsd: unresolved,
      availableUsd: available(),
      state: ledgerState,
      estimateBreached: ledgerState === "BUDGET_ESTIMATE_BREACH",
      reservationsOpened: opened,
      reservationsSettled: settledCount,
      reservationsReleased: releasedCount,
      reservationsUnresolved: unresolvedCount,
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
