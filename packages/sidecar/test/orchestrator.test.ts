import test from "node:test";
import assert from "node:assert/strict";
import type { TaskRequest } from "@tomverse/protocol";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { FakeHost, VALID_PATCH, type FakeHostOptions } from "./helpers/fakeHost.js";
import { makePolicy } from "./helpers/fixtures.js";
import { DEFAULT_RETRY_POLICY } from "../src/providers/retry.js";
import type { FakeProviderOptions } from "../src/providers/fake.js";

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

function taskRequest(userMessage = "src/app.ts 의 상수를 2로 고쳐줘"): TaskRequest {
  return {
    taskId: "task-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    userMessage,
    createdAt: new Date().toISOString(),
  };
}

function build(
  hostOptions: FakeHostOptions,
  fake: FakeProviderOptions,
  overrides: {
    providers?: string[];
    policy?: Parameters<typeof makePolicy>[0];
    message?: string;
    retry?: typeof DEFAULT_RETRY_POLICY;
    providerTimeoutMs?: number;
    sessionMemory?: { text: string; decisionCount: number; truncated: boolean };
  } = {}
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({ ...WORKSPACE_FILES, ...hostOptions });
  const orchestrator = new Orchestrator(
    {
      taskRequest: taskRequest(overrides.message),
      policy: makePolicy(overrides.policy),
      availableProviders: overrides.providers ?? ["fake-a", "fake-b"],
      sessionMemory: overrides.sessionMemory,
    },
    {
      transport: host.asTransport(),
      adapterOptions: { fake },
      retryPolicy: overrides.retry,
      providerTimeoutMs: overrides.providerTimeoutMs,
    }
  );
  return { orchestrator, host };
}

test("교차검증 경로가 전체 phase를 순서대로 지난다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(host.phaseSequence(), [
    "SNAPSHOTTING",
    "TRIAGE",
    "DRAFTING",
    "REVIEWING",
    "PLANNING",
    "AWAITING_APPROVAL",
    "EXECUTING",
    "VERIFYING",
    "COMPLETED",
  ]);
});

test("baseline 검증이 작업 전에 먼저 실행된다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );
  await orchestrator.run();

  // 첫 verify는 baseline, 두 번째가 post여야 한다 — 순서가 뒤바뀌면
  // "원래 실패하던 것"과 "이번에 깨진 것"을 구별할 수 없다.
  assert.equal(host.verifyCalls[0]!.phase, "baseline");
  assert.equal(host.verifyCalls[1]!.phase, "post");
});

test("VERIFYING은 simple tier에서도 생략되지 않는다", async () => {
  // CLAUDE.md 원칙 1. fast 모드 + 단일 파일 → simple로 분류되지만 검증은 그대로 돈다.
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH },
    { policy: { executionMode: "fast" }, providers: ["fake-a"] }
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  const phases = host.phaseSequence();
  assert.ok(phases.includes("SINGLE_MODEL_FIX"), `simple 경로여야 합니다: ${phases.join(" → ")}`);
  assert.ok(!phases.includes("REVIEWING"));
  assert.ok(phases.includes("VERIFYING"), "VERIFYING이 생략되었습니다");
  assert.equal(host.verifyCalls.filter((c) => c.phase === "post").length, 1);
});

test("독립 공급자가 없으면 교차검증 없이 진행하고 그 사실을 이벤트로 남긴다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH },
    { providers: ["fake-a"] } // fake-b가 없다
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const routing = host.events.find((e) => e.type === "ROUTING_DECIDED")!.payload as {
    reviewerIndependent: boolean;
    appliedPolicies: string[];
  };
  assert.equal(routing.reviewerIndependent, false);
  assert.ok(routing.appliedPolicies.some((p) => p.startsWith("reviewer_dropped")));

  // 최종 결과 이벤트에도 남아 UI가 "교차검증 없이 진행됨"을 표시할 수 있어야 한다.
  const completed = host.events.find((e) => e.type === "TASK_COMPLETED")!.payload as { reviewerIndependent: boolean };
  assert.equal(completed.reviewerIndependent, false);
});

