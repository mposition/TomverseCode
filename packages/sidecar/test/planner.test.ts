import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@tomverse/protocol";
import { buildExecutionPlan, PlanningError, splitDiffByFile } from "../src/orchestrator/planner.js";
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

  const plan = buildExecutionPlan({ taskId: "task-1", patch, plan: [], requestedBy, attempt: 0 });
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
    () => buildExecutionPlan({ taskId: "t", patch: "--- a/x\n+++ b/x\n", plan: [], requestedBy, attempt: 0 }),
    PlanningError
  );
  assert.throws(() => buildExecutionPlan({ taskId: "t", patch: "", plan: [], requestedBy, attempt: 0 }), PlanningError);
});

test("workspace를 벗어나는 경로는 계획 단계에서 거부한다", () => {
  const patch = ["--- a/../../etc/passwd", "+++ b/../../etc/passwd", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n");
  assert.throws(() => buildExecutionPlan({ taskId: "t", patch, plan: [], requestedBy, attempt: 0 }), ValidationError);
});

test("절대경로도 계획 단계에서 거부한다", () => {
  const patch = ["--- a//etc/passwd", "+++ /etc/passwd", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n");
  assert.throws(() => buildExecutionPlan({ taskId: "t", patch, plan: [], requestedBy, attempt: 0 }), ValidationError);
});

test("삭제 요청은 별도 도구로 계획한다", () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  const plan = buildExecutionPlan({
    taskId: "t",
    patch,
    plan: [{ stepId: "s1", description: "구파일 제거", toolHint: "delete_file", targetPaths: ["src/old.ts"] }],
    requestedBy,
    attempt: 0,
  });
  const del = plan.toolRequests.find((r) => r.tool === "delete_file")!;
  assert.equal(del.args.path, "src/old.ts");
  assert.equal(del.riskTier, "user_approval");
});

test("planId는 시도 횟수를 반영한다", () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-1", "+2", ""].join("\n");
  const first = buildExecutionPlan({ taskId: "t", patch, plan: [], requestedBy, attempt: 0 });
  const second = buildExecutionPlan({ taskId: "t", patch, plan: [], requestedBy, attempt: 1 });
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
