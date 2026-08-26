import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@tomverse/protocol";
import {
  buildCommitPlan,
  buildExecutionPlan,
  NON_PATH_ARGS,
  PATH_ARGS,
  planPaths,
  PlanningError,
  splitDiffByFile,
} from "../src/orchestrator/planner.js";
import { buildDigest, extractFileReferences } from "../src/verify/digest.js";

const requestedBy = { role: "executor" as const, modelId: "fake-executor" };

test("파일별로 patch를 쪼갠다", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -5,1 +5,1 @@",
    "-const b = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  const chunks = splitDiffByFile(patch);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.path, "src/a.ts");
  assert.equal(chunks[1]!.path, "src/b.ts");
  // 각 조각에 자기 hunk만 들어 있어야 한다.
  assert.ok(chunks[0]!.patch.includes("const a = 2"));
  assert.ok(!chunks[0]!.patch.includes("const b"));
});

test("파일마다 별도 ToolRequest를 만든다", () => {
  // 파일 하나당 요청 하나여야 Policy Gate가 경로별로 판단하고 롤백이 파일별로 정확해진다.
  const patch = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-1",
    "+2",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,1 +1,1 @@",
    "-3",
    "+4",
    "",
  ].join("\n");

  const plan = buildExecutionPlan({ taskId: "task-1", patch, requestedBy, attempt: 0 });
  assert.equal(plan.toolRequests.length, 2);
  assert.deepEqual(
    plan.toolRequests.map((r) => r.args.path),
    ["src/a.ts", "src/b.ts"]
  );
  assert.ok(plan.toolRequests.every((r) => r.tool === "apply_patch"));
  assert.equal(plan.approvalRequired, true);
});

test("파일 헤더가 없는 patch는 대상을 추측하지 않고 실패한다", () => {
  assert.throws(() => splitDiffByFile("@@ -1,1 +1,1 @@\n-a\n+b\n"), PlanningError);
});

test("적용할 hunk가 없으면 조용히 성공하지 않는다", () => {
  assert.throws(
    () => buildExecutionPlan({ taskId: "t", patch: "--- a/x\n+++ b/x\n", requestedBy, attempt: 0 }),
    PlanningError
  );
  assert.throws(() => buildExecutionPlan({ taskId: "t", patch: "", requestedBy, attempt: 0 }), PlanningError);
});

test("workspace를 벗어나는 경로는 계획 단계에서 거부한다", () => {
  const patch = ["--- a/../../etc/passwd", "+++ b/../../etc/passwd", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n");
  assert.throws(() => buildExecutionPlan({ taskId: "t", patch, requestedBy, attempt: 0 }), ValidationError);
});

test("절대경로도 계획 단계에서 거부한다", () => {
  const patch = ["--- a//etc/passwd", "+++ /etc/passwd", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n");
  assert.throws(() => buildExecutionPlan({ taskId: "t", patch, requestedBy, attempt: 0 }), ValidationError);
});

test("삭제 요청은 별도 도구로 계획한다", () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  const plan = buildExecutionPlan({
    taskId: "t",
    patch,
    requestedBy,
    attempt: 0,
    deletions: ["src/old.ts"],
  });
  const del = plan.toolRequests.find((r) => r.tool === "delete_file")!;
  assert.equal(del.args.path, "src/old.ts");
  assert.equal(del.riskTier, "user_approval");
});

test("planId는 시도 횟수를 반영한다", () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  const first = buildExecutionPlan({ taskId: "t", patch, requestedBy, attempt: 0 });
  const second = buildExecutionPlan({ taskId: "t", patch, requestedBy, attempt: 1 });
  assert.notEqual(first.planId, second.planId);
  assert.notEqual(first.toolRequests[0]!.requestId, second.toolRequests[0]!.requestId);
});

// ---- Verification digest ----

