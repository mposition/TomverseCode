import test from "node:test";
import assert from "node:assert/strict";
import { affordableCalls, describeCallPlan, planFor } from "../src/lib/callPlan.js";

/**
 * 실행 정책의 비용을 화면이 말하는가 — product-strategy.md 8.6절.
 *
 * 여기서 검증하는 실패는 **아무 일도 일어나지 않은 것처럼 보인다**: 모드 이름이 비용을 말하지
 * 않아도 앱은 멀쩡히 돌고, 사용자는 자기가 무엇을 고른 줄 모른 채 3배를 쓴다. 청구서에서
 * 처음 알게 되는 종류의 실패다.
 */

test("verified는 실행자를 둘 부른다 — 그 사실이 계획에 있다", () => {
  const plan = planFor("verified");
  assert.equal(plan.perRoundMax, 3);
  assert.ok(plan.parts.some((p) => p.includes("실행자 2")), plan.parts.join(" | "));
});

test("fast는 대조를 켜지 않는다", () => {
  // 비용 2배는 사용자가 고르는 것이지 규칙이 고르는 것이 아니다(state-machine 17.5절).
  const plan = planFor("fast");
  assert.equal(plan.perRoundMax, 2);
  assert.ok(!plan.parts.some((p) => p.includes("실행자 2")), plan.parts.join(" | "));
});

test("하한도 함께 말한다 — 라우터가 드롭하면 줄어든다", () => {
  // 상한만 적으면 언제나 그만큼 나가는 것처럼 읽히고, 하한만 적으면 비용이 작아 보인다.
  for (const mode of ["fast", "verified"] as const) {
    const plan = planFor(mode);
    assert.ok(plan.perRoundMin >= 1 && plan.perRoundMin < plan.perRoundMax, `${mode}: ${JSON.stringify(plan)}`);
  }
});

// ---- 상한으로 몇 번 부를 수 있는가 ----

test("가장 싼 모델을 기준으로 잡는다 — 그래야 '이보다 많이는 못 부른다'가 참이다", () => {
  const afford = affordableCalls(1.0, [
    { modelId: "cheap", maxCallCostUsd: 0.2 },
    { modelId: "expensive", maxCallCostUsd: 0.5 },
  ]);
  assert.equal(afford.calls, 5);
  assert.equal(afford.basisModelId, "cheap");
});

test("상한이 없으면 아무 수도 말하지 않는다", () => {
  assert.equal(affordableCalls(null, [{ modelId: "m", maxCallCostUsd: 0.1 }]).calls, null);
});

test("단가를 모르면 0이 아니라 모른다고 한다", () => {
  // 0으로 두면 "무한히 부를 수 있다"가 되어 정확히 반대로 읽힌다.
  assert.equal(affordableCalls(1.0, [{ modelId: "m" }]).calls, null);
  assert.equal(affordableCalls(1.0, [{ modelId: "m", maxCallCostUsd: 0 }]).calls, null);
});

test("상한이 한 호출에도 못 미치면 0회라고 말한다", () => {
  assert.equal(affordableCalls(0.05, [{ modelId: "m", maxCallCostUsd: 0.2 }]).calls, 0);
});

// ---- 문장 ----

/**
 * **"모자랄 수 있습니다"라고 예측하지 않는다.** 라우터가 드롭할 수 있고 tier가 갈리고 fix
 * loop가 몇 번 돌지 모른다 — 틀릴 수 있는 경고는 몇 번 지나면 맞는 경고까지 함께 묻는다
 * (`budgetCheck.ts`가 정한 규율).
 */
test("사실만 나열하고 결과를 예측하지 않는다", () => {
  const lines = describeCallPlan("verified", 0.3, [{ modelId: "m", maxCallCostUsd: 0.2 }]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes("최대 3회"), lines[0]);
  assert.ok(lines[1]!.includes("최대 1회"), lines[1]);
  for (const line of lines) {
    for (const forbidden of ["모자랄", "멈출", "실패할", "부족할"]) {
      assert.ok(!line.includes(forbidden), `예측하는 문장이 들어왔습니다: ${line}`);
    }
  }
});

test("상한을 모르면 두 번째 문장을 만들지 않는다", () => {
  // 모르면서 아는 척하는 문장을 만들지 않는다.
  assert.equal(describeCallPlan("fast", null, [{ modelId: "m", maxCallCostUsd: 0.2 }]).length, 1);
  assert.equal(describeCallPlan("fast", 1, [{ modelId: "m" }]).length, 1);
});

test("재시도와 수정 루프가 빠져 있다는 사실을 함께 말한다", () => {
  // 이 수를 총비용으로 읽으면 실제 청구가 몇 배가 될 수 있다.
  const [first] = describeCallPlan("fast", null, []);
  assert.ok(first!.includes("포함되지 않습니다"), first);
});