test("검수자 REJECT는 파일을 건드리지 않고 REJECTED로 끝난다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "review", payload: { verdict: "REJECT", rationale: "위험함", rejectionReason: "데이터 손실 위험" } }],
    }
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "rejected");
  assert.equal(result.summary, "데이터 손실 위험");
  // REJECT는 PLANNING 이전에 나오므로 되돌릴 파일이 없다 (문서 10절).
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 0);
  assert.ok(!host.phaseSequence().includes("EXECUTING"));
});

test("REVISE는 검수자의 수정본을 적용한다", async () => {
  const revised = VALID_PATCH.replace("export const a = 2;", "export const a = 3;");
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "review", payload: { verdict: "REVISE", rationale: "값이 틀렸다", revisedPatch: revised } }],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);
  const applied = host.toolRequests.find((r) => r.tool === "apply_patch")!;
  assert.ok(String(applied.args.patch).includes("+export const a = 3;"));
});

/**
 * **적용된 변경의 출처가 로그에 남는가** — product-strategy.md 14절.
 *
 * REVISE에서는 검수자의 수정본이 초안을 그대로 갈아치우고 실행된다. 그 patch가 이벤트에
 * 없으면 "왜 이 patch가 적용됐나"에 로그가 답하지 못한다 — `DRAFT_RECEIVED`가 `hasPatch`만
 * 남기던 때와 같은 구멍이다.
 */
test("검수자의 수정본과 그것이 초안을 바꿨는지가 이벤트에 남는다", async () => {
  const revised = VALID_PATCH.replace("export const a = 2;", "export const a = 3;");
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "review", payload: { verdict: "REVISE", rationale: "값이 틀렸다", revisedPatch: revised } }],
    }
  );
  await orchestrator.run();
  const review = host.events.find((e) => e.type === "REVIEW_RECEIVED")!.payload as Record<string, unknown>;
  assert.equal(String(review.revisedPatch).includes("+export const a = 3;"), true);
  assert.equal(review.revisionChangedThePatch, true);
});

test("수정본이 초안과 같으면 바꾸지 않았다고 남는다", async () => {
  // 산문만 남긴 지적이다. "검수가 기여했다"를 REVISE 개수로 세면 이 경우가 기여로 잡힌다.
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "review", payload: { verdict: "REVISE", rationale: "이렇게 해라", revisedPatch: VALID_PATCH } }],
    }
  );
  await orchestrator.run();
  const review = host.events.find((e) => e.type === "REVIEW_RECEIVED")!.payload as Record<string, unknown>;
  assert.equal(review.revisionChangedThePatch, false);
});

test("수정본이 없으면 false가 아니라 null이다", async () => {
  // false로 뭉개면 "바꾸지 않았다"와 "바꿀 기회가 없었다"가 같은 값이 된다.
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "review", payload: { verdict: "REVISE", rationale: "고쳐줘" } }],
    }
  );
  await orchestrator.run();
  const review = host.events.find((e) => e.type === "REVIEW_RECEIVED")!.payload as Record<string, unknown>;
  assert.equal(review.revisionChangedThePatch, null);
  assert.equal(review.revisedPatch, null);
});

test("ACCEPT에는 바꿈 여부가 없다 — 바꿀 기회가 없었다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "review", payload: { verdict: "ACCEPT", rationale: "좋다" } }] }
  );
  await orchestrator.run();
  const review = host.events.find((e) => e.type === "REVIEW_RECEIVED")!.payload as Record<string, unknown>;
  assert.equal(review.revisionChangedThePatch, null);
});

test("REVISE인데 수정본이 없으면 상한을 태우지 않고 실패한다", async () => {
  const { orchestrator } = build(
    { verifyResults: [{ overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "review", payload: { verdict: "REVISE", rationale: "고쳐줘" } }],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "revise_exhausted");
});

test("NEED_USER_INPUT은 AWAITING_USER_INPUT으로 가고 답변 후 DRAFTING으로 재진입한다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [
        {
          kind: "review",
          payload: { verdict: "NEED_USER_INPUT", rationale: "모호함", questionsForUser: ["이메일만 검증하면 되나요?"] },
        },
        { kind: "review", payload: { verdict: "ACCEPT", rationale: "이제 명확하다" } },
      ],
    }
  );

  const promise = orchestrator.run();
  // 질문이 도착할 때까지 기다린 뒤 답변한다.
  await waitFor(() => host.events.some((e) => e.type === "APPROVAL_REQUESTED_NOTE"));
  assert.ok(orchestrator.provideUserInput("이메일만 검증하면 됩니다"));

  const result = await promise;
  assert.equal(result.status, "completed", result.summary);

  const phases = host.phaseSequence();
  const awaiting = phases.indexOf("AWAITING_USER_INPUT");
  assert.ok(awaiting >= 0);
  // 14.1절 tier 승격: 답변 후에는 항상 DRAFTING(standard)으로 간다. TRIAGE로 되돌아가지 않는다.
  assert.equal(phases[awaiting + 1], "DRAFTING");
  assert.ok(!phases.slice(awaiting).includes("TRIAGE"));
});