test("다이제스트는 실패한 체크만 상세히 담는다", () => {
  const digest = buildDigest({
    taskId: "t",
    reportId: "r",
    phase: "post",
    attemptNumber: 1,
    overall: "fail",
    createdAt: "now",
    checks: [
      { kind: "build", status: "PASSED", summary: "build ok" },
      { kind: "test", status: "FAILED", summary: "2 failed", detail: "AssertionError at src/app.ts:12:3" },
      { kind: "lint", status: "NOT_CONFIGURED", summary: "없음" },
    ],
  });

  assert.equal(digest.failingChecks.length, 1);
  assert.equal(digest.failingChecks[0]!.kind, "test");
  assert.ok(digest.failingChecks[0]!.excerpt.includes("AssertionError"));
  // NOT_CONFIGURED를 "통과"로 표현하지 않는다.
  assert.ok(digest.passingChecksSummary.includes("build: pass"));
  assert.ok(digest.passingChecksSummary.includes("lint: not configured"));
});

test("다이제스트는 새로 깨진 체크를 먼저 두고 pre-existing도 함께 전달한다", () => {
  const digest = buildDigest({
    taskId: "t",
    reportId: "r",
    phase: "post",
    attemptNumber: 1,
    overall: "fail",
    preexistingFailures: ["lint"],
    newlyFailing: ["test"],
    createdAt: "now",
    checks: [
      // lint가 목록에서 먼저 오지만 pre-existing이므로 뒤로 밀려야 한다.
      { kind: "lint", status: "FAILED", summary: "실패", detail: "원래 실패" },
      { kind: "test", status: "FAILED", summary: "실패", detail: "새 실패" },
    ],
  });

  // 새로 깨진 것이 가장 시급하므로 앞에 온다.
  assert.deepEqual(digest.failingChecks.map((c) => c.kind), ["test", "lint"]);
  // pre-existing 실패도 근거로 전달한다 — "고쳐야 할 실패"가 baseline에도 있는 경우
  // (버그 수정 태스크의 정상 상황) 이걸 빼면 모델에게 아무 근거도 주지 않는 셈이 된다.
  assert.ok(digest.preexistingFailuresSummary?.includes("lint"));
  assert.ok(digest.preexistingFailuresSummary?.includes("무관하다면"));
});

test("컴파일러 출력에서 파일 참조를 뽑는다", () => {
  const refs = extractFileReferences(
    ["src/app.ts(12,5): error TS2345: bad type", "at Object.<anonymous> (test/a.test.js:44:9)", "  --> src/main.rs:7:1"].join("\n")
  );
  const keys = refs.map((r) => `${r.path}:${r.line}`);
  assert.ok(keys.includes("src/app.ts:12"));
  assert.ok(keys.includes("test/a.test.js:44"));
  assert.ok(keys.includes("src/main.rs:7"));
});

test("다이제스트는 build/test 실패를 lint보다 앞에 둔다", () => {
  const digest = buildDigest({
    taskId: "t",
    reportId: "r",
    phase: "post",
    attemptNumber: 1,
    overall: "fail",
    createdAt: "now",
    checks: [
      { kind: "lint", status: "FAILED", summary: "", detail: "lint 실패" },
      { kind: "build", status: "FAILED", summary: "", detail: "build 실패" },
      { kind: "test", status: "FAILED", summary: "", detail: "test 실패" },
    ],
  });
  assert.deepEqual(digest.failingChecks.map((c) => c.kind), ["build", "test", "lint"]);
});

/**
 * **이동은 patch보다 먼저 실행돼야 한다** — state-machine 44절.
 *
 * 모델은 옮긴 뒤를 기준으로 patch를 쓴다(프롬프트가 그렇게 지시한다). 순서가 뒤집히면 새
 * 경로에 대한 hunk가 아직 그 자리에 없는 파일에 적용되고, 그 실패는 "모델이 잘못된 patch를
 * 냈다"로 보인다.
 */
