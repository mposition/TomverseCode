import test from "node:test";
import assert from "node:assert/strict";
import { planView } from "../src/lib/planView.js";
import { phaseToStage, PLAN_STAGE_ORDER, stagesFor, TERMINAL_PHASES } from "../src/types.js";

function make(over: Partial<Parameters<typeof planView>[0] & object> = {}) {
  return {
    summary: "원장을 둘로 나눈다",
    steps: [{ intent: "인터페이스를 뽑는다", files: ["src/ledger.ts"] }],
    filesToChange: ["src/ledger.ts"],
    risks: [],
    openQuestions: [],
    model: "m",
    ...over,
  };
}

test("계획이 없으면 영역을 그리지 않는다", () => {
  assert.equal(planView(null).show, false);
});

/** 답변과 같은 규칙 — 변경용 배지 대신 무엇이 뒷받침하지 **않는지**를 말한다. */
test("계획에는 검증되지 않았다는 사실이 붙는다", () => {
  const view = planView(make());
  assert.match(view.caveat, /검증되지 않았습니다/);
  assert.match(view.caveat, /부분집합/);
});

/**
 * **`filesToChange`를 "바뀔 파일"로 그리지 않는다.** 아직 아무것도 바뀌지 않았고, 그 목록은
 * 모델이 부분집합을 보고 낸 **추정**이다(context-engine 15절).
 */
test("건드릴 파일 목록이 확정이 아니라고 말한다", () => {
  const view = planView(make());
  assert.match(view.filesNote, /확정이 아닙니다/);
  assert.ok(!view.filesNote.includes("바뀔 파일"), view.filesNote);
});

/** 파일을 대지 않았으면 **그 사실을 말한다** — 빈 목록을 숨기면 계획이 코드에 근거한다고 읽힌다. */
test("건드릴 파일이 없으면 그렇다고 말한다", () => {
  const view = planView(make({ filesToChange: [] }));
  assert.match(view.filesNote, /코드에 근거하지 않았을 수 있습니다/);
});

/** **침묵을 안심으로 바꾸지 않는다.** 위험을 말하지 않은 것과 위험이 없는 것은 다른 사실이다. */
test("위험을 밝히지 않은 것과 없는 것을 구별한다", () => {
  const quiet = planView(make());
  assert.equal(quiet.warn, false);
  assert.match(quiet.riskNote, /위험이 없다는 뜻은 아닙니다/);

  const spoke = planView(make({ risks: ["호출부가 더 있을 수 있다"] }));
  assert.equal(spoke.warn, true);
  assert.match(spoke.riskNote, /위험으로 밝혔습니다/);
});

/** 열린 질문만 있어도 경고 톤이어야 한다 — 정해지지 않은 계획은 그대로 실행할 수 없다. */
test("열린 질문만 있어도 경고한다", () => {
  assert.equal(planView(make({ openQuestions: ["기존 원장을 남길 것인가"] })).warn, true);
});

/**
 * **다음 걸음을 말한다.** 계획은 종착이지만 이야기의 끝이 아니다 — 53절이 답변과 계획을
 * 다른 종착지로 나눈 이유가 바로 이것이고, 화면이 그 걸음을 말하지 않으면 나눈 이유가
 * 화면에서 사라진다.
 *
 * **그리고 "이대로 실행" 버튼이 없다는 것도 말한다.** 승인한 계획과 실제로 적용되는 patch
 * 사이에 아무 보장이 없기 때문이다.
 */
test("계획 다음에 무엇을 하는지 말한다", () => {
  const view = planView(make());
  assert.match(view.nextStep, /새 작업/);
  assert.match(view.nextStep, /보장이 없기 때문/);
});

/** 단계에 번호가 붙는다 — 순서가 계획의 일부이므로 화면이 그것을 지워선 안 된다. */
test("단계에 순번이 붙는다", () => {
  const view = planView(
    make({
      steps: [
        { intent: "a", files: [] },
        { intent: "b", files: [] },
      ],
    })
  );
  assert.deepEqual(
    view.steps.map((s) => s.n),
    [1, 2]
  );
});

/** **"완료"라고도 "답변함"이라고도 쓰지 않는다** — 53절이 종착지를 나눈 이유가 여기서 사라진다. */
test("OUTLINED는 완료도 답변함도 아닌 단어로 표시된다", () => {
  assert.equal(phaseToStage("OUTLINED"), "계획 나옴");
  assert.notEqual(phaseToStage("OUTLINED"), "완료");
  assert.notEqual(phaseToStage("OUTLINED"), "답변함");
  assert.equal(phaseToStage("OUTLINING"), "계획");
});

/** 계획도 변경 경로의 단계를 빌리지 않는다 — 승인 대기·실행·검증에 갈 일이 없다. */
test("계획의 단계 목록에는 실행도 검증도 없다", () => {
  const stages = stagesFor("plan");
  assert.deepEqual(stages, PLAN_STAGE_ORDER);
  assert.ok(!stages.includes("실행"));
  assert.ok(!stages.includes("검증"));
  assert.ok(!stages.includes("승인 대기"));
  // 질문과도 다르다 — 같은 목록을 쓰면 화면이 둘을 같은 것으로 그린다.
  assert.notDeepEqual(stages, stagesFor("question"));
  assert.ok(stagesFor("change").includes("검증"));
});

/** 화면이 `OUTLINED`를 터미널로 알아야 한다 — 모르면 끝난 태스크를 "진행 중"으로 그린다. */
test("OUTLINED는 화면에서도 터미널이다", () => {
  assert.ok(TERMINAL_PHASES.includes("OUTLINED"));
});