test("clarificationRounds 상한을 초과하면 실패한다", async () => {
  const question = {
    kind: "review" as const,
    payload: { verdict: "NEED_USER_INPUT", rationale: "여전히 모호함", questionsForUser: ["다시 묻습니다"] },
  };
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [question, question, question, question] },
    { policy: { limits: { clarificationRounds: 2 } as never } }
  );

  const promise = orchestrator.run();
  // 상한(2)까지 답변해준다. 3번째 질문에서 실패해야 한다.
  for (let i = 0; i < 2; i += 1) {
    await waitFor(() => host.events.filter((e) => e.type === "APPROVAL_REQUESTED_NOTE").length === i + 1);
    assert.ok(orchestrator.provideUserInput(`답변 ${i + 1}`));
  }

  const result = await promise;
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "clarification_exhausted");
  assert.equal(orchestrator.counters.clarificationRounds, 3);
});

test("검증 실패는 fix loop를 태우고 상한에서 멈춘다", async () => {
  const { orchestrator, host } = build(
    {
      // baseline pass, 이후 post가 계속 실패한다.
      verifyResults: [
        { overall: "pass" },
        { overall: "fail", newlyFailing: ["test"] },
        { overall: "fail", newlyFailing: ["test"] },
        { overall: "fail", newlyFailing: ["test"] },
        { overall: "fail", newlyFailing: ["test"] },
      ],
    },
    {
      defaultPatch: VALID_PATCH,
      script: [
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시 시도 1", patch: VALID_PATCH } },
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시 시도 2", patch: VALID_PATCH } },
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시 시도 3", patch: VALID_PATCH } },
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "다시 시도 4", patch: VALID_PATCH } },
      ],
    },
    { policy: { limits: { fixLoopRounds: 3 } as never } }
  );

  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "fix_loop_exhausted");
  // 상한이 3이면 FIX_LOOP_STARTED가 3회, 4번째 실패에서 종료된다.
  assert.equal(host.events.filter((e) => e.type === "FIX_LOOP_STARTED").length, 3);
  assert.equal(orchestrator.counters.fixLoopRounds, 4);
  // 변경사항이 남아 있음을 사용자에게 알려야 한다 (롤백 UX의 전제).
  assert.ok(result.summary.includes("되돌릴"));
});

test("fix loop가 성공하면 COMPLETED가 된다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "fail", newlyFailing: ["test"] }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "fix", payload: { verdict: "ACCEPT", rationale: "고쳤다", patch: VALID_PATCH } }],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);
  assert.equal(orchestrator.counters.fixLoopRounds, 1);
  assert.ok(result.summary.includes("재시도 1회"));

  // FIX_LOOP → PLANNING으로 돌아갔다가 다시 승인·실행·검증을 지나야 한다.
  // 두 번째 계획도 승인 단계를 다시 거친다 — 첫 승인이 이후 모든 변경을 허가하지 않는다.
  const phases = host.phaseSequence();
  assert.deepEqual(phases.slice(phases.indexOf("FIX_LOOP")), [
    "FIX_LOOP",
    "PLANNING",
    "AWAITING_APPROVAL",
    "EXECUTING",
    "VERIFYING",
    "COMPLETED",
  ]);
});

test("여전히 실패 중인 체크가 있으면 통과로 보고하지 않는다", async () => {
  // 이 규칙의 근거는 verify.rs의 compute_overall 주석에 있다: baseline에서도 실패했다는
  // 이유로 pass를 주면 "실패하는 테스트를 고쳐줘" 태스크가 아무것도 안 하고 성공한다.
  const { orchestrator } = build(
    {
      verifyResults: [
        { overall: "fail", checks: [{ kind: "lint", status: "FAILED" }] },
        { overall: "fail", newlyFailing: [], preexistingFailures: ["lint"] },
      ],
    },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "fix", payload: { verdict: "REJECT", rationale: "무관한 실패", rejectionReason: "이 태스크와 무관" } }],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  // 다만 "당신 변경 때문이 아니다"라는 정보는 fix loop 이벤트에 남아 있어야 한다.
  assert.ok(result.summary.length > 0);
});

