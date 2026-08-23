import test from "node:test";
import assert from "node:assert/strict";
import type { AcceptanceCriterion, VerificationReport } from "@tomverse/protocol";
import { evaluateCriteria, findCriteriaConflicts, describeEvaluations } from "../src/orchestrator/criteria.js";

/**
 * 기준이 실제로 참조되는 자리 — docs/design/state-machine-and-protocol.md 17.3절 규칙 1·2.
 *
 * 이 파일이 고정하는 것은 **확인이 좁다는 사실**이다. 확인을 넓게 잡는 변경이 들어오면 여기가
 * 깨져야 한다 — 넓힌 확인은 product-strategy 9절의 순환 의존으로 가는 첫 걸음이다.
 */

const FILES = ["src/validate.ts", "src/api/login.ts", "test/validate.test.ts", "package.json"];
const CONTEXT = { knownFiles: FILES };

function criterion(overrides: Partial<AcceptanceCriterion> & { text: string }): AcceptanceCriterion {
  return {
    criterionId: "c-1",
    source: "user_decision",
    decidedAt: new Date().toISOString(),
    ...overrides,
  };
}

function report(overrides: {
  status?: VerificationReport["checks"][number]["status"];
  detail?: string;
  omitTest?: boolean;
}): VerificationReport {
  return {
    taskId: "task-1",
    reportId: "r-1",
    phase: "post",
    attemptNumber: 0,
    checks: overrides.omitTest
      ? [{ kind: "build", status: "PASSED", summary: "ok" }]
      : [
          {
            kind: "test",
            status: overrides.status ?? "PASSED",
            summary: "tests done",
            detail: overrides.detail,
          },
        ],
    overall: "pass",
    createdAt: new Date().toISOString(),
  };
}

// ---- VERIFYING 체크리스트 ----

test("테스트를 지목하지 않은 기준은 미확인이고, 이유가 붙는다", () => {
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "오류 메시지를 한국어로 표시한다" })],
    report: report({}),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "UNVERIFIED");
  // 물음표가 결함처럼 보이지 않으려면 이유가 있어야 한다.
  assert.match(evaluations[0]!.reason, /자동으로 이을 수 없습니다/);
});

test("실행된 argv가 그 파일을 지목했으면 실행 근거로 인정한다", () => {
  // 러너가 그 파일을 인자로 받았다면 그 파일은 실행됐다 — 출력 형식과 무관한 가장 강한 근거다.
  const withCommand = report({ status: "PASSED", detail: "1..2\nok" });
  withCommand.checks[0]!.command = { program: "node", args: ["--test", "test/validate.test.ts"], cwd: "." };
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "빈 문자열을 거부한다 (test/validate.test.ts)" })],
    report: withCommand,
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "VERIFIED_BY_TEST");
});

test("확인 판정의 근거 문장은 과대 주장하지 않는다", () => {
  // "그 테스트가 이 기준을 확인했다"는 우리가 알 수 없는 사실이다. 아는 것은 "실행됐고 통과했다"뿐.
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "빈 문자열을 거부한다 (test/validate.test.ts)" })],
    report: report({ status: "PASSED", detail: "ok 1 - test/validate.test.ts" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "VERIFIED_BY_TEST");
  assert.match(evaluations[0]!.reason, /확인했다는 뜻이 아니라/);
});

test("지목한 테스트가 실행됐고 통과했을 때만 확인으로 판정한다", () => {
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "빈 문자열 이메일을 거부한다 (test/validate.test.ts:41)" })],
    report: report({ status: "PASSED", detail: "ok 1 - test/validate.test.ts > rejects empty" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "VERIFIED_BY_TEST");
  assert.deepEqual(evaluations[0]!.evidence, ["test/validate.test.ts"]);
});

test("test가 통과해도 그 파일이 실행된 근거가 없으면 미확인이다 (fail-closed)", () => {
  // 러너가 그 파일을 포함하지 않았을 수 있다. 그러면 "통과"는 이 기준과 아무 상관이 없다.
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "빈 문자열을 거부한다 (test/validate.test.ts)" })],
    report: report({ status: "PASSED", detail: "ok 1 - some/other.test.ts > unrelated" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "UNVERIFIED");
  assert.match(evaluations[0]!.reason, /실행된 근거를 찾지 못했습니다/);
});

