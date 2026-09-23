import test from "node:test";
import assert from "node:assert/strict";
import type { TaskPhase } from "@tomverse/protocol";
import { isTerminalPhase } from "@tomverse/protocol";
import {
  canReachAnsweredThroughMutation,
  canReachCompletedWithoutVerifying,
  canReachThroughMutation,
  CHANGE_TERMINALS,
  MUTATING_PHASES,
  PHASES_BY_KIND,
  READ_ONLY_TERMINAL_KIND,
  transitionsFor,
  isValidTransition,
  READ_ONLY_TERMINALS,
  TRANSITIONS,
} from "../src/orchestrator/machine.js";
import { TERMINAL_PHASES } from "@tomverse/protocol";

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

/**
 * **읽기 전용 종착지는 전부 실행을 지나지 않는다** — state-machine 51·53절.
 *
 * 위 검사(`ANSWERED`)의 일반형이다. 53절이 두 번째 종착지를 만들면서, 같은 불변식을 손으로
 * 한 번 더 적을 뻔했다 — 두 벌이 되면 나중에 한쪽만 고쳐진다.
 */
test("읽기 전용 종착지에 도달하는 경로는 실행을 지나지 않는다", () => {
  assert.ok(READ_ONLY_TERMINALS.length >= 2, "목록이 하나뿐이면 이 일반화가 공허하다");
  for (const terminal of READ_ONLY_TERMINALS) {
    // **그 종착지가 속한 경로의 그래프에서 잰다**(72절). 72.2절이 `standard` 실행 경로에
    // `OUTLINING`을 재사용한 뒤로 종류를 모르는 그래프에는 실재하지 않는 경로가 생긴다:
    // `EXECUTING → … → AWAITING_USER_VERIFICATION → OUTLINING → OUTLINED`. 마지막 간선은
    // 계획 모드의 것이고 `standard` 태스크는 절대 그리로 가지 않는다.
    const kind = READ_ONLY_TERMINAL_KIND[terminal]!;
    assert.equal(
      canReachThroughMutation(terminal, kind),
      false,
      `${terminal}에 실행을 지나 도달할 수 있습니다 (${kind} 경로)`
    );
  }
  // **대조군.** 변경 종착지는 실행을 지나 도달할 수 있어야 한다 — 아니면 위 전칭 명제가
  // "아무 경로도 실행을 지나지 않는다"는 뜻이 되어 아무것도 지키지 않는다.
  assert.equal(canReachThroughMutation("COMPLETED"), true, "완료 경로가 실행을 지나지 않습니다");
});

/**
 * **경로를 나눈 것이 불변식을 약하게 만들지 않았다는 증거.**
 *
 * 종류별 그래프로 재면 "그 종류에서는 도달 불가"가 쉬워진다 — 극단적으로 모든 phase를
 * 각자의 종류에 가두면 전부 도달 불가가 되고 위 검사는 공허해진다. 그래서 두 가지를
 * 더 확인한다: 계획 경로에는 **파일을 바꾸는 phase가 하나도 없고**, 변경 경로에는
 * `OUTLINED`가 **아예 없다**(있는데 도달 못 하는 것이 아니다).
 */
test("계획 경로에는 변경 단계가 없고 변경 경로에는 계획 종착지가 없다", () => {
  const planPhases = new Set(PHASES_BY_KIND.plan);
  for (const phase of MUTATING_PHASES) {
    assert.ok(!planPhases.has(phase), `계획 경로에 ${phase}가 있습니다 — 파일을 바꾸지 않는다는 보장이 깨집니다`);
  }
  assert.ok(!PHASES_BY_KIND.change.includes("OUTLINED"), "변경 경로가 계획 종착지로 끝날 수 있습니다");
  // 그리고 **`OUTLINING`은 양쪽에 있어야 한다** — 한쪽에만 있으면 72.2절의 재사용이
  // 그래프에서 사라진 것이고, 위 검사는 그 사실을 모른 채 통과한다.
  assert.ok(PHASES_BY_KIND.change.includes("OUTLINING"));
  assert.ok(PHASES_BY_KIND.plan.includes("OUTLINING"));
});

/**
 * 종류별 목록이 `TaskPhase` 전체를 덮는가. 빠진 phase는 **어느 그래프에도 없으므로**
 * 위 불변식들이 그것에 대해 아무 말도 하지 않는다 — 그리고 검사는 통과한다.
 */
test("모든 phase가 적어도 한 종류의 경로에 속한다", () => {
  const covered = new Set([
    ...PHASES_BY_KIND.change,
    ...PHASES_BY_KIND.question,
    ...PHASES_BY_KIND.plan,
  ]);
  const missing = (Object.keys(TRANSITIONS) as TaskPhase[]).filter((p) => !covered.has(p));
  assert.deepEqual(missing, [], `어느 경로에도 속하지 않는 phase가 있습니다: ${missing.join(", ")}`);
});

/**
 * 72절 흐름의 다섯이 실제로 배선되어 있다 — 표에 값만 더하고 간선을 잇지 않으면
 * 그 phase는 **도달할 수 없는 채로** 존재한다.
 */
