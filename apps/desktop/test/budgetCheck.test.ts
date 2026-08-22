import test from "node:test";
import assert from "node:assert/strict";
import { precheckBudget } from "../src/lib/budgetCheck.js";

/**
 * 시작 전 예산 점검 — multi-engine-routing.md 10.6·15절.
 *
 * 상한이 한 호출의 최대 비용보다 작으면 첫 호출부터 거부된다. 그 사실을 **시작한 뒤 오류로**
 * 알리는 것과 **시작 전에** 알리는 것은 사용자에게 전혀 다른 일이다.
 */

const MODELS = [
  { modelId: "cheap", maxCallCostUsd: 0.2 },
  { modelId: "pricey", maxCallCostUsd: 2.1 },
  { modelId: "unpriced" },
];

test("상한이 없으면 점검할 것이 없다", () => {
  assert.deepEqual(precheckBudget({ budgetUsd: null, models: MODELS }), { certainRefusal: false });
});

/**
 * **자동일 때는 가장 싼 모델이 기준이다.** 그보다 상한이 작으면 어떤 선택으로도 첫 호출이
 * 거부되므로 그 경고는 추측이 아니라 사실이다.
 */
test("자동일 때 가장 싼 모델로도 못 부르면 확실한 거부다", () => {
  const result = precheckBudget({ budgetUsd: 0.1, models: MODELS });
  assert.equal(result.certainRefusal, true);
  assert.equal(result.requiredUsd, 0.2);
  assert.equal(result.basisModelId, "cheap");
});

/**
 * **비쌀 "수도 있다"고 경고하지 않는다.** 틀릴 수 있는 경고는 몇 번 지나면 읽히지 않고,
 * 그러면 맞는 경고도 함께 묻힌다.
 */
test("자동일 때 싼 모델로는 부를 수 있으면 경고하지 않는다", () => {
  // 비싼 모델($2.1)은 못 부르지만 라우터가 그걸 고른다는 보장이 없다.
  const result = precheckBudget({ budgetUsd: 0.5, models: MODELS });
  assert.equal(result.certainRefusal, false);
});

/** 지정하면 그 모델이 확정이므로, 비싼 모델을 골랐다면 그때는 확실히 말할 수 있다. */
test("지정한 모델이 상한을 넘으면 확실한 거부다", () => {
  const result = precheckBudget({ budgetUsd: 0.5, models: MODELS, pinExecutor: "pricey" });
  assert.equal(result.certainRefusal, true);
  assert.equal(result.requiredUsd, 2.1);
  assert.equal(result.basisModelId, "pricey", "어느 모델 때문인지 말해야 사용자가 고칠 수 있다");
});

/** 검수자만 지정한 경우도 같다 — 역할 중 **가장 비싼 단일 예약**이 기준이다. */
test("역할 중 가장 비싼 예약이 기준이다", () => {
  const result = precheckBudget({ budgetUsd: 1.0, models: MODELS, pinReviewer: "pricey" });
  assert.equal(result.certainRefusal, true);
  assert.equal(result.basisModelId, "pricey");
});

/**
 * **가격을 모르는 모델을 0으로 세지 않는다.** 0으로 세면 "가장 싼 모델"이 되어 어떤 상한도
 * 통과하게 되고, 이 점검이 아무것도 막지 못한다.
 */
test("가격을 모르는 모델은 기준이 되지 않는다", () => {
  const result = precheckBudget({ budgetUsd: 0.1, models: MODELS });
  assert.notEqual(result.basisModelId, "unpriced");
  // 가격 정보가 하나도 없으면 판단하지 않는다 — 모르는 것으로 경고하지 않는다.
  assert.deepEqual(precheckBudget({ budgetUsd: 0.01, models: [{ modelId: "unpriced" }] }), {
    certainRefusal: false,
  });
});

/** 경계값: 상한이 정확히 최대 비용과 같으면 예약된다(원장의 비교가 `>`이므로). */
test("상한이 최대 비용과 같으면 거부가 아니다", () => {
  const result = precheckBudget({ budgetUsd: 0.2, models: MODELS });
  assert.equal(result.certainRefusal, false);
});