test("이동은 patch 적용보다 앞에 놓인다", () => {
  const patch = ["--- a/src/renamed.ts", "+++ b/src/renamed.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  const plan = buildExecutionPlan({
    taskId: "task-1",
    patch,
    requestedBy,
    attempt: 0,
    moves: [{ from: "src/app.ts", to: "src/renamed.ts" }],
  });

  assert.equal(plan.toolRequests[0]?.tool, "move_file");
  assert.deepEqual(plan.toolRequests[0]?.args, { from: "src/app.ts", to: "src/renamed.ts" });
  assert.equal(plan.toolRequests[1]?.tool, "apply_patch");
  // 이동은 원본을 지운다 — Node의 1차 분류도 그렇게 말해야 UI가 승인 모달을 미리 예상한다.
  assert.equal(plan.toolRequests[0]?.riskTier, "user_approval");
});

/**
 * **경로가 둘이므로 둘 다 검사한다.** 하나만 보면 나머지가 조용히 지나가고, 그 실패는
 * 게이트까지 가서야 드러난다.
 */
test("이동의 두 경로 모두 형태 검사를 지난다", () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  for (const move of [
    { from: "../outside.ts", to: "src/x.ts" },
    { from: "src/x.ts", to: "/etc/passwd" },
  ]) {
    assert.throws(
      () => buildExecutionPlan({ taskId: "t", patch, requestedBy, attempt: 0, moves: [move] }),
      ValidationError,
      JSON.stringify(move)
    );
  }
});

/** 이동이 없으면 계획은 종전과 한 글자도 다르지 않다. */
test("이동이 없으면 계획이 달라지지 않는다", () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  const plan = buildExecutionPlan({ taskId: "t", patch, requestedBy, attempt: 0 });
  assert.equal(plan.toolRequests.length, 1);
  assert.equal(plan.toolRequests[0]?.tool, "apply_patch");
});

const SIMPLE_PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");

/**
 * **삭제 → 이동 → patch.** 세 단계의 순서는 각 단계가 다음 단계의 자리를 비워 주는 방향이다
 * (state-machine 45.3절).
 *
 * 삭제가 이동보다 앞이어야 `a.ts`를 지우고 `b.ts`를 그 자리로 옮기는 표현이 성립한다 —
 * 뒤집으면 이동이 "대상이 이미 있음"으로 거부되고(44.4절), 그 거부는 모델의 잘못처럼 보인다.
 */
test("삭제가 이동보다, 이동이 patch보다 앞에 놓인다", () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  const plan = buildExecutionPlan({
    taskId: "t",
    patch,
    requestedBy,
    attempt: 0,
    moves: [{ from: "src/b.ts", to: "src/a.ts" }],
    deletions: ["src/a.ts"],
  });

  assert.deepEqual(
    plan.toolRequests.map((r) => r.tool),
    ["delete_file", "move_file", "apply_patch"]
  );
});

/**
 * **삭제만 있는 계획도 정당하다** — "이 파일을 지워라"는 patch 없이 완결되는 요구다.
 *
 * 종전 조건("patch에 hunk가 없으면 실패")을 그대로 뒀다면 그 요구는 모델이 무엇을 내든
 * 여기서 죽었다. 즉 삭제 필드를 열어도 걸어 들어갈 수 없었다.
 */
test("patch 없이 삭제만 있어도 계획이 선다", () => {
  const plan = buildExecutionPlan({ taskId: "t", patch: "", requestedBy, attempt: 0, deletions: ["src/old.ts"] });
  assert.deepEqual(
    plan.toolRequests.map((r) => r.tool),
    ["delete_file"]
  );
  assert.equal(plan.approvalRequired, true);
});

/** 그래도 **아무것도 없는** 계획은 여전히 거부한다 — 변경 없이 완료로 처리하지 않는다. */
test("patch도 이동도 삭제도 없으면 계획이 서지 않는다", () => {
  assert.throws(
    () => buildExecutionPlan({ taskId: "t", patch: "", requestedBy, attempt: 0, deletions: [], moves: [] }),
    PlanningError
  );
});