test("72절 흐름의 새 phase 다섯이 전부 도달 가능하고 전부 취소할 수 있다", () => {
  const reachable = new Set<TaskPhase>();
  const stack: TaskPhase[] = ["CREATED"];
  while (stack.length > 0) {
    const phase = stack.pop()!;
    if (reachable.has(phase)) continue;
    reachable.add(phase);
    for (const next of transitionsFor("change", phase)) stack.push(next);
  }
  for (const phase of [
    "AWAITING_PLAN_APPROVAL",
    "PLAN_REVIEWING",
    "IMPLEMENTING",
    "RESULT_REVIEWING",
    "AWAITING_USER_VERIFICATION",
  ] as TaskPhase[]) {
    assert.ok(reachable.has(phase), `${phase}에 도달할 수 없습니다`);
    // 72.11절: **두 사용자 게이트를 타임아웃 없이 기다리게 만든 뒤로** 자리를 뜬 사용자에게
    // 남는 탈출구는 취소뿐이다. "취소 가능한 모든 phase에서 들어온다"는 문장에만 의존하지
    // 않고 간선으로 확인한다.
    assert.ok(
      TRANSITIONS[phase].includes("CANCELLING"),
      `${phase}에서 취소할 수 없습니다 — 자리를 뜬 사용자에게 남는 탈출구가 없습니다`
    );
  }
});

/**
 * **C는 태스크를 실패시키지 못한다**(72.7절).
 *
 * `VERIFYING`이 통과했는데 C가 반대하면 그건 사용자에게 올라가는 쟁점이지 판정이 아니다.
 * `RESULT_REVIEWING → FAILED`가 생기면 모델 의견이 결정론적 검증을 뒤집을 수 있게 된다 —
 * `FAILED`가 간선에 있는 것 자체는 오류·취소 경로라 정상이므로, **`REJECTED`로 가는 간선이
 * 없다는 것**과 함께 본다.
 */
test("결과 검토는 태스크를 거부로 끝내지 못한다", () => {
  assert.ok(!TRANSITIONS.RESULT_REVIEWING.includes("REJECTED"), TRANSITIONS.RESULT_REVIEWING.join(", "));
  assert.ok(!TRANSITIONS.RESULT_REVIEWING.includes("COMPLETED"), "검토가 검증을 건너뛰고 완료시킵니다");
  assert.deepEqual([...TRANSITIONS.RESULT_REVIEWING].filter((p) => p === "AWAITING_USER_VERIFICATION"), [
    "AWAITING_USER_VERIFICATION",
  ]);
});

/** 원칙 1은 새 경로에서도 성립해야 한다 — 게이트 둘이 생겼다고 우회로가 열리면 안 된다. */
test("새 흐름에도 검증을 건너뛰고 완료하는 길이 없다", () => {
  assert.equal(canReachCompletedWithoutVerifying(), false);
});

/**
 * **새 종착지를 만들면 분류하기 전까지 실패한다.**
 *
 * `READ_ONLY_TERMINALS`는 손으로 적은 목록이고, 그래서 낡을 수 있다. 낡으면 그 경로에 대해
 * 위 불변식이 **아무 말도 하지 않으면서** 검사는 통과한다 — 51절이 `ANSWERED`를 만들 때
 * 화면 쪽 사본이 그렇게 낡았다(ui-wireframes 3.26.4절).
 */
test("모든 터미널 phase가 둘 중 하나로 분류돼 있다", () => {
  const classified = [...READ_ONLY_TERMINALS, ...CHANGE_TERMINALS].sort();
  assert.deepEqual(
    classified,
    [...TERMINAL_PHASES].sort(),
    "분류되지 않은 종착지가 있습니다 — 읽기 전용인지 변경 경로인지 정해야 합니다"
  );
  // 겹치면 안 된다 — 겹친 것은 위 전칭 명제와 대조군 양쪽에 들어가 서로 모순된다.
  assert.equal(new Set(classified).size, classified.length, "두 목록이 겹칩니다");
});

/** 계획 경로도 답변 경로와 같은 모양이다 — 갈라지면 한쪽만 보장을 잃는다. */
test("OUTLINING은 COMPLETED로도 EXECUTING으로도 가지 않는다", () => {
  assert.ok(!TRANSITIONS.OUTLINING.includes("COMPLETED"), TRANSITIONS.OUTLINING.join(", "));
  assert.ok(!TRANSITIONS.OUTLINING.includes("EXECUTING"), TRANSITIONS.OUTLINING.join(", "));
  assert.equal(isValidTransition("OUTLINING", "OUTLINED"), true);
  assert.equal(isValidTransition("SNAPSHOTTING", "OUTLINING"), true);
  assert.equal(canReachCompletedWithoutVerifying(), false);
});

/** 종전 이름이 일반형과 같은 답을 낸다 — 갈라지면 51절의 검사가 다른 것을 지키게 된다. */
test("canReachAnsweredThroughMutation은 일반형의 별칭이다", () => {
  assert.equal(canReachAnsweredThroughMutation(), canReachThroughMutation("ANSWERED"));
});