test("아는 목록에도 검증 출력에도 없는 테스트 파일은 근거가 되지 못한다", () => {
  // 모델도 사용자도 없는 파일 이름을 적을 수 있다. 그걸 근거로 쓰면 근거 자체가 허구다.
  //
  // **종전 fixture는 자기모순이었다**: 파일이 없다고 주장하면서 러너 출력에는
  // `ok 1 - imaginary.test.ts`를 넣어두고 있었다. 러너가 실행했다면 그 파일은 실재한다 —
  // 그래서 그 fixture가 재던 것은 "지어낸 이름을 거부한다"가 아니라 "실행 증거를 무시한다"였다.
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "확인은 imaginary.test.ts 로 한다" })],
    report: report({ status: "PASSED", detail: "ok 1 - test/validate.test.ts" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "UNVERIFIED");
  // **"이름이 없었다"와 구별된다.** 고쳐야 할 곳이 다르므로 집계에서 뭉치면 안 된다.
  assert.equal(evaluations[0]!.code, "test_reference_unresolved");
  // 그리고 **없다고 단언하지 않는다** — 우리가 아는 목록은 워크스페이스 전부가 아니다.
  assert.ok(!evaluations[0]!.reason.includes("워크스페이스에 없"), evaluations[0]!.reason);
});

/**
 * 17.9.1절 — 잇지 못한 이유의 상당수는 "이을 수 없어서"가 아니라 **실재 판정이 틀려서**였다.
 *
 * 아래 셋은 종전 규칙에서 전부 미확인이었다. 셋 다 파일이 실재하고 테스트가 통과했는데도.
 */
test("스냅샷이 예산에 밀려 뺀 테스트도 실재 근거가 된다", () => {
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "test/dropped.test.ts 로 확인한다" })],
    report: report({ status: "PASSED", detail: "ok 1 - test/dropped.test.ts" }),
    changedPaths: ["src/validate.ts"],
    // 스냅샷의 relevantFiles에는 없지만 인덱스가 본 파일. 종전에는 이것이 "없는 파일"이었다.
    context: { knownFiles: [...FILES, "test/dropped.test.ts"] },
  });
  assert.equal(evaluations[0]!.status, "VERIFIED_BY_TEST");
});

test("이번 변경이 새로 만든 테스트도 실재 근거가 된다", () => {
  // 스냅샷은 패치 이전에 찍히므로 새 테스트는 거기 없다. **가장 확인되기 쉬운 경우가
  // 구조적으로 확인 불가**였다 — 새 테스트를 쓰고 그것이 통과한 경우.
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "test/new.test.ts 가 통과한다" })],
    report: report({ status: "PASSED", detail: "ok 1 - test/new.test.ts" }),
    changedPaths: ["src/validate.ts", "test/new.test.ts"],
    context: { knownFiles: [...FILES, "test/new.test.ts"] },
  });
  assert.equal(evaluations[0]!.status, "VERIFIED_BY_TEST");
});

test("러너가 실행한 파일은 아는 목록에 없어도 실재 근거가 된다", () => {
  // 러너의 argv/출력에 나타났다면 그 파일은 실재하고 실행됐다. 이건 스냅샷 목록보다
  // **강한** 근거이므로, 목록에 없다는 이유로 떨어뜨리면 근거를 들고 와서 버리는 것이다.
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "test/unlisted.test.ts 로 확인" })],
    report: report({ status: "PASSED", detail: "ok 1 - test/unlisted.test.ts" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT, // 목록에 없다
  });
  assert.equal(evaluations[0]!.status, "VERIFIED_BY_TEST");
  assert.deepEqual(evaluations[0]!.evidence, ["test/unlisted.test.ts"]);
});

