import test from "node:test";
import assert from "node:assert/strict";
import type { TaskRequest } from "@tomverse/protocol";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { FakeProviderAdapter } from "../src/providers/fake.js";
import { ModelRegistry } from "../src/routing/registry.js";
import { FakeHost, VALID_PATCH, type FakeHostOptions } from "./helpers/fakeHost.js";
import { makePolicy, makeSnapshot } from "./helpers/fixtures.js";
import type { FakeProviderOptions } from "../src/providers/fake.js";
import type { ProviderCallContext } from "../src/providers/types.js";

/**
 * 취소가 **실제로 전파되는지** 검증한다.
 *
 * "CANCELLED 이벤트가 났다"만 확인하면 M0의 형식적 취소와 구별되지 않는다. 그래서 여기서는
 *  - AbortSignal이 공급자 호출에 실제로 전달되는가
 *  - 취소 이후 다음 공급자 호출이 **일어나지 않는가**
 *  - AbortError가 ERROR가 아니라 CANCELLED로 분류되는가
 *  - 완료와 취소가 경쟁할 때 terminal 이벤트가 하나만 남는가
 * 를 본다. 자식 프로세스의 실제 종료는 Rust 쪽(proctree/tools 테스트)과 e2e가 검증한다.
 */

const WORKSPACE: FakeHostOptions = {
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
    userMessage: "src/app.ts 의 상수를 고쳐줘",
    createdAt: new Date().toISOString(),
  };
}

function build(
  hostOptions: FakeHostOptions,
  fake: FakeProviderOptions,
  providers: string[] = ["fake-a", "fake-b"]
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({ ...WORKSPACE, ...hostOptions });
  const orchestrator = new Orchestrator(
    { taskRequest: taskRequest(), policy: makePolicy(), availableProviders: providers },
    { transport: host.asTransport(), adapterOptions: { fake } }
  );
  return { orchestrator, host };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 조건이 시간 내에 충족되지 않았습니다");
}

// ---- AbortSignal이 실제로 전달되는가 ----

test("공급자 호출에 실제 AbortSignal이 전달된다", async () => {
  const registry = new ModelRegistry();
  const adapter = new FakeProviderAdapter(
    { entry: registry.get("fake-executor")!, apiKey: "" },
    { script: [{ kind: "draft", delayMs: 5_000 }] }
  );

  const controller = new AbortController();
  const ctx: ProviderCallContext = {
    taskId: "t",
    callId: "draft:1",
    signal: controller.signal,
    timeoutMs: 60_000,
  };

  const promise = adapter.generateDraft({ snapshot: makeSnapshot(), userMessage: "fix" }, ctx);
  // 신호를 끊으면 진행 중인 호출이 즉시 거부되어야 한다 — 5초를 기다리지 않는다.
  const started = Date.now();
  controller.abort(new Error("취소"));
  await assert.rejects(promise, (error: unknown) => (error as Error).name === "AbortError");
  assert.ok(Date.now() - started < 2_000, "abort가 진행 중인 호출을 끊지 못했습니다");
});

test("draft 중 취소하면 reviewer를 호출하지 않는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "draft", delayMs: 3_000 }] }
  );

  const promise = orchestrator.run();
  await waitFor(() => host.phaseSequence().includes("DRAFTING"));
  assert.ok(orchestrator.cancel());

  const result = await promise;
  assert.equal(result.status, "cancelled");
  // 검수 단계로 넘어가지 않았어야 한다.
  assert.ok(!host.eventTypes().includes("REVIEW_RECEIVED"));
  assert.ok(!host.phaseSequence().includes("REVIEWING"));
});

test("review 중 취소하면 계획도 실행도 시작되지 않는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "review", delayMs: 3_000 }] }
  );

  const promise = orchestrator.run();
  await waitFor(() => host.phaseSequence().includes("REVIEWING"));
  orchestrator.cancel();

  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.ok(!host.eventTypes().includes("PLAN_CREATED"), "취소 후 계획이 만들어졌습니다");
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 0);
});

test("취소 이후 추가 검증이 실행되지 않는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "draft", delayMs: 2_000 }] }
  );

  const promise = orchestrator.run();
  // baseline 검증은 이미 돌았다.
  await waitFor(() => host.verifyCalls.length >= 1);
  await waitFor(() => host.phaseSequence().includes("DRAFTING"));
  const verifyCallsAtCancel = host.verifyCalls.length;
  orchestrator.cancel();

  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(
    host.verifyCalls.length,
    verifyCallsAtCancel,
    "취소 이후에 검증이 추가로 실행되었습니다"
  );
});

// ---- AbortError 분류 ----

test("AbortError는 ERROR가 아니라 CANCELLED로 분류된다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { script: [{ kind: "draft", throws: { message: "The operation was aborted", name: "AbortError" } }] }
  );

  const result = await orchestrator.run();
  assert.equal(result.status, "cancelled", `실패로 분류되었습니다: ${result.summary}`);
  assert.equal(result.failureReason, undefined);
  assert.ok(host.eventTypes().includes("TASK_CANCELLED"));
  assert.ok(!host.eventTypes().includes("TASK_FAILED"));
});

