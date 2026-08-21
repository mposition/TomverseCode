import test from "node:test";
import assert from "node:assert/strict";
import type { TaskRequest } from "@tomverse/protocol";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { buildCommitMessage, buildCommitPlan, PlanningError } from "../src/orchestrator/planner.js";
import { FakeHost, VALID_PATCH, type FakeHostOptions } from "./helpers/fakeHost.js";
import { makePolicy } from "./helpers/fixtures.js";
import type { FakeProviderOptions } from "../src/providers/fake.js";

/**
 * 검증 통과 후 커밋 — docs/design/state-machine-and-protocol.md 12절
 * "Git commit 자동 생성의 오케스트레이터 통합".
 *
 * 이 파일이 고정하는 두 가지:
 *  - 커밋은 **검증을 통과한 뒤에만** 일어난다 (원칙 1: 검증이 최종 판정자다)
 *  - 커밋이 실패하거나 거부돼도 **성공한 작업이 실패로 뒤집히지 않는다**
 */

const WORKSPACE_FILES: FakeHostOptions = {
  files: [
    { path: "package.json", isDir: false, sizeBytes: 40 },
    { path: "src/app.ts", isDir: false, sizeBytes: 30 },
  ],
  contents: {
    "package.json": '{"scripts":{"test":"node --test"}}',
    "src/app.ts": "export const a = 1;\n",
  },
  gitStatus: "## main",
};

function taskRequest(): TaskRequest {
  return {
    taskId: "task-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    userMessage: "src/app.ts 의 상수를 2로 고쳐줘",
    createdAt: new Date().toISOString(),
  };
}

function build(
  hostOptions: FakeHostOptions,
  fake: FakeProviderOptions,
  policy: Parameters<typeof makePolicy>[0] = {}
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({ ...WORKSPACE_FILES, ...hostOptions });
  const orchestrator = new Orchestrator(
    { taskRequest: taskRequest(), policy: makePolicy(policy), availableProviders: ["fake-a", "fake-b"] },
    { transport: host.asTransport(), adapterOptions: { fake } }
  );
  return { orchestrator, host };
}

function commandsOf(host: FakeHost): { program: string; args: string[] }[] {
  return host.toolRequests
    .filter((r) => r.tool === "run_command")
    .map((r) => r.args as unknown as { program: string; args: string[] });
}

// ---- 계획 조립 ----

test("커밋 계획은 변경된 경로만 스테이징한다 (git add -A를 쓰지 않는다)", () => {
  // -A는 이 태스크와 무관한 미커밋 변경까지 쓸어담는다. 그건 사용자가 승인 모달에서 본 것과
  // **다른 일**이고, "보이는 argv = 실행되는 것"이라는 보장(원칙 6)이 그 순간 깨진다.
  const plan = buildCommitPlan({
    taskId: "t",
    changedPaths: ["src/app.ts", "src/util.ts"],
    message: "고침",
    requestedBy: { role: "orchestrator" },
  });

  const add = plan.toolRequests[0]!.args as { program: string; args: string[] };
  assert.equal(add.program, "git");
  // `--`로 옵션과 경로를 끊는다 — `-`로 시작하는 파일명이 옵션으로 해석되지 않게.
  assert.deepEqual(add.args, ["add", "--", "src/app.ts", "src/util.ts"]);
  assert.ok(!add.args.includes("-A"));
});

test("add와 commit을 한 요청으로 합치지 않는다", () => {
  // 셸 문자열(`git add ... && git commit ...`)로 합치면 argv 계약이 깨지고,
  // Policy Gate가 두 동작을 독립적으로 판정할 수 없다.
  const plan = buildCommitPlan({
    taskId: "t",
    changedPaths: ["src/app.ts"],
    message: "고침",
    requestedBy: { role: "orchestrator" },
  });
  // add / commit / rev-parse 셋이다. 마지막은 만든 커밋의 sha를 읽는 **읽기 전용** 단계로,
  // 그게 없으면 나중에 "이 태스크가 만든 커밋"을 특정할 수 없어 revert를 제안할 수조차 없다(19.4절).
  assert.equal(plan.toolRequests.length, 3);
  for (const request of plan.toolRequests) {
    const args = request.args as { program: string; args: string[] };
    assert.ok(!args.args.some((a) => a.includes("&&") || a.includes("|")), JSON.stringify(args));
  }
  const commit = plan.toolRequests[1]!.args as { args: string[] };
  assert.deepEqual(commit.args.slice(0, 2), ["commit", "-m"]);
  // 커밋은 언제나 승인 대상이다 — Node의 1차 분류도 그 사실을 반영한다.
  assert.equal(plan.toolRequests[1]!.riskTier, "user_approval");
  assert.equal(plan.approvalRequired, true);
  // sha 조회는 읽기 전용이라 자동이다 — 이걸 승인 대상으로 만들면 모달이 하나 더 는다.
  const sha = plan.toolRequests[2]!.args as { args: string[] };
  assert.deepEqual(sha.args, ["rev-parse", "HEAD"]);
  assert.equal(plan.toolRequests[2]!.riskTier, "auto");
});