test("baseline에서 실패했던 체크가 통과로 바뀌면 성공이다", async () => {
  // 버그 수정 태스크의 정상 경로.
  const { orchestrator } = build(
    {
      verifyResults: [
        { overall: "fail", checks: [{ kind: "test", status: "FAILED" }] },
        { overall: "pass", newlyFailing: [], preexistingFailures: [] },
      ],
    },
    { defaultPatch: VALID_PATCH }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);
});

test("검증 명령이 없으면 통과로 위장하지 않고 그 사실을 알린다", async () => {
  const { orchestrator } = build(
    { verifyResults: [{ overall: "not_configured" }, { overall: "not_configured" }] },
    { defaultPatch: VALID_PATCH }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed");
  assert.ok(result.summary.includes("검증되지 않았습니다"), result.summary);
});

/**
 * **"돌릴 것이 없었다"와 "돌리지 못했다"에 같은 안내를 하지 않는다.**
 *
 * 종전에는 두 경우가 `not_verified` 하나로 뭉쳐 있어 언제나 "스크립트를 추가하세요"라고
 * 말했다. Windows에서 `npm`을 찾지 못해 테스트가 실행되지 못한 사용자에게는 **그 프로젝트에
 * 스크립트가 있는데도** 그렇게 말한 것이고, 원인을 잘못 짚은 안내는 침묵보다 나쁘다.
 */
test("검증을 실행하지 못한 경우에 '스크립트를 추가하라'고 말하지 않는다", async () => {
  const { orchestrator } = build(
    {
      verifyResults: [
        { overall: "could_not_run", checks: [{ kind: "test", status: "SKIPPED_WITH_REASON", summary: "program not found: npm" }] },
        { overall: "could_not_run", checks: [{ kind: "test", status: "SKIPPED_WITH_REASON", summary: "program not found: npm" }] },
      ],
    },
    { defaultPatch: VALID_PATCH }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed");
  assert.ok(result.summary.includes("실행하지 못해"), result.summary);
  // 없는 문제를 고치러 보내지 않는다.
  assert.ok(!result.summary.includes("스크립트를 추가"), result.summary);
  // 무엇을 못 돌렸는지가 남는다 — 이게 없으면 사용자가 무엇을 볼지 알 수 없다.
  assert.ok(result.summary.includes("program not found: npm"), result.summary);
});

test("Policy Gate 거부는 policy_denied로 실패한다", async () => {
  const { orchestrator, host } = build(
    {
      verifyResults: [{ overall: "pass" }],
      toolResults: [{ status: "denied", error: "workspace 경계 위반", policyDecision: "deny" }],
    },
    { defaultPatch: VALID_PATCH }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "policy_denied");
  // 거부된 요청을 재시도하지 않는다 (승인 피로도만 유발한다).
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 1);
  // 거부 후에는 검증을 돌리지 않는다 — 적용되지 않은 변경을 검증하는 것은 무의미하다.
  assert.equal(host.verifyCalls.filter((c) => c.phase === "post").length, 0);
});

test("사용자 승인 거부는 CANCELLED로 끝난다", async () => {
  const { orchestrator } = build(
    {
      verifyResults: [{ overall: "pass" }],
      toolResults: [{ status: "denied", error: "사용자가 승인을 거부했습니다", policyDecision: "require_user_approval" }],
    },
    { defaultPatch: VALID_PATCH }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "cancelled");
});

test("도구 실행 오류는 상한까지 재시도한 뒤 실패한다", async () => {
  const { orchestrator, host } = build(
    {
      verifyResults: [{ overall: "pass" }],
      toolResults: [
        { status: "error", error: "파일 락" },
        { status: "error", error: "파일 락" },
        { status: "error", error: "파일 락" },
      ],
    },
    { defaultPatch: VALID_PATCH },
    { policy: { limits: { toolRetries: 2 } as never } }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "tool_retry_exhausted");
  // 첫 시도 + 재시도 2회 = 3회
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 3);
  assert.equal(host.events.filter((e) => e.type === "TOOL_RETRY").length, 2);
});