test("접미사 대조는 경계를 지킨다 — e.test.ts가 validate.test.ts로 세어지지 않는다", () => {
  // 단순 endsWith를 쓰면 `validate.test.ts`가 `e.test.ts`로 끝나므로 서로 다른 파일이
  // 같은 것으로 세어진다. 그러면 러너가 실제로 돌린 `e.test.ts`가 근거에서 빠진다.
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "e.test.ts 로 확인" })],
    report: report({ status: "PASSED", detail: "ok 1 - e.test.ts" }),
    changedPaths: ["src/validate.ts"],
    context: { knownFiles: ["test/validate.test.ts"] },
  });
  assert.equal(evaluations[0]!.status, "VERIFIED_BY_TEST");
  assert.deepEqual(evaluations[0]!.evidence, ["e.test.ts"]);
});

test("러너가 언급하지 않으면 넓히지 않는다 — 이름만으로는 확인이 되지 않는다", () => {
  // 위 세 테스트가 규칙을 넓힌 것으로 읽히지 않도록 반대편을 고정한다. 실행 근거가 없으면
  // 파일이 실재해도 미확인이다(fail-closed).
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "test/validate.test.ts 로 확인" })],
    report: report({ status: "PASSED", detail: "ok 1 - something-else" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "UNVERIFIED");
  assert.equal(evaluations[0]!.code, "no_run_evidence");
});

test("미확인 사유는 코드로 구별된다 (집계가 한국어 문장을 파싱하지 않도록)", () => {
  const cases: { text: string; report: VerificationReport | null; code: string }[] = [
    { text: "오류 메시지를 한국어로 표시한다", report: report({}), code: "no_test_reference" },
    { text: "확인은 imaginary.test.ts 로", report: report({}), code: "test_reference_unresolved" },
    // 리포트가 없으면 러너 근거도 없다 — 없는 것을 근거로 채택하지 않는다.
    { text: "확인은 imaginary.test.ts 로", report: null, code: "test_reference_unresolved" },
    {
      text: "test/validate.test.ts 로 확인",
      report: report({ status: "PASSED", detail: "ok 1 - unrelated" }),
      code: "no_run_evidence",
    },
    { text: "test/validate.test.ts 로 확인", report: report({ status: "NOT_CONFIGURED" }), code: "test_not_configured" },
    { text: "test/validate.test.ts 로 확인", report: report({ omitTest: true }), code: "test_check_missing" },
    { text: "test/validate.test.ts 로 확인", report: null, code: "no_verification_report" },
  ];
  for (const c of cases) {
    const [evaluation] = evaluateCriteria({
      criteria: [criterion({ text: c.text })],
      report: c.report,
      changedPaths: [],
      context: CONTEXT,
    });
    assert.equal(evaluation!.code, c.code, `${c.text} → ${evaluation!.code} (기대: ${c.code})`);
  }
});

test("지목한 테스트를 포함한 검증이 실패하면 반증으로 판정한다", () => {
  // 실패를 미확인으로 뭉개면 실패가 침묵으로 보인다.
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "빈 문자열을 거부한다 (test/validate.test.ts)" })],
    report: report({ status: "FAILED", detail: "not ok 1 - test/validate.test.ts" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "CONTRADICTED_BY_TEST");
});

test("테스트 명령이 없으면 확인도 반증도 아니다", () => {
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "빈 문자열을 거부한다 (test/validate.test.ts)" })],
    report: report({ status: "NOT_CONFIGURED" }),
    changedPaths: ["src/validate.ts"],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "UNVERIFIED");
  assert.match(evaluations[0]!.reason, /테스트 명령이 없어/);
});

test("검증 리포트가 없으면 전부 미확인이다", () => {
  const evaluations = evaluateCriteria({
    criteria: [criterion({ text: "빈 문자열을 거부한다 (test/validate.test.ts)" })],
    report: null,
    changedPaths: [],
    context: CONTEXT,
  });
  assert.equal(evaluations[0]!.status, "UNVERIFIED");
});

