import test from "node:test";
import assert from "node:assert/strict";
import type { TaskPhase } from "@tomverse/protocol";
import { isTerminalPhase } from "@tomverse/protocol";
import { canReachAnsweredThroughMutation, canReachCompletedWithoutVerifying, isValidTransition, TRANSITIONS } from "../src/orchestrator/machine.js";

test("문서 2절의 유효한 전이를 허용한다", () => {
  const valid: [TaskPhase, TaskPhase][] = [
    ["CREATED", "SNAPSHOTTING"],
    ["SNAPSHOTTING", "TRIAGE"],
    ["TRIAGE", "DRAFTING"],
    ["TRIAGE", "SINGLE_MODEL_FIX"],
    ["DRAFTING", "REVIEWING"],
    ["REVIEWING", "PLANNING"],
    ["REVIEWING", "REJECTED"],
    ["REVIEWING", "AWAITING_USER_INPUT"],
    ["SINGLE_MODEL_FIX", "PLANNING"],
    ["SINGLE_MODEL_FIX", "AWAITING_USER_INPUT"],
    ["SINGLE_MODEL_FIX", "REJECTED"],
    ["AWAITING_USER_INPUT", "DRAFTING"],
    ["PLANNING", "AWAITING_APPROVAL"],
    ["PLANNING", "EXECUTING"],
    ["AWAITING_APPROVAL", "EXECUTING"],
    ["EXECUTING", "EXECUTING"],
    ["EXECUTING", "VERIFYING"],
    ["VERIFYING", "COMPLETED"],
    ["VERIFYING", "FIX_LOOP"],
    ["FIX_LOOP", "PLANNING"],
    ["FIX_LOOP", "FAILED"],
  ];
  for (const [from, to] of valid) {
    assert.ok(isValidTransition(from, to), `${from} → ${to}는 허용되어야 합니다`);
  }
});

test("잘못된 전이를 거부한다", () => {
  const invalid: [TaskPhase, TaskPhase][] = [
    // VERIFYING을 건너뛰고 완료로 가려는 시도
    ["EXECUTING", "COMPLETED"],
    ["PLANNING", "COMPLETED"],
    ["TRIAGE", "COMPLETED"],
    // 승인을 건너뛰려는 시도
    ["AWAITING_APPROVAL", "VERIFYING"],
    // 사용자 답변 후 TRIAGE로 되돌아가 재분류하려는 시도 (14.1절이 금지한다)
    ["AWAITING_USER_INPUT", "TRIAGE"],
    ["AWAITING_USER_INPUT", "SINGLE_MODEL_FIX"],
    // 단계 건너뛰기
    ["CREATED", "EXECUTING"],
    ["SNAPSHOTTING", "DRAFTING"],
    // 터미널 상태에서 나가려는 시도
    ["COMPLETED", "EXECUTING"],
    ["FAILED", "PLANNING"],
    ["CANCELLED", "EXECUTING"],
    ["REJECTED", "DRAFTING"],
  ];
  for (const [from, to] of invalid) {
    assert.ok(!isValidTransition(from, to), `${from} → ${to}는 거부되어야 합니다`);
  }
});

test("VERIFYING을 우회해 COMPLETED에 도달할 수 없다", () => {
  // CLAUDE.md 원칙 1의 구조적 검증. 전이 표를 고칠 때 실수로 우회로가 생기면 여기서 실패한다.
  assert.equal(canReachCompletedWithoutVerifying(), false);
});

test("터미널 상태에는 나가는 전이가 없다", () => {
  for (const phase of ["COMPLETED", "FAILED", "CANCELLED", "REJECTED"] as TaskPhase[]) {
    assert.ok(isTerminalPhase(phase));
    assert.equal(TRANSITIONS[phase].length, 0, `${phase}는 터미널이어야 합니다`);
  }
});

test("모든 비터미널 상태에서 CANCELLED로 갈 수 있다", () => {
  // ui-wireframes.md 4절: "취소 버튼은 모든 비-터미널 phase에서 노출된다"
  for (const phase of Object.keys(TRANSITIONS) as TaskPhase[]) {
    if (isTerminalPhase(phase)) continue;
    assert.ok(
      TRANSITIONS[phase].includes("CANCELLED"),
      `${phase}에서 CANCELLED로 갈 수 없으면 UI의 취소 버튼이 거짓말이 됩니다`
    );
  }
});

test("모든 비터미널 상태에서 FAILED로 갈 수 있다", () => {
  // 실패를 표현할 수 없는 상태가 있으면 그 상태에서 발생한 오류를 숨기게 된다.
  for (const phase of Object.keys(TRANSITIONS) as TaskPhase[]) {
    if (isTerminalPhase(phase)) continue;
    assert.ok(TRANSITIONS[phase].includes("FAILED"), `${phase}에서 FAILED로 갈 수 없습니다`);
  }
});

/**
 * **답변 경로는 파일을 바꾸지 않는다** — state-machine 51절.
 *
 * `canReachCompletedWithoutVerifying`의 거울이다. 저쪽은 "검증 없이 완료할 수 없다"를 지키고
 * 이쪽은 "답변한다면서 실행하지 않는다"를 지킨다. 둘 다 전이 표에서 유도하므로, 나중에 표를
 * 고치다 우회로가 생기면 여기서 실패한다.
 */
test("ANSWERED에 도달하는 경로는 실행을 지나지 않는다", () => {
  assert.equal(canReachAnsweredThroughMutation(), false);
});

/**
 * **답변은 완료가 아니다.** `ANSWERING`에서 `COMPLETED`로 가는 길이 생기면 원칙 1의 구조적
 * 표현(`canReachCompletedWithoutVerifying`)에 우회로가 뚫린다.
 */
test("ANSWERING은 COMPLETED로 가지 않는다", () => {
  assert.ok(!TRANSITIONS.ANSWERING.includes("COMPLETED"), TRANSITIONS.ANSWERING.join(", "));
  assert.equal(isValidTransition("ANSWERING", "ANSWERED"), true);
  // 검증 없이 완료할 수 없다는 불변식은 답변 경로가 생겨도 그대로다.
  assert.equal(canReachCompletedWithoutVerifying(), false);
});

/** `ANSWERED`는 터미널이다 — 답한 뒤에 이어서 무언가 하지 않는다. */
test("ANSWERED는 터미널이다", () => {
  assert.equal(isTerminalPhase("ANSWERED" as TaskPhase), true);
  assert.deepEqual([...TRANSITIONS.ANSWERED], []);
});
