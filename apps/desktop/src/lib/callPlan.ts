/**
 * 실행 정책이 **몇 번 부르는가** — product-strategy.md 8.6절, ui-wireframes 3.11절.
 *
 * # 사용자가 고르는 것은 모드인데, 그 모드가 바꾸는 것은 대부분 비용이다
 *
 * 화면의 실행 정책은 "Fast — 쉬운 작업은 단일 모델" / "Verified — 항상 독립 검수"라고만
 * 적혀 있었다. 그런데 `verified`는 검수만 켜는 것이 아니라 **실행자를 하나 더 부른다**
 * (state-machine 17.5절 — 대조 게이팅의 축이 실행 모드다). 가장 비싼 결과가 이름에 없었다.
 *
 * 예산 점검(`budgetCheck.ts`)도 **한 호출**이 예약될 수 있는지만 봤다. 상한이 한 번은 되고 세
 * 번은 안 되는 값이면 태스크는 시작해서 돈을 쓰고 도중에 멈춘다 — 시작 전에 거부되는 것보다
 * 나쁜 결말이다.
 *
 * # 그래도 "멈출 수 있습니다"라고 말하지 않는다
 *
 * `budgetCheck.ts`가 정한 규율("확실할 때만 말한다")이 여기에도 걸린다. 라우터가 대조나 검수를
 * 드롭할 수 있고, tier가 갈리고, fix loop가 몇 번 돌지 모른다 — 그러므로 "예산이 모자랄
 * 겁니다"는 **틀릴 수 있는 경고**이고, 틀릴 수 있는 경고는 몇 번 지나면 맞는 경고까지 함께
 * 묻어버린다.
 *
 * 대신 **사실 두 개를 나란히 놓는다**: 이 모드가 한 라운드에 부르는 호출 수의 범위와, 지금
 * 상한으로 부를 수 있는 호출 수. 둘 다 산수이고 둘 다 참이다. 판단은 사용자가 한다 —
 * 큰 변경 안내(19.6절)에서 이미 쓴 규칙과 같다: **사실만 말하고 막지 않는다.**
 */

export type ExecutionMode = "fast" | "verified";

export interface CallPlan {
  /**
   * 한 라운드에 부르는 공급자 호출 수의 **상한**. 재시도와 fix loop는 빠져 있다 —
   * 그쪽은 몇 번 돌지 알 수 없고, 모르는 것을 더하면 이 수가 추정이 된다.
   */
  perRoundMax: number;
  /**
   * **하한.** 라우터가 독립 공급자를 찾지 못하면 대조와 검수가 드롭되어 여기까지 줄어든다
   * (multi-engine 13절). 하한만 적으면 비용이 작아 보이고, 상한만 적으면 언제나 그만큼
   * 나가는 것처럼 읽힌다.
   */
  perRoundMin: number;
  /** 상한이 무엇으로 이루어져 있는지 — 근거 없는 숫자는 사용자가 검증할 수 없다. */
  parts: string[];
}

/**
 * 모드가 만드는 호출 계획.
 *
 * `fast`의 상한이 2인 이유: TRIAGE가 `standard`로 분류하면 교차검증(실행자 1 + 검수자 1)이
 * 켜진다. **대조는 켜지지 않는다** — 비용 2배는 사용자가 고르는 것이지 규칙이 고르는 것이
 * 아니다(17.5절).
 */
export function planFor(mode: ExecutionMode): CallPlan {
  if (mode === "verified") {
    return {
      perRoundMax: 3,
      perRoundMin: 1,
      parts: ["실행자 2 (대조)", "검수자 1"],
    };
  }
  return {
    perRoundMax: 2,
    perRoundMin: 1,
    parts: ["실행자 1", "검수자 1 (규칙이 어렵다고 보면)"],
  };
}

export interface Affordability {
  /** 지금 상한으로 부를 수 있는 호출 수. 상한이 없거나 단가를 모르면 `null`이다. */
  calls: number | null;
  /** 그 수가 어느 모델 단가에서 나왔는지. */
  basisModelId?: string;
}

/**
 * 상한으로 몇 번 부를 수 있는가.
 *
 * **가장 싼 모델을 기준으로 잡는다.** 그러면 이 수는 **상한(최대로 이만큼)** 이 되고,
 * "이보다 많이 부를 수는 없다"는 확실한 사실이 된다. 가장 비싼 모델로 잡으면 하한이 되어
 * "적어도 이만큼은 된다"가 되는데, 사용자가 알고 싶은 것은 모자랄 위험 쪽이다.
 */
export function affordableCalls(
  budgetUsd: number | null,
  models: readonly { modelId: string; maxCallCostUsd?: number }[]
): Affordability {
  if (budgetUsd === null) return { calls: null };
  const priced = models.filter(
    (m): m is { modelId: string; maxCallCostUsd: number } => typeof m.maxCallCostUsd === "number" && m.maxCallCostUsd > 0
  );
  if (priced.length === 0) return { calls: null };
  const cheapest = priced.reduce((min, m) => (m.maxCallCostUsd < min.maxCallCostUsd ? m : min));
  return { calls: Math.floor(budgetUsd / cheapest.maxCallCostUsd), basisModelId: cheapest.modelId };
}

/**
 * 화면에 나가는 문장들. **경고가 아니라 사실 나열이다.**
 *
 * 두 번째 문장은 상한이 설정되고 단가를 아는 경우에만 나온다 — 모르면서 아는 척하지 않는다.
 */
export function describeCallPlan(
  mode: ExecutionMode,
  budgetUsd: number | null,
  models: readonly { modelId: string; maxCallCostUsd?: number }[]
): string[] {
  const plan = planFor(mode);
  const lines = [
    `한 라운드에 공급자를 최대 ${plan.perRoundMax}회 부릅니다 (${plan.parts.join(" + ")}). ` +
      `독립 공급자를 배정하지 못하면 ${plan.perRoundMin}회까지 줄어듭니다. 재시도와 수정 루프는 여기 포함되지 않습니다.`,
  ];
  const afford = affordableCalls(budgetUsd, models);
  if (afford.calls !== null) {
    lines.push(
      `지금 상한으로는 최대 ${afford.calls}회 부를 수 있습니다 (가장 싼 ${afford.basisModelId} 기준).`
    );
  }
  return lines;
}
