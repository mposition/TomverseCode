/**
 * 시작 전 예산 점검 — multi-engine-routing.md 10.6·15절, ui-wireframes 3.11절.
 *
 * # 무엇을 막는가
 *
 * 상한이 **한 호출의 최대 비용보다 작으면 첫 호출부터 거부된다.** 지금까지 그 사실은 시작한
 * 뒤에야 오류로 나왔다 — 스냅샷을 만들고 라우팅을 마친 뒤에. 두 값(모델 선택과 상한)을 같은
 * 화면에서 받고 있으므로, 시작하기 전에 말할 수 있다.
 *
 * # 확실할 때만 말한다
 *
 * "자동"으로 두면 라우터가 어느 모델을 고를지 화면은 모른다. 그래서 후보 중 **가장 싼** 모델을
 * 기준으로 잡는다 — 그보다 상한이 작으면 **어떤 선택으로도** 첫 호출이 거부되므로, 그때의
 * 경고는 추측이 아니라 사실이다. 반대로 "비쌀 수도 있습니다" 같은 경고는 하지 않는다:
 * 틀릴 수 있는 경고는 몇 번 지나면 읽히지 않고, 그러면 맞는 경고도 함께 묻힌다.
 *
 * # 계산은 여기서 하지 않는다
 *
 * 한 호출의 최대 비용은 **sidecar가 보내준 값을 그대로 쓴다**(`models.list`의
 * `maxCallCostUsd`). 화면이 같은 공식을 다시 구현하면 두 벌이 생기고, 그 순간 "예상"과 "실제로
 * 예약되는 금액"이 조용히 갈라진다 — 화면은 통과라고 말하는데 시작하면 거부되는 상태다.
 */

export interface ModelCost {
  modelId: string;
  /** 이 모델 한 번 호출의 최대 비용. **없으면 가격을 모르는 모델이다** (0이 아니다). */
  maxCallCostUsd?: number;
}

export interface BudgetPrecheck {
  /** 지금 상한으로는 **반드시** 첫 호출이 거부되는가. */
  certainRefusal: boolean;
  /** 최소한 이만큼은 있어야 한 번은 부를 수 있다. 판단 근거가 없으면 `undefined`. */
  requiredUsd?: number;
  /** 그 숫자가 어느 모델에서 왔는지 — 근거 없는 숫자는 사용자가 검증할 수 없다. */
  basisModelId?: string;
}

/**
 * 시작 전 점검.
 *
 * `budgetUsd`가 `null`이면 상한이 없으므로 거부될 일이 없다 — 점검할 것도 없다.
 */
export function precheckBudget(input: {
  budgetUsd: number | null;
  models: readonly ModelCost[];
  pinExecutor?: string;
  pinReviewer?: string;
}): BudgetPrecheck {
  if (input.budgetUsd === null) return { certainRefusal: false };

  const priced = input.models.filter(
    (m): m is ModelCost & { maxCallCostUsd: number } => typeof m.maxCallCostUsd === "number"
  );
  if (priced.length === 0) return { certainRefusal: false };

  const costOf = (modelId: string | undefined): (ModelCost & { maxCallCostUsd: number }) | undefined =>
    modelId ? priced.find((m) => m.modelId === modelId) : undefined;

  // 지정된 역할은 그 모델이 확정이고, 자동인 역할은 **가장 싼** 후보가 하한이다.
  const cheapest = priced.reduce((min, m) => (m.maxCallCostUsd < min.maxCallCostUsd ? m : min));
  const perRole = [costOf(input.pinExecutor) ?? cheapest, costOf(input.pinReviewer) ?? cheapest];

  // 한 호출이라도 예약되려면 **가장 비싼 단일 예약**을 덮을 수 있어야 한다.
  const required = perRole.reduce((max, m) => (m.maxCallCostUsd > max.maxCallCostUsd ? m : max));

  return {
    certainRefusal: input.budgetUsd < required.maxCallCostUsd,
    requiredUsd: required.maxCallCostUsd,
    basisModelId: required.modelId,
  };
}
