import test from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_TIER_STAGE_ORDER,
  phaseToStage,
  STAGE_ORDER,
  STANDARD_STAGE_ORDER,
  stagesFor,
  TERMINAL_PHASES,
  type TaskPhase,
} from "../src/types.js";

/**
 * `standard` 흐름의 화면 단계 — docs/design/state-machine-and-protocol.md 72.2.3절.
 *
 * # 여기서 막는 실패는 **아무 일도 일어나지 않은 것처럼 보인다**
 *
 * `phaseToStage`에 `default: return "완료"`가 있던 동안, 새 phase를 더하고 매핑을 잊으면
 * **컴파일이 통과하고 승인을 기다리는 태스크가 "완료"로 표시됐다.** 사용자가 승인해야
 * 진행되는 흐름에서 이보다 나쁜 오표시가 없고, 화면이 더 좋은 소식을 말하므로 **아무도
 * 신고하지 않는다.**
 */

/** 72절이 더한 phase 다섯. 이름을 여기 적어 두면 매핑이 빠졌을 때 어느 것인지 바로 보인다. */
const NEW_PHASES: TaskPhase[] = [
  "AWAITING_PLAN_APPROVAL",
  "PLAN_REVIEWING",
  "IMPLEMENTING",
  "RESULT_REVIEWING",
  "AWAITING_USER_VERIFICATION",
];

test("새 phase 다섯은 '완료'로 접히지 않는다", () => {
  for (const phase of NEW_PHASES) {
    const stage = phaseToStage(phase, "change", "standard");
    assert.notEqual(stage, "완료", `${phase}가 완료로 표시됩니다`);
  }
});

test("승인 대기 둘은 서로 다른 칸이다 — 같은 단어로 그리면 무엇을 승인하는지 사라진다", () => {
  // 도구 실행 승인과 계획 승인은 사용자가 답하는 질문이 완전히 다르다.
  assert.notEqual(
    phaseToStage("AWAITING_PLAN_APPROVAL", "change", "standard"),
    phaseToStage("AWAITING_APPROVAL", "change", "simple")
  );
});

test("최종 확인은 '확인 필요'가 아니다 — 모델이 막힌 것과 끝난 것은 다르다", () => {
  assert.notEqual(
    phaseToStage("AWAITING_USER_VERIFICATION", "change", "standard"),
    phaseToStage("AWAITING_USER_INPUT", "change", "standard")
  );
});

/**
 * **같은 phase가 경로마다 다른 단계**라는 사실이 `phaseToStage`의 시그니처가 바뀐 근거다.
 * 이 검사가 없으면 인자를 다시 하나로 줄여도 아무것도 실패하지 않는다.
 */
test("AWAITING_APPROVAL은 경로마다 다른 단계다", () => {
  assert.equal(phaseToStage("AWAITING_APPROVAL", "change", "standard"), "실행");
  assert.equal(phaseToStage("AWAITING_APPROVAL", "change", "simple"), "승인 대기");
});

test("standard에서 진행바는 실행에 머문다 — 서브태스크마다 앞뒤로 움직이지 않는다", () => {
  // 실행 구간 안에서 반복되는 phase들이 전부 같은 칸이어야 진행바가 깜빡이지 않는다.
  for (const phase of ["IMPLEMENTING", "PLANNING", "AWAITING_APPROVAL", "EXECUTING"] as const) {
    assert.equal(phaseToStage(phase, "change", "standard"), "실행", phase);
  }
});

test("standard 순서에는 같은 칸이 두 번 나오지 않는다 — 나오면 되돌아간 것으로 읽힌다", () => {
  assert.equal(new Set(STANDARD_STAGE_ORDER).size, STANDARD_STAGE_ORDER.length);
});

/** `change` 경로가 실제로 닿는 터미널. 질문·계획의 종착은 여기 없다(51·53절). */
const CHANGE_TERMINALS: TaskPhase[] = ["COMPLETED", "FAILED", "CANCELLED", "REJECTED", "INTERRUPTED"];