test("변경이 없거나 메시지가 비면 계획을 만들지 않는다", () => {
  assert.throws(
    () => buildCommitPlan({ taskId: "t", changedPaths: [], message: "x", requestedBy: { role: "orchestrator" } }),
    PlanningError
  );
  assert.throws(
    () =>
      buildCommitPlan({ taskId: "t", changedPaths: ["a.ts"], message: "  ", requestedBy: { role: "orchestrator" } }),
    PlanningError
  );
});

test("커밋 메시지는 검증된 것 이상을 말하지 않는다", () => {
  const message = buildCommitMessage({
    userMessage: "여러 줄로\n적은 요청",
    changedPaths: ["src/app.ts"],
    verifiedChecks: ["build", "test"],
  });
  const [subject, ...rest] = message.split("\n");
  // 첫 줄에 줄바꿈이 들어가면 git log --oneline이 읽을 수 없다.
  assert.equal(subject, "여러 줄로 적은 요청");
  assert.ok(rest.join("\n").includes("검증 통과: build, test"));
  assert.ok(rest.join("\n").includes("- src/app.ts"));
  // 모델 이름은 커밋 로그에 남기지 않는다 — 그 시점의 라우팅 결정일 뿐이고 재현되지 않는다.
  assert.ok(!/fake-|gpt|claude/i.test(message), message);
});

test("한 번에 통과한 커밋에는 재시도 줄이 없다", () => {
  // 없는 사실을 적지 않는다. "재시도: 0회"는 참이지만, 모든 커밋에 붙으면 그 줄이
  // 아무것도 구별해주지 않으면서 메시지만 길게 만든다.
  const message = buildCommitMessage({
    userMessage: "고침",
    changedPaths: ["a.ts"],
    verifiedChecks: ["test"],
    taskId: "task-1",
    fixLoopRounds: 0,
    failedChecks: [],
  });
  assert.ok(!message.includes("재시도"), message);
});

test("여러 번 고쳐서 통과한 커밋은 그 사실을 메시지에 남긴다", () => {
  // 19.6절: 태스크 하나가 커밋 하나이므로 **중간 시도는 git 이력에 없다.** 그 줄이 없으면
  // 세 번 고쳐 통과한 변경과 처음부터 맞았던 변경이 이력에서 구별되지 않는데, 그 둘은
  // 나중에 이 커밋을 의심할 이유가 서로 다르다.
  const message = buildCommitMessage({
    userMessage: "고침",
    changedPaths: ["a.ts"],
    verifiedChecks: ["test", "lint"],
    taskId: "task-42",
    fixLoopRounds: 2,
    // 같은 체크가 두 번 실패했다 — 중복은 메시지에서 지운다.
    failedChecks: ["test", "test"],
  });
  assert.ok(message.includes("재시도: 2회 (도중 실패: test)"), message);

  // 태스크 id는 **trailer**다. 이 id는 로컬 기록을 가리키는 열쇠라 저장소를 받은 다른
  // 사람에게는 뜻이 없고, 본문 산문으로 적으면 따라갈 수 있는 것으로 오해된다.
  const lines = message.split("\n");
  assert.equal(lines[lines.length - 1], "Tomverse-Task: task-42", message);
  assert.equal(lines[lines.length - 2], "", "trailer 앞에 빈 줄이 없으면 git이 trailer로 읽지 않는다");
});

test("실패한 체크를 모르면 횟수만 적는다", () => {
  // 모르는 것을 지어내지 않는다 — "(도중 실패: )"처럼 빈 괄호를 남기지도 않는다.
  const message = buildCommitMessage({
    userMessage: "고침",
    changedPaths: ["a.ts"],
    verifiedChecks: ["test"],
    fixLoopRounds: 1,
    failedChecks: [],
  });
  assert.ok(message.includes("재시도: 1회"), message);
  assert.ok(!message.includes("도중 실패"), message);
  // taskId가 없으면 trailer도 없다.
  assert.ok(!message.includes("Tomverse-Task"), message);
});

test("검증 체크가 없으면 통과했다고 적지 않는다", () => {
  const message = buildCommitMessage({ userMessage: "고침", changedPaths: ["a.ts"], verifiedChecks: [] });
  assert.ok(message.includes("검증: 실행된 체크 없음"), message);
  assert.ok(!message.includes("검증 통과"), message);
});

// ---- 오케스트레이터 통합 ----