/** 삭제 경로도 형태 검사를 지난다 — 게이트가 최종 판정하지만 여기서 먼저 걸러낸다. */
test("삭제 경로가 워크스페이스를 벗어나면 계획 단계에서 막힌다", () => {
  for (const target of ["../outside.ts", "/etc/passwd"]) {
    assert.throws(
      () => buildExecutionPlan({ taskId: "t", patch: SIMPLE_PATCH, requestedBy, attempt: 0, deletions: [target] }),
      ValidationError,
      target
    );
  }
});

/**
 * **무엇이 사라지는지 계획 단계에서 보여야 한다** — 45절이 삭제를 열면서 답해야 했던 질문.
 *
 * `planPaths`가 `PLAN_CREATED.changedPaths`와 기준 대조의 근거다. 종전에는 `args.path`만
 * 읽었고, 그래서 **이동은 여기서 조용히 빠져 있었다**(44절이 남긴 구멍): 이름만 바꾸는
 * 계획은 `changedPaths: []`로 기록됐다.
 */
test("계획이 건드리는 경로에 삭제와 이동이 모두 보인다", () => {
  const plan = buildExecutionPlan({
    taskId: "t",
    patch: SIMPLE_PATCH,
    requestedBy,
    attempt: 0,
    moves: [{ from: "src/old.ts", to: "src/new.ts" }],
    deletions: ["src/gone.ts"],
  });

  assert.deepEqual(planPaths(plan).sort(), ["src/a.ts", "src/gone.ts", "src/new.ts", "src/old.ts"]);
});

/**
 * **이름 목록은 사람이 지키는 규칙이다** — 그래서 소스가 아니라 **계획이 실제로 만든 인자
 * 키**에서 유도해 대조한다. 새 도구가 `target` 같은 다른 이름의 경로 인자를 쓰면 여기서
 * 실패한다. 실패하지 않으면 그 경로는 `changedPaths`에서 조용히 빠지고, 그 누락은
 * "기준 게이트가 아무것도 못 찾았다"는 **통과**로 보인다.
 */
test("계획이 만드는 모든 인자 이름이 경로/비경로로 분류되어 있다", () => {
  const plan = buildExecutionPlan({
    taskId: "t",
    patch: SIMPLE_PATCH,
    requestedBy,
    attempt: 0,
    moves: [{ from: "src/old.ts", to: "src/new.ts" }],
    deletions: ["src/gone.ts"],
  });
  const commit = buildCommitPlan({
    taskId: "t",
    changedPaths: ["src/a.ts"],
    message: "고침",
    requestedBy,
  });

  const keys = new Set<string>();
  for (const request of [...plan.toolRequests, ...commit.toolRequests]) {
    for (const key of Object.keys(request.args)) keys.add(key);
  }

  // **빈 집합에 대한 전칭 명제는 언제나 참이다** — 무엇을 셌는지 먼저 확인한다.
  assert.ok(keys.size >= 5, `인자 키가 ${keys.size}개뿐입니다: ${[...keys].join(", ")}`);

  const known = new Set<string>([...PATH_ARGS, ...NON_PATH_ARGS]);
  const unclassified = [...keys].filter((k) => !known.has(k));
  assert.deepEqual(unclassified, [], `분류되지 않은 인자 이름: ${unclassified.join(", ")}`);

  // 반대 방향도 본다 — 목록에만 있고 아무도 쓰지 않는 이름은 목록을 썩힌다.
  const unusedPathArgs = PATH_ARGS.filter((k) => !keys.has(k));
  assert.deepEqual(unusedPathArgs, [], `계획이 쓰지 않는 경로 인자 이름: ${unusedPathArgs.join(", ")}`);
});
