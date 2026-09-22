import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlanOutline, ValidationError } from "@tomverse/protocol";

/**
 * 계획이 **완료 기준과 실행 단위를 내는** 경로 — state-machine 72.2.1·72.2.2절.
 *
 * 72절 흐름에서 `DRAFTING`이 물러나면서 `doneCriteria`의 생산자가 사라졌고, 같은 구멍이
 * 하나 더 있었다 — patch를 만드는 자리도 없어졌다. 둘 다 `PlanOutline`이 메운다.
 */

const CTX = { taskId: "t1", model: "m", createdAt: "2026-09-22T00:00:00Z" };
const MINIMAL = {
  summary: "요약",
  steps: [{ intent: "1단계", files: ["a.ts"] }],
};

test("계획 모드는 서브태스크를 요구하지 않는다", () => {
  // 53절 경로는 실행으로 이어지지 않으므로 실행 단위가 필요 없고, **없는 것을 내게 하면
  // 그 모드가 아끼려는 토큰을 도로 쓴다.**
  const plan = validatePlanOutline(MINIMAL, CTX);
  assert.equal(plan.subtasks, undefined);
  assert.deepEqual(plan.doneCriteria, []);
});

test("standard 경로에서 빈 subtasks는 실패다", () => {
  // 53.5절이 빈 `steps`를 오류로 본 것과 같다: "계획했는데 할 일이 없다"는 답이 아니라 실패다.
  assert.throws(
    () => validatePlanOutline(MINIMAL, { ...CTX, requireSubtasks: true }),
    (e: unknown) => e instanceof ValidationError && /subtasks/.test(String(e.message ?? e))
  );
});

test("standard 경로는 maxSubtasks를 넘는 계획을 거부한다", () => {
  const many = {
    ...MINIMAL,
    subtasks: Array.from({ length: 9 }, (_, i) => ({
      subtaskId: `s${i}`,
      intent: `i${i}`,
      files: [],
      proposedGrade: "economy",
    })),
  };
  assert.throws(() => validatePlanOutline(many, { ...CTX, requireSubtasks: true, maxSubtasks: 8 }));
  // 상한 안이면 통과한다 — 상한이 아무것도 통과시키지 않으면 상한이 아니다.
  assert.equal(
    validatePlanOutline(
      { ...many, subtasks: many.subtasks.slice(0, 8) },
      { ...CTX, requireSubtasks: true, maxSubtasks: 8 }
    ).subtasks?.length,
    8
  );
});

/**
 * **상한이 없으면 검사하지 않는 것이 아니라 검사할 수 없다.** 여기서 기본값을 지어내면
 * 원칙 5의 "상한을 하드코딩하지 않는다"가 이 자리에서만 깨진다 — 상한의 정본은
 * `TaskLoopLimits`이고, 넘기는 것은 부르는 쪽의 책임이다.
 */
test("maxSubtasks를 넘기지 않으면 개수를 검사하지 않는다", () => {
  const many = {
    ...MINIMAL,
    subtasks: Array.from({ length: 50 }, (_, i) => ({ intent: `i${i}`, proposedGrade: "economy" })),
  };
  assert.equal(validatePlanOutline(many, { ...CTX, requireSubtasks: true }).subtasks?.length, 50);
});

/**
 * 모델이 새 등급 이름을 지어내면 clamp 계산이 그 값을 어느 쪽으로도 가두지 못한다.
 * **거부하지 않고 `unmeasured`로 읽는다** — 거부하면 계획 전체가 죽는데 그 손해는
 * "등급 하나를 모른다"보다 크고, 위험 하한선이 여전히 아래를 받친다(72.10절).
 */
test("모르는 등급은 계획을 죽이지 않고 unmeasured가 된다", () => {
  const plan = validatePlanOutline(
    { ...MINIMAL, subtasks: [{ intent: "i", proposedGrade: "super-frontier" }] },
    { ...CTX, requireSubtasks: true }
  );
  assert.equal(plan.subtasks?.[0]?.proposedGrade, "unmeasured");
  // id가 없으면 위치로 만든다 — 이벤트가 가리킬 키가 없으면 서브태스크별 기록이 성립하지 않는다.
  assert.equal(plan.subtasks?.[0]?.subtaskId, "subtask-1");
});

/**
 * `subtasks`는 `steps`가 아니다(72.2.2절). 둘이 같은 목록이라는 인상이 생기면
 * **서술을 실행 근거로 읽는 일**이 다시 시작된다 — 45.2절이 `toolHint`에 대해 막은 것이다.
 */
test("subtasks와 steps는 서로의 개수를 강제하지 않는다", () => {
  const plan = validatePlanOutline(
    {
      summary: "요약",
      steps: [
        { intent: "조사", files: [] },
        { intent: "수정", files: ["a.ts"] },
        { intent: "정리", files: [] },
      ],
      subtasks: [{ intent: "a.ts를 고친다", files: ["a.ts"], proposedGrade: "frontier" }],
    },
    { ...CTX, requireSubtasks: true }
  );
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.subtasks?.length, 1);
});
