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
 * # 왜 sidecar(제품)에 있는가
 *
 * 측정 도구에만 두면 제품의 유료 호출 경로에는 같은 보호가 없게 된다. 사용자 돈을 쓰는 것은
 * 제품도 마찬가지이므로, 계약은 제품 쪽에 두고 가설 게이트가 그걸 **가져다 쓴다.**
 * 게이트는 (fixture, arm, 반복) 단위로, 제품은 provider 호출 단위로 예약한다 —
 * 같은 인터페이스로 둘 다 표현된다.
 *
 * # 병렬 실행
 *
 * 지금은 순차 실행만 지원하지만(protocol v1), `reserve()`가 **예약 시점에 즉시 차감**하므로
 * 나중에 동시 실행을 붙여도 double-spend가 생기지 않는다. 두 호출이 동시에 예약을 요청하면
 * 남은 예산이 부족한 쪽이 거부된다.
 */

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
  /** 정산이 끝난 실제 비용의 합. */
  committedUsd(): number;
  /** 진행 중인 호출을 위해 잡아둔 금액. */
  reservedUsd(): number;
  /** 지금 새 호출에 쓸 수 있는 금액 = 상한 − 확정 − 예약. */
  availableUsd(): number;
  /** 예약을 시도한다. 남은 금액이 부족하면 **호출하지 않는다**는 뜻의 실패를 돌려준다. */
  reserve(estimate: CostEstimate, label: string): ReserveOutcome;
  /** 지금까지의 지출 요약 — 리포트/Run Card용. */
  snapshot(): BudgetSnapshot;
}

export interface BudgetSnapshot {
  approvedLimitUsd: number;
  committedUsd: number;
  reservedUsd: number;
  availableUsd: number;
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

export function createBudgetLedger(approvedLimitUsd: number): BudgetLedger {
  const check = validateApprovedLimit(approvedLimitUsd);
  if (!check.ok) throw new Error(check.reason);

  let committed = 0;
  let reserved = 0;
  let opened = 0;
  let settledCount = 0;
  let releasedCount = 0;

  const available = (): number => approvedLimitUsd - committed - reserved;

  return {
    approvedLimitUsd,
    committedUsd: () => committed,
    reservedUsd: () => reserved,
    availableUsd: available,

    reserve(estimate, label) {
      if (!Number.isFinite(estimate.maxUsd) || estimate.maxUsd < 0) {
        // 비용을 계산할 수 없으면 **추측해서 진행하지 않는다.** 예산 상한이 아무것도 막지
        // 못하는 상태로 유료 호출을 시작하는 것이 이 ledger가 존재하는 이유와 정면으로 어긋난다.
        return {
          ok: false,
          reason: `${label}: 예상 비용을 계산할 수 없습니다 (${estimate.maxUsd}). ${estimate.basis}`,
          requestedUsd: Number.NaN,
          availableUsd: available(),
        };
      }
      if (estimate.maxUsd > available()) {
        return {
          ok: false,
          reason:
            `${label}: 예상 최대 비용 $${estimate.maxUsd.toFixed(4)}가 남은 예산 ` +
            `$${available().toFixed(4)}를 초과합니다 (승인 상한 $${approvedLimitUsd}). ${estimate.basis}`,
          requestedUsd: estimate.maxUsd,
          availableUsd: available(),
        };
      }

      reserved += estimate.maxUsd;
      opened += 1;
      const amount = estimate.maxUsd;
      let done = false;
      const reservation: Reservation = {
        id: `${label}#${opened}`,
        reservedUsd: amount,
        get settled() {
          return done;
        },
        settle(actualUsd: number) {
          if (done) throw new Error(`예약 ${this.id}이(가) 이미 정산되었습니다`);
          done = true;
          settledCount += 1;
          reserved -= amount;
          // 실제 비용이 예약보다 클 수 있다(추정이 틀린 경우). 그때도 **실제 값을 기록한다** —
          // 예약액으로 깎아 기록하면 장부가 실제 청구액과 어긋난다.
          committed += Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0;
        },
        release() {
          if (done) throw new Error(`예약 ${this.id}이(가) 이미 정산되었습니다`);
          done = true;
          releasedCount += 1;
          reserved -= amount;
        },
      };
      return { ok: true, reservation };
    },

    snapshot: () => ({
      approvedLimitUsd,
      committedUsd: committed,
      reservedUsd: reserved,
      availableUsd: available(),
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