// ---- CANCELLING phase ----

test("취소는 CANCELLING을 거쳐 CANCELLED에 도달한다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "draft", delayMs: 2_000 }] }
  );

  const promise = orchestrator.run();
  await waitFor(() => host.phaseSequence().includes("DRAFTING"));
  orchestrator.cancel();
  await promise;

  const phases = host.phaseSequence();
  const cancelling = phases.indexOf("CANCELLING");
  const cancelled = phases.indexOf("CANCELLED");
  assert.ok(cancelling >= 0, `CANCELLING을 거치지 않았습니다: ${phases.join(" → ")}`);
  assert.equal(phases[cancelling + 1], "CANCELLED");
  assert.ok(cancelled > cancelling);
});

// ---- idempotency와 경쟁 ----

test("취소는 idempotent하다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "draft", delayMs: 2_000 }] }
  );

  const promise = orchestrator.run();
  await waitFor(() => host.phaseSequence().includes("DRAFTING"));
  assert.equal(orchestrator.cancel(), true);
  assert.equal(orchestrator.cancel(), true, "재요청도 성공이어야 합니다");
  assert.equal(orchestrator.cancel(), true);

  const result = await promise;
  assert.equal(result.status, "cancelled");
  // terminal 이벤트는 정확히 하나.
  const terminals = host.eventTypes().filter((t) => t.startsWith("TASK_") && t !== "TASK_CREATED");
  assert.deepEqual(terminals, ["TASK_CANCELLED"]);
});

test("완료 후의 취소는 상태를 바꾸지 않고 terminal 이벤트도 늘지 않는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );

  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  // 완료 뒤에 취소를 눌러도 아무 일도 일어나지 않아야 한다.
  assert.equal(orchestrator.cancel(), false, "완료된 태스크의 취소는 거부되어야 합니다");
  assert.equal(orchestrator.phase, "COMPLETED");

  const terminals = host.eventTypes().filter((t) => t.startsWith("TASK_") && t !== "TASK_CREATED");
  assert.deepEqual(terminals, ["TASK_COMPLETED"], "terminal 이벤트가 중복되었습니다");
});

test("완료와 취소가 경쟁해도 terminal 이벤트는 하나만 남는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );

  // 완료 직전에 취소를 밀어넣는다. 어느 쪽이 이기든 terminal은 하나여야 한다.
  const promise = orchestrator.run();
  const racer = (async () => {
    await waitFor(() => host.phaseSequence().includes("VERIFYING"));
    orchestrator.cancel();
  })().catch(() => undefined);

  const result = await promise;
  await racer;

  const terminals = host.eventTypes().filter((t) => t.startsWith("TASK_") && t !== "TASK_CREATED");
  assert.equal(terminals.length, 1, `terminal 이벤트가 ${terminals.length}개입니다: ${terminals.join(", ")}`);
  assert.ok(["completed", "cancelled"].includes(result.status));

  // 마지막 phase도 하나의 터미널이어야 한다.
  const phases = host.phaseSequence();
  const terminalPhases = phases.filter((p) => ["COMPLETED", "CANCELLED", "FAILED", "REJECTED"].includes(p));
  assert.equal(terminalPhases.length, 1, `터미널 phase가 여러 번 기록되었습니다: ${terminalPhases.join(", ")}`);
});

test("확인 대기 중 취소하면 영원히 멈추지 않는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [
        { kind: "review", payload: { verdict: "NEED_USER_INPUT", rationale: "모호", questionsForUser: ["?"] } },
      ],
    }
  );

  const promise = orchestrator.run();
  await waitFor(() => host.events.some((e) => e.type === "APPROVAL_REQUESTED_NOTE"));
  orchestrator.cancel();

  // 타임아웃 없이 즉시 끝나야 한다 — pendingQuestion이 풀리지 않으면 여기서 멈춘다.
  const result = await promise;
  assert.equal(result.status, "cancelled");
});

test("Rust가 도구를 취소로 보고하면 태스크가 취소로 끝난다", async () => {
  // Rust Tool Runtime이 실행 중 취소를 감지한 경우. 재시도하면 안 된다.
  const { orchestrator, host } = build(
    {
      verifyResults: [{ overall: "pass" }],
      toolResults: [{ status: "cancelled", error: "사용자 취소로 중단됨" }],
    },
    { defaultPatch: VALID_PATCH }
  );

  const result = await orchestrator.run();
  assert.equal(result.status, "cancelled");
  // 취소된 도구를 재시도하지 않는다.
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 1);
  assert.equal(host.eventTypes().filter((t) => t === "TOOL_RETRY").length, 0);
});

test("취소 요청 여부를 외부에서 관측할 수 있다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "draft", delayMs: 2_000 }] }
  );
  assert.equal(orchestrator.cancellationRequested, false);
  assert.equal(orchestrator.signal.aborted, false);

  const promise = orchestrator.run();
  await waitFor(() => host.phaseSequence().includes("DRAFTING"));
  orchestrator.cancel();

  assert.equal(orchestrator.cancellationRequested, true);
  assert.equal(orchestrator.signal.aborted, true, "AbortSignal이 실제로 끊기지 않았습니다");
  await promise;
});