test("공급자 타임아웃은 재시도 상한 후 provider_retry_exhausted가 된다", async () => {
  const { orchestrator } = build(
    { verifyResults: [{ overall: "pass" }] },
    {
      script: [
        { kind: "draft", delayMs: 5_000 },
        { kind: "draft", delayMs: 5_000 },
        { kind: "draft", delayMs: 5_000 },
        { kind: "draft", delayMs: 5_000 },
      ],
    },
    {
      providerTimeoutMs: 50,
      retry: { ...DEFAULT_RETRY_POLICY, maxRetries: 2, transientBaseMs: 1, transientCapMs: 2 },
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "provider_retry_exhausted");
  assert.ok(result.summary.includes("타임아웃"), result.summary);
});

/**
 * **대조 하나를 잃은 것이 태스크 전체의 실패로 기록되면 안 된다.**
 *
 * 구현 중 드러난 결함: co-executor 호출이 실패하면 `finish("failed")`가 불렸고, 호출부는
 * "이미 primary 초안이 있으므로 진행할 수 있다"며 계속 진행했다. 그 결과 태스크는 완료까지
 * 가는데 **이벤트 로그에는 TASK_FAILED가 남았다.** 여기서 그 두 사실이 어긋나지 않는 것을
 * 고정한다 — 로그가 결과와 다르면 감사 기록으로서 쓸모가 없다.
 */
test("co-executor 실패는 대조만 잃고 태스크를 죽이지 않는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      // 공급자가 셋이면 reviewer가 fake-third로 가므로, 이 스크립트는 **co-executor에만** 걸린다.
      scriptByModel: {
        "fake-reviewer": [{ kind: "draft", throws: { message: "invalid api key", status: 401 } }],
      },
    },
    { providers: ["fake-a", "fake-b", "fake-c"] }
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.ok(
    !host.events.some((e) => e.type === "TASK_FAILED"),
    "완료된 태스크에 TASK_FAILED가 남았습니다"
  );
  // 대조를 하지 못했다는 사실은 남아야 한다 — 대조 없이 나온 "불일치 0"은 착시다.
  assert.ok(
    host.events.some(
      (e) => e.type === "ERROR" && String((e.payload as { message?: string }).message).includes("대조 없이")
    ),
    "대조를 잃은 사실이 로그에 없습니다"
  );
});

test("인증 오류는 재시도 없이 provider_config_error가 된다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { script: [{ kind: "draft", throws: { message: "invalid api key", status: 401 } }] }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "provider_config_error");
  assert.equal(host.events.filter((e) => e.type === "PROVIDER_RETRY").length, 0);
  assert.ok(result.summary.includes("API 키"), result.summary);
});

test("모델 미지원 오류는 인증 오류와 다른 안내를 준다", async () => {
  const { orchestrator } = build(
    { verifyResults: [{ overall: "pass" }] },
    {
      script: [
        {
          kind: "draft",
          throws: { message: "Your organization must be verified to use the model gpt-5", status: 403 },
        },
      ],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.failureReason, "provider_config_error");
  assert.ok(result.summary.includes("조직 인증"), result.summary);
});

test("스키마 위반 응답은 태스크를 실패시킨다", async () => {
  // LLM 출력을 신뢰하지 않은 결과가 여기서 드러난다.
  const { orchestrator } = build(
    { verifyResults: [{ overall: "pass" }] },
    { script: [{ kind: "draft", payload: { interpretation: "" } }] }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "provider_config_error");
  assert.ok(result.summary.includes("스키마"), result.summary);
});

test("적용할 수 없는 형태의 patch는 fix loop를 태운다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      // 파일 헤더가 없는 patch — 대상 파일을 특정할 수 없다.
      defaultPatch: "@@ -1,1 +1,1 @@\n-a\n+b\n",
      script: [{ kind: "fix", payload: { verdict: "ACCEPT", rationale: "헤더를 붙였다", patch: VALID_PATCH } }],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);
  const fixStarted = host.events.find((e) => e.type === "FIX_LOOP_STARTED")!.payload as { cause?: string };
  assert.ok(fixStarted.cause?.includes("실행 계획"));
});