test("변경 경로의 터미널 목록이 정본에서 빠뜨린 것이 없다", () => {
  // 손으로 적은 목록은 정본이 늘 때 뒤처진다. 빠진 것이 **질문·계획의 종착 둘뿐**이라는
  // 사실을 검사가 확인하면, 새 터미널이 생겼을 때 여기가 먼저 빨개진다.
  const missing = TERMINAL_PHASES.filter((p) => !CHANGE_TERMINALS.includes(p));
  assert.deepEqual([...missing].sort(), ["ANSWERED", "OUTLINED"]);
});

test("standard가 지나는 모든 칸이 순서 목록에 있다", () => {
  // 매핑과 순서가 갈리면 진행바가 **목록에 없는 칸**을 가리키게 되고, 화면은 그때 아무것도
  // 강조하지 못한다 — 증상이 "진행바가 멈춘 것처럼 보인다"라 원인과 멀다.
  const order = new Set<string>(STANDARD_STAGE_ORDER);
  const flowPhases: TaskPhase[] = [
    "CREATED",
    "SNAPSHOTTING",
    "TRIAGE",
    "OUTLINING",
    ...NEW_PHASES,
    "PLANNING",
    "AWAITING_APPROVAL",
    "EXECUTING",
    "VERIFYING",
    "FIX_LOOP",
    // **변경 경로의 터미널만 넣는다.** `ANSWERED`·`OUTLINED`는 질문·계획 경로의 종착이고
    // `change` 태스크는 거기 닿지 않는다 — 넣으면 이 검사가 `STANDARD_STAGE_ORDER`에
    // **쓰이지 않는 칸을 요구하게** 된다. 그 목록의 정본은 `TERMINAL_PHASES`이므로
    // 여기서 빼는 것이 무엇인지도 함께 확인한다(아래).
    ...CHANGE_TERMINALS,
  ];
  for (const phase of flowPhases) {
    assert.ok(order.has(phaseToStage(phase, "change", "standard")), `${phase}의 단계가 순서에 없습니다`);
  }
});

/**
 * **tier는 TRIAGE가 끝나야 안다** — `stagesFor`가 빌려온 장치("`kind`가 정한다")의 전제가
 * 여기서 깨진다. 깨지지 않게 하는 사실은 **모든 순서가 `준비 중`으로 시작한다**는 것이다.
 */
test("tier를 모르는 동안에는 공통 접두사만 그린다", () => {
  assert.deepEqual(stagesFor("change", null), PENDING_TIER_STAGE_ORDER);
  // 그 접두사는 어느 순서를 골라도 같아야 한다 — 같지 않으면 화면이 틀린 것을 그리는
  // 구간이 생긴다.
  for (const order of [STAGE_ORDER, STANDARD_STAGE_ORDER]) {
    assert.deepEqual(order.slice(0, PENDING_TIER_STAGE_ORDER.length), PENDING_TIER_STAGE_ORDER);
  }
});

test("질문·계획 경로는 tier와 무관하게 시작 시점에 확정된다", () => {
  for (const tier of [null, "simple", "standard"] as const) {
    assert.deepEqual(stagesFor("question", tier), stagesFor("question", null));
    assert.deepEqual(stagesFor("plan", tier), stagesFor("plan", null));
  }
});

test("simple은 바뀌지 않는다 — 작은 수정에 승인 두 번을 요구하지 않는다", () => {
  assert.deepEqual(stagesFor("change", "simple"), STAGE_ORDER);
  assert.ok(!STAGE_ORDER.includes("계획 승인"));
  assert.ok(!STAGE_ORDER.includes("최종 확인"));
});

/**
 * **터미널 넷이 한 칸에 접혀 있다는 사실을 검사가 말한다.**
 *
 * `UserStage`에 `실패`가 없어서이고, 그 결정은 72절의 범위 밖이다. 그러나 `default`가
 * 그 사실을 가리고 있었으므로, 적어 두지 않으면 다음 사람이 이것을 **의도된 매핑**으로
 * 읽는다. 값이 생기는 날 이 검사가 함께 바뀐다.
 */
test("실패 계열은 아직 '완료'에 접혀 있다 — 화면이 답할 질문으로 남아 있다", () => {
  for (const phase of ["FAILED", "CANCELLED", "REJECTED", "INTERRUPTED"] as const) {
    assert.equal(phaseToStage(phase, "change", "standard"), "완료", phase);
  }
});