test("allowGitCommit이 꺼져 있으면 커밋을 시도조차 하지 않는다", async () => {
  // Policy Gate가 어차피 승인을 요구하므로 "시도해 보고 거부당하기"도 가능하지만, 그러면
  // 커밋을 원하지 않는 사용자가 매 태스크마다 모달을 닫아야 한다 — 승인 피로는 승인을
  // 무의미하게 만든다.
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(commandsOf(host), []);
  // 켜지 않은 기능을 요약에서 매번 언급하지 않는다.
  assert.ok(!result.summary.includes("커밋"), result.summary);
});

test("검증을 통과하면 커밋한다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH },
    { allowGitCommit: true } as never
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const commands = commandsOf(host);
  assert.deepEqual(
    commands.map((c) => `${c.program} ${c.args[0]}`),
    ["git add", "git commit", "git rev-parse"]
  );
  // 실제로 바뀐 파일만 스테이징된다.
  assert.deepEqual(commands[0]!.args, ["add", "--", "src/app.ts"]);

  const created = host.events.find((e) => e.type === "GIT_COMMIT_CREATED");
  assert.ok(created, "커밋 이벤트가 없습니다");
  // **sha 키가 반드시 있어야 한다.** 없으면 되돌리기가 이 커밋을 특정할 수 없다(19.4절).
  assert.ok("sha" in (created!.payload as Record<string, unknown>));
  // 되돌리기와의 관계를 요약이 말한다 — 되돌려도 커밋은 남는다.
  assert.match(result.summary, /커밋함/, result.summary);
  assert.match(result.summary, /되돌리기는 파일만 복원/, result.summary);
});

test("검증이 실패하면 커밋하지 않는다", async () => {
  // 원칙 1: 검증이 최종 판정자다. 커밋은 되돌리기 어려운 기록이므로 그 판정을 앞지르지 않는다.
  const { orchestrator, host } = build(
    {
      verifyResults: [
        { overall: "pass" },
        { overall: "fail", checks: [{ kind: "test", status: "FAILED", summary: "실패" }] },
        { overall: "fail", checks: [{ kind: "test", status: "FAILED", summary: "실패" }] },
        { overall: "fail", checks: [{ kind: "test", status: "FAILED", summary: "실패" }] },
        { overall: "fail", checks: [{ kind: "test", status: "FAILED", summary: "실패" }] },
      ],
    },
    { defaultPatch: VALID_PATCH },
    { allowGitCommit: true, limits: { fixLoopRounds: 1 } } as never
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "failed");
  assert.deepEqual(commandsOf(host), []);
  assert.ok(!host.eventTypes().includes("GIT_COMMIT_CREATED"));
});

test("검증할 명령이 없으면(not_verified) 커밋하지 않는다", async () => {
  // "검증되지 않았다"를 "통과했다"처럼 다루면 커밋이 검증 없는 변경을 이력에 박아 넣는다.
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "not_verified" }, { overall: "not_verified" }] },
    { defaultPatch: VALID_PATCH },
    { allowGitCommit: true } as never
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(commandsOf(host), []);
});

test("커밋 승인을 거부해도 작업은 성공으로 남는다", async () => {
  // 코드 변경은 이미 적용됐고 검증도 통과했다. 커밋 거부는 **사용자의 결정**이지 실패가 아니다.
  const { orchestrator, host } = build(
    {
      verifyResults: [{ overall: "pass" }, { overall: "pass" }],
      // apply_patch는 통과시키고, 그 다음 run_command(git add)에서 거부한다.
      toolResults: [{ status: "ok" }, { status: "denied", error: "사용자가 커밋을 승인하지 않음" }],
    },
    { defaultPatch: VALID_PATCH },
    { allowGitCommit: true } as never
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.match(result.summary, /커밋을 승인하지 않아 건너뜀/, result.summary);
  assert.ok(!host.eventTypes().includes("GIT_COMMIT_CREATED"));
});

test("커밋 명령이 실패하면 그 사실을 요약에 남긴다", async () => {
  // 조용히 넘기면 사용자는 커밋됐다고 믿는다.
  const { orchestrator, host } = build(
    {
      verifyResults: [{ overall: "pass" }, { overall: "pass" }],
      toolResults: [{ status: "ok" }, { status: "error", error: "nothing to commit" }],
    },
    { defaultPatch: VALID_PATCH },
    { allowGitCommit: true } as never
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.match(result.summary, /커밋 실패/, result.summary);
  assert.ok(!host.eventTypes().includes("GIT_COMMIT_CREATED"));
});

test("git 저장소가 아니면 커밋하지 않고 그 사실을 말한다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }], gitStatus: "" },
    { defaultPatch: VALID_PATCH },
    { allowGitCommit: true } as never
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(commandsOf(host), []);
  assert.match(result.summary, /git 저장소가 아니어서/, result.summary);
});