test("실행 중 취소는 CANCELLED가 되고 이후 도구를 실행하지 않는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    { defaultPatch: VALID_PATCH, script: [{ kind: "draft", delayMs: 200 }] }
  );

  const promise = orchestrator.run();
  await waitFor(() => host.phaseSequence().includes("DRAFTING"));
  orchestrator.cancel();

  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 0);
  assert.ok(host.eventTypes().includes("TASK_CANCELLED"));
});

test("사용자 확인 대기 중 취소도 CANCELLED가 된다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "review", payload: { verdict: "NEED_USER_INPUT", rationale: "모호", questionsForUser: ["?"] } }],
    }
  );
  const promise = orchestrator.run();
  await waitFor(() => host.events.some((e) => e.type === "APPROVAL_REQUESTED_NOTE"));
  orchestrator.cancel();
  const result = await promise;
  assert.equal(result.status, "cancelled");
});

test("모든 phase 변경이 이벤트를 남긴다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );
  await orchestrator.run();

  // CLAUDE.md 원칙 7: 이벤트 없이 상태를 바꾸지 않는다.
  // 이벤트 로그만으로 최종 상태를 설명할 수 있어야 한다.
  const phaseEvents = host.events.filter((e) => e.type === "PHASE_CHANGED");
  assert.ok(phaseEvents.length >= 8);
  for (const event of phaseEvents) {
    const payload = event.payload as { from?: string; to: string; counters?: unknown };
    assert.ok(payload.to, "PHASE_CHANGED에 to가 없습니다");
    assert.ok(payload.counters !== undefined, "카운터가 함께 기록되어야 합니다");
  }
});

test("공급자 사용량을 역할·모델과 함께 기록한다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );
  await orchestrator.run();

  // 북극성 지표(product-strategy.md 14절)의 원천 데이터.
  //
  // **대조가 켜지면 3회다**(multi-engine-routing.md 13.4절: executor ×2 + reviewer).
  // 이 숫자가 조용히 늘면 사용자가 tier를 올릴 때 무엇을 지불하는지 알 수 없게 되므로
  // 비용 표를 테스트로 고정한다.
  assert.equal(host.usage.length, 3, "executor ×2 + reviewer 세 번의 호출이 기록되어야 합니다");
  const roles = host.usage.map((u) => (u as { role: string }).role).sort();
  assert.deepEqual(roles, ["executor", "executor", "reviewer"]);
  // 두 실행자는 **서로 다른 공급자**여야 한다(13.2절 불변식 2) — 같은 공급자로 두 번 부른
  // "불일치 없음"은 정보가 아니라 착시다.
  const executorModels = host.usage
    .filter((u) => (u as { role: string }).role === "executor")
    .map((u) => (u as { modelId: string }).modelId);
  assert.equal(new Set(executorModels).size, 2, `두 실행자가 같은 모델입니다: ${executorModels.join(", ")}`);
  for (const record of host.usage) {
    const typed = record as { usage: { inputTokens: number }; costUsd?: number; modelId: string };
    assert.ok(typed.usage.inputTokens > 0);
    assert.ok(typed.modelId.length > 0);
  }
});

/**
 * **태스크 정책의 모델 지정이 라우터까지 도달한다** (multi-engine-routing.md 15절).
 *
 * 라우터 단위 테스트는 옵션을 직접 넣어 확인하지만, 그건 정책 → 라우터 배선에 대해서는
 * 아무것도 말하지 않는다. 배선이 끊기면 사용자가 고른 모델이 조용히 무시된다.
 */
test("정책의 모델 지정이 라우팅 배정에 반영된다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH },
    { policy: { modelPins: { executor: "fake-reviewer" } }, providers: ["fake-a", "fake-b", "fake-c"] }
  );
  await orchestrator.run();

  const routing = host.events.find((e) => e.type === "ROUTING_DECIDED");
  assert.ok(routing, `라우팅 이벤트가 없습니다: ${host.events.map((e) => e.type).join(", ")}`);
  const assignments = (routing!.payload as { assignments: { role: string; modelId: string; reason: string }[] })
    .assignments;
  const primary = assignments.find((a) => a.role === "executor")!;
  assert.equal(primary.modelId, "fake-reviewer", JSON.stringify(assignments));
  assert.ok(primary.reason.includes("지정"), primary.reason);
});