test("기준마다 판정이 정확히 하나씩 나온다", () => {
  // 빠뜨리면 화면에서 그 기준이 사라지고, 사라진 기준은 "충족했다"로 읽힌다.
  const criteria = [
    criterion({ criterionId: "a", text: "A" }),
    criterion({ criterionId: "b", text: "B" }),
    criterion({ criterionId: "c", text: "C" }),
  ];
  const evaluations = evaluateCriteria({ criteria, report: report({}), changedPaths: [], context: CONTEXT });
  assert.deepEqual(
    evaluations.map((e) => e.criterionId),
    ["a", "b", "c"]
  );
});

// ---- PLANNING 게이트 ----

test("사용자가 지목한 파일을 하나도 건드리지 않으면 충돌이다", () => {
  const conflicts = findCriteriaConflicts(
    [criterion({ text: "src/validate.ts 를 고쳐주세요" })],
    ["src/api/login.ts"],
    CONTEXT
  );
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]!.expectedPaths, ["src/validate.ts"]);
});

test("겹치는 파일이 하나라도 있으면 충돌이 아니다", () => {
  // 범위 차이를 충돌로 부르면 정상 작업이 매번 막힌다.
  const conflicts = findCriteriaConflicts(
    [criterion({ text: "src/validate.ts 를 고쳐주세요" })],
    ["src/validate.ts", "src/api/login.ts"],
    CONTEXT
  );
  assert.deepEqual(conflicts, []);
});

test("모델이 제안한 기준은 충돌 판정 대상이 아니다", () => {
  // 모델 제안은 사용자가 뒤집을 수 있는 후보다 — 그걸로 계획을 막으면 권위가 뒤바뀐다.
  const conflicts = findCriteriaConflicts(
    [criterion({ source: "draft_proposal", text: "src/validate.ts 를 고친다" })],
    ["src/api/login.ts"],
    CONTEXT
  );
  assert.deepEqual(conflicts, []);
});

test("실재하지 않는 경로를 지목한 기준은 충돌을 만들지 않는다", () => {
  const conflicts = findCriteriaConflicts(
    [criterion({ text: "src/nonexistent.ts 를 고쳐주세요" })],
    ["src/api/login.ts"],
    CONTEXT
  );
  assert.deepEqual(conflicts, []);
});

test("경로를 지목하지 않은 기준은 충돌을 만들지 않는다", () => {
  // 자유 문장의 충족 여부는 여기서 판정할 수 없다 — 판정하려면 모델을 불러야 한다.
  const conflicts = findCriteriaConflicts(
    [criterion({ text: "빈 문자열 이메일을 거부한다" })],
    ["src/api/login.ts"],
    CONTEXT
  );
  assert.deepEqual(conflicts, []);
});

test("변경이 없으면 충돌을 판정하지 않는다", () => {
  const conflicts = findCriteriaConflicts([criterion({ text: "src/validate.ts 를 고쳐주세요" })], [], CONTEXT);
  assert.deepEqual(conflicts, []);
});

test("경로 구분자와 대소문자 차이는 충돌이 아니다", () => {
  const conflicts = findCriteriaConflicts(
    [criterion({ text: "src\\Validate.TS 를 고쳐주세요" })],
    ["src/validate.ts"],
    CONTEXT
  );
  assert.deepEqual(conflicts, []);
});

// ---- 요약 문장 ----

test("요약은 상태별 개수를 뭉치지 않는다", () => {
  const line = describeEvaluations([
    { criterionId: "a", status: "VERIFIED_BY_TEST", code: "verified_named_test_ran", reason: "" },
    { criterionId: "b", status: "UNVERIFIED", code: "no_test_reference", reason: "" },
    { criterionId: "c", status: "CONTRADICTED_BY_TEST", code: "named_test_check_failed", reason: "" },
  ]);
  assert.match(line!, /테스트로 확인 1개/);
  assert.match(line!, /테스트가 반증 1개/);
  assert.match(line!, /미확인 1개/);
});

test("확인이 0개여도 그 사실을 말한다", () => {
  const line = describeEvaluations([{ criterionId: "a", status: "UNVERIFIED", code: "no_test_reference", reason: "" }]);
  assert.match(line!, /테스트로 확인 0개/);
});
