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

/**
 * **이 파일의 수가 바뀐 것은 회귀가 아니라 정정이다** — state-machine 72.9절.
 *
 * 종전 테스트 이름은 *"verified는 실행자를 둘 부른다"*였고, 그 계약을 초록색으로 지키고
 * 있었다. 72절이 대조를 **계획 단계로** 옮기면서 둘이 되는 것이 실행자가 아니라 계획자가
 * 됐고, `fast`의 2도 함께 틀렸다(`fast`인데 TRIAGE가 `standard`로 분류하면 `REVIEWING`이
 * 아니라 72절 흐름 전체가 돈다).
 */
test("verified는 계획자를 둘 부른다 — 둘이 되는 것은 실행자가 아니다", () => {
  const plan = planFor("verified");
  assert.equal(plan.beforeApprovalMax, 3);
  assert.ok(plan.beforeApprovalParts.some((p) => p.includes("계획 2")), plan.beforeApprovalParts.join(" | "));
  assert.ok(!plan.beforeApprovalParts.some((p) => p.includes("실행자")), plan.beforeApprovalParts.join(" | "));
});

test("fast는 대조를 켜지 않지만 계획 검토는 받는다", () => {
  // 비용 2배는 사용자가 고르는 것이지 규칙이 고르는 것이 아니다(17.5절). 그러나 B·C는
  // 모드와 무관하게 사다리가 배정한다(21.6절) — 모드가 끄는 것은 대조 하나뿐이다.
  const plan = planFor("fast");
  assert.equal(plan.beforeApprovalMax, 2);
  assert.ok(!plan.beforeApprovalParts.some((p) => p.includes("계획 2")), plan.beforeApprovalParts.join(" | "));
  assert.ok(plan.beforeApprovalParts.some((p) => p.includes("계획 검토")), plan.beforeApprovalParts.join(" | "));
});

test("하한도 함께 말한다 — 라우터가 드롭하면 줄어든다", () => {
  // 상한만 적으면 언제나 그만큼 나가는 것처럼 읽히고, 하한만 적으면 비용이 작아 보인다.
  for (const mode of ["fast", "verified"] as const) {
    const plan = planFor(mode);
    assert.ok(
      plan.beforeApprovalMin >= 1 && plan.beforeApprovalMin < plan.beforeApprovalMax,
      `${mode}: ${JSON.stringify(plan)}`
    );
  }
});

/**
 * **승인 후 구간은 곱해 두지 않는다.**
 *
 * 서브태스크 개수는 계획이 정하므로 시작 시점에 알 수 없다. 여기서 개수를 지어내 곱하면
 * 화면이 정확해 보이는 만큼 정확히 틀리고, 실제 수는 **계획 승인 카드**가 보여준다(72.4절).
 */
test("서브태스크 개수를 지어내지 않는다 — 단위당 수만 적는다", () => {
  for (const mode of ["fast", "verified"] as const) {
    const plan = planFor(mode);
    assert.equal(plan.perSubtask, 1);
    assert.equal(plan.afterApprovalFixedMax, 1);
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
  // 승인 전 구간 / 승인 후 구간 / 상한으로 부를 수 있는 수 — 셋이다.
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.includes("최대 3회"), lines[0]);
  assert.ok(lines[1]!.includes("승인 카드"), lines[1]);
  assert.ok(lines[2]!.includes("최대 1회"), lines[2]);
  for (const line of lines) {
    for (const forbidden of ["모자랄", "멈출", "실패할", "부족할"]) {
      assert.ok(!line.includes(forbidden), `예측하는 문장이 들어왔습니다: ${line}`);
    }
  }
});

test("상한을 모르면 그 문장을 만들지 않는다", () => {
  // 모르면서 아는 척하는 문장을 만들지 않는다. 앞의 두 문장은 상한과 무관하게 참이다.
  assert.equal(describeCallPlan("fast", null, [{ modelId: "m", maxCallCostUsd: 0.2 }]).length, 2);
  assert.equal(describeCallPlan("fast", 1, [{ modelId: "m" }]).length, 2);
});

test("재시도와 수정 루프가 빠져 있다는 사실을 함께 말한다", () => {
  // 이 수를 총비용으로 읽으면 실제 청구가 몇 배가 될 수 있다.
  const lines = describeCallPlan("fast", null, []);
  assert.ok(lines.some((l) => l.includes("포함되지 않습니다")), lines.join(" | "));
});