/**
 * **쓸 수 없는 모델을 지정하면 조용히 대체하지 않고 태스크가 멈춘다.** 대체하면 사용자는
 * 자기가 고르지 않은 모델에 자기 돈이 나간 것을 나중에 안다.
 */
test("쓸 수 없는 모델을 지정하면 라우팅에서 멈춘다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }] },
    {},
    { policy: { modelPins: { executor: "claude-sonnet-5" } } }
  );
  const result = await orchestrator.run();

  assert.equal(result.status, "failed");
  assert.ok(result.summary.includes("claude-sonnet-5"), result.summary);
  // 호출이 나가지 않았다 — 멈추는 지점이 첫 유료 호출 **전**이어야 의미가 있다.
  assert.equal(host.usage.length, 0, JSON.stringify(host.usage));
});

test("API 키가 없으면 라우팅 단계에서 명확히 실패한다", async () => {
  const { orchestrator } = build({ verifyResults: [{ overall: "pass" }] }, {}, { providers: [] });
  const result = await orchestrator.run();
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "provider_config_error");
  assert.ok(result.summary.includes("API 키"));
});

test("스냅샷 이벤트가 어떤 파일이 모델에 갔는지 기록한다", async () => {
  // README "데이터 전송 투명성" — 어느 공급자에 어떤 파일이 갔는지 표시할 수 있어야 한다.
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    { defaultPatch: VALID_PATCH }
  );
  await orchestrator.run();
  const snapshot = host.events.find((e) => e.type === "SNAPSHOT_CREATED")!.payload as {
    relevantFiles: { path: string; reasonDetail: string }[];
  };
  assert.ok(snapshot.relevantFiles.length > 0);
  for (const file of snapshot.relevantFiles) {
    assert.ok(file.reasonDetail.length > 0, `${file.path}에 선정 사유가 없습니다`);
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 조건이 시간 내에 충족되지 않았습니다");
}

// ---- FIX_LOOP가 보는 파일 내용 (context-engine.md 6.1절) ----

test("FIX_LOOP는 패치가 적용된 뒤의 파일 내용을 본다", async () => {
  // 이 결함은 **아무 증상도 내지 않았다**: 루프는 정상적으로 돌고 라운드도 세어졌으며,
  // 다만 모델이 자기가 고친 적 없는 코드를 보면서 "당신의 변경이 이미 반영되어 있다"는
  // 말을 듣고 있었다. 그러면 만든 패치는 문맥이 어긋나거나 직전 변경을 되돌린다.
  const prompts: { kind: string; text: string }[] = [];
  const { orchestrator, host } = build(
    {
      contents: { "package.json": '{"scripts":{"test":"node --test"}}', "src/app.ts": "PATCH_이전_내용\n" },
      mutationEffects: { "src/app.ts": "PATCH_이후_내용\n" },
      verifyResults: [{ overall: "pass" }, { overall: "fail", newlyFailing: ["test"] }, { overall: "pass" }],
    },
    {
      defaultPatch: VALID_PATCH,
      script: [{ kind: "fix", payload: { verdict: "ACCEPT", rationale: "고쳤다", patch: VALID_PATCH } }],
      onPrompt: (kind, text) => prompts.push({ kind, text }),
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  // 픽스처가 실제로 달라졌는지 먼저 확인한다 — 안 달라졌으면 아래 단언은 아무것도
  // 검증하지 않으면서 통과한다.
  const draft = prompts.find((p) => p.kind === "draft");
  assert.ok(draft, "초안 프롬프트가 없습니다");
  assert.ok(draft.text.includes("PATCH_이전_내용"), "초안은 변경 전 내용을 봐야 합니다");

  const fix = prompts.find((p) => p.kind === "fix");
  assert.ok(fix, "fix 프롬프트가 없습니다");
  assert.ok(fix.text.includes("PATCH_이후_내용"), "FIX_LOOP가 변경 이후 내용을 보지 못했습니다");
  assert.ok(!fix.text.includes("PATCH_이전_내용"), "FIX_LOOP가 아직 변경 이전 내용을 싣고 있습니다");

  // 다시 읽었다는 사실은 감사 기록에도 남는다 — 같은 태스크에 SNAPSHOT_CREATED가 둘
  // 남는 이유가 로그만 보고 설명되어야 한다.
  const snapshots = host.events.filter((e) => e.type === "SNAPSHOT_CREATED");
  assert.equal(snapshots.length, 2);
  const refreshed = (snapshots[1]!.payload as { refreshedAfterMutation?: { changed?: string[] } })
    .refreshedAfterMutation;
  assert.deepEqual(refreshed?.changed, ["src/app.ts"]);
});

test("fix loop 라운드마다 다시 읽는다", async () => {
  // 한 번만 다시 읽고 마는 구현도 첫 라운드 테스트는 통과한다 — 두 번째 라운드가 다시
  // 낡은 내용을 보게 되는지는 라운드를 더 돌려봐야 물어볼 수 있다.
  const { orchestrator, host } = build(
    {
      contents: { "package.json": '{"scripts":{"test":"node --test"}}', "src/app.ts": "이전\n" },
      mutationEffects: { "src/app.ts": "이후\n" },
      verifyResults: [
        { overall: "pass" },
        { overall: "fail", newlyFailing: ["test"] },
        { overall: "fail", newlyFailing: ["test"] },
        { overall: "pass" },
      ],
    },
    {
      defaultPatch: VALID_PATCH,
      script: [
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "1차", patch: VALID_PATCH } },
        { kind: "fix", payload: { verdict: "ACCEPT", rationale: "2차", patch: VALID_PATCH } },
      ],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);
  assert.equal(orchestrator.counters.fixLoopRounds, 2);

  // 최초 1회 + 라운드마다 1회.
  assert.equal(host.events.filter((e) => e.type === "SNAPSHOT_CREATED").length, 3);
});

// ---- 세션 메모리가 프롬프트까지 도달하는가 (state-machine 27절) ----

/**
 * **params에서 프롬프트까지의 배선을 확인한다.**
 *
 * Rust가 세션 메모리를 유도하는 규칙은 Rust 단위 테스트가 본다. 여기서 보는 것은 그 값이
 * `RunInput` → 스냅샷 → 프롬프트로 **실제로 도달하는가**다. 바로 이 배선이 스킬을 붙일 때
 * 한 번 끊겨 있었다(`index.ts`가 params에서 꺼내지 않았다) — 그때는 e2e가 잡았지만, 세션
 * 메모리의 양성 경로는 e2e로 만들 수 없다(헤드리스 호스트가 판정 카드에 답할 수 없다).
 *
 * 그래서 **모든 프롬프트**를 확인한다. 하나에만 실리면 전송 집계가 "각 공급자 모두에게
 * 갔다"고 말할 근거가 사라진다(7.1절).
 */
test("세션 메모리는 모든 프롬프트에 실린다", async () => {
  const prompts: { kind: string; text: string }[] = [];
  const carried = "EARLIER_DECISION_MARKER";
  const { orchestrator } = build(
    { contents: { "package.json": '{"scripts":{"test":"node --test"}}', "src/app.ts": "a\n" } },
    {
      defaultPatch: VALID_PATCH,
      onPrompt: (kind, text) => prompts.push({ kind, text }),
    },
    { sessionMemory: { text: carried, decisionCount: 1, truncated: false } }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  assert.ok(prompts.length > 0, "프롬프트가 하나도 만들어지지 않았습니다");
  for (const prompt of prompts) {
    assert.ok(
      prompt.text.includes(carried),
      `${prompt.kind} 프롬프트에 세션 메모리가 없습니다 — 전송 집계의 전제가 깨집니다`
    );
  }
});

/** 세션 메모리가 없으면 그 섹션도 없다. 빈 섹션을 싣으면 모델이 "앞선 판정이 없다"가 아니라
 * "여기 뭔가 있어야 하는데 비었다"로 읽는다. */
test("세션 메모리가 없으면 그 섹션도 프롬프트에 없다", async () => {
  const prompts: { kind: string; text: string }[] = [];
  const { orchestrator } = build(
    { contents: { "package.json": '{"scripts":{"test":"node --test"}}', "src/app.ts": "a\n" } },
    { defaultPatch: VALID_PATCH, onPrompt: (kind, text) => prompts.push({ kind, text }) }
  );
  await orchestrator.run();
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.ok(
      !prompt.text.includes("Decisions carried from earlier tasks"),
      `${prompt.kind} 프롬프트에 빈 세션 메모리 섹션이 있습니다`
    );
  }
});
