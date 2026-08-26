import test from "node:test";
import assert from "node:assert/strict";
import { answerView } from "../src/lib/answerView.js";
import { phaseToStage, QUESTION_STAGE_ORDER, stagesFor, TERMINAL_PHASES } from "../src/types.js";

function make(over: Partial<Parameters<typeof answerView>[0] & object> = {}) {
  return { answer: "a는 1입니다.", citedFiles: ["src/app.ts"], missingContext: [], model: "m", ...over };
}

/** 묻지 않았으면 그리지 않는다 — 빈 카드는 "답이 없다"가 아니라 "도구가 깨졌다"로 읽힌다. */
test("답이 없으면 영역을 그리지 않는다", () => {
  assert.equal(answerView(null).show, false);
});

/**
 * **변경용 배지 대신 다른 문장을 붙인다** — state-machine 51.4절.
 *
 * `resultBasis`는 "이 **변경**을 무엇이 뒷받침하는가"에 답하는데 답변에는 변경이 없다.
 * 그 배지를 붙이면 "뒷받침하는 것이 없다"가 뜨고, 그 문장은 사실이지만 **사고처럼 읽힌다** —
 * 질문 경로에 판정자가 없는 것은 사고가 아니라 그 경로의 성질이다.
 */
test("답에는 검증되지 않았다는 사실이 붙는다", () => {
  const view = answerView(make());
  assert.match(view.caveat, /검증되지 않았습니다/);
  assert.match(view.caveat, /부분집합/);
});

/** **침묵을 안심으로 바꾸지 않는다.** 밝히지 않은 것과 없는 것은 다른 사실이다. */
test("모자란 것을 밝히지 않은 것과 없는 것을 구별한다", () => {
  const quiet = answerView(make());
  assert.equal(quiet.warn, false);
  assert.match(quiet.missingNote, /부족한 것이 없다는 뜻은 아닙니다/);

  const spoke = answerView(make({ missingContext: ["src/hidden.ts"] }));
  assert.equal(spoke.warn, true);
  assert.match(spoke.missingNote, /보지 못했다고 밝혔습니다/);
});

/** 기댄 파일이 없으면 **그 사실을 말한다.** 빈 목록을 숨기면 답이 코드에 근거한다고 읽힌다. */
test("기댄 파일이 없으면 그렇다고 말한다", () => {
  const view = answerView(make({ citedFiles: [] }));
  assert.match(view.citedNote, /코드에 근거하지 않았을 수 있습니다/);
});

/**
 * **"완료"라고 쓰지 않는다** — 51절이 종착지를 나눈 이유가 화면에서 사라지면 안 된다.
 *
 * 색만 다르게 하는 것으로는 부족하다: 같은 단어를 쓰면 사용자는 같은 것으로 읽고,
 * 색은 나중에 누군가 통일한다.
 */
test("ANSWERED는 완료가 아닌 단어로 표시된다", () => {
  assert.equal(phaseToStage("ANSWERED"), "답변함");
  assert.notEqual(phaseToStage("ANSWERED"), "완료");
  assert.equal(phaseToStage("ANSWERING"), "답변");
});

/**
 * **질문은 변경 경로의 단계를 빌리지 않는다.** 승인 대기·실행·검증을 회색으로 늘어놓으면
 * 화면이 "아직 거기까지 안 갔다"고 말하는 셈인데, 질문은 거기 갈 일이 없다.
 */
test("질문의 단계 목록에는 실행도 검증도 없다", () => {
  const stages = stagesFor("question");
  assert.deepEqual(stages, QUESTION_STAGE_ORDER);
  assert.ok(!stages.includes("실행"));
  assert.ok(!stages.includes("검증"));
  assert.ok(!stages.includes("승인 대기"));
  // 변경 경로는 그대로다.
  assert.ok(stagesFor("change").includes("검증"));
});

/** 화면이 `ANSWERED`를 터미널로 알아야 한다 — 모르면 끝난 태스크를 "진행 중"으로 그린다. */
test("ANSWERED는 화면에서도 터미널이다", () => {
  assert.ok(TERMINAL_PHASES.includes("ANSWERED"));
});
