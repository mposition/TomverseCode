import test from "node:test";
import assert from "node:assert/strict";
import type {
  PlanApprovalCard,
  TaskRequest,
  VerificationChecklistCard,
  VerificationChecklistCard as VerificationChecklistCardData,
} from "@tomverse/protocol";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { FakeHost, VALID_PATCH, type FakeHostOptions } from "./helpers/fakeHost.js";
import { makePolicy } from "./helpers/fixtures.js";
import type { FakeProviderOptions } from "../src/providers/fake.js";
import { ModelRegistry } from "../src/routing/registry.js";
import type { ModelEntry } from "@tomverse/protocol";

/**
 * `standard` 개발 흐름 — docs/design/state-machine-and-protocol.md 72절.
 *
 * # 무엇을 고정하는가
 *
 * `orchestrator.test.ts`가 **물러난 교차검증 파이프라인**(`DRAFTING → REVIEWING`, 72.3절)을
 * 지킨다면, 여기는 그것을 대체한 흐름을 지킨다:
 *
 * ```
 * OUTLINING → AWAITING_PLAN_APPROVAL → PLAN_REVIEWING
 *   → [서브태스크마다] IMPLEMENTING → PLANNING → AWAITING_APPROVAL → EXECUTING
 *   → VERIFYING ⇄ FIX_LOOP → RESULT_REVIEWING → AWAITING_USER_VERIFICATION → (커밋)
 * ```
 *
 * # 경로를 tier 축에서 고정한다
 *
 * **`executionMode`는 더 이상 tier를 정하지 않는다**(72.9절). 그래서 이 파일은 전부
 * `forceComplexityTier: "standard"`로 경로를 고정한다 — 모드로 고정하려 하면 TRIAGE가
 * fixture를 `simple`로 분류해 검사가 **다른 경로를 조용히 태운다.**
 */

const WORKSPACE_FILES: FakeHostOptions = {
  files: [
    { path: "package.json", isDir: false, sizeBytes: 40 },
    { path: "src/app.ts", isDir: false, sizeBytes: 30 },
    { path: "src/other.ts", isDir: false, sizeBytes: 30 },
  ],
  contents: {
    "package.json": '{"scripts":{"test":"node --test"}}',
    "src/app.ts": "export const a = 1;\n",
    "src/other.ts": "export const b = 1;\n",
  },
  gitStatus: "## main",
};

function taskRequest(message = "src/app.ts 의 상수를 2로 고쳐줘"): TaskRequest {
  return {
    taskId: "task-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    userMessage: message,
    createdAt: new Date().toISOString(),
  };
}

function build(
  hostOptions: FakeHostOptions = {},
  fake: FakeProviderOptions = { defaultPatch: VALID_PATCH },
  overrides: { providers?: string[]; policy?: Parameters<typeof makePolicy>[0] } = {}
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({
    ...WORKSPACE_FILES,
    verifyResults: [{ overall: "pass" }, { overall: "pass" }],
    ...hostOptions,
  });
  const orchestrator = new Orchestrator(
    {
      taskRequest: taskRequest(),
      // 모드가 아니라 **tier 축**에서 고정한다 — 위 머리말 참조.
      policy: makePolicy({ forceComplexityTier: "standard", ...overrides.policy }),
      availableProviders: overrides.providers ?? ["fake-a", "fake-b", "fake-c"],
    },
    { transport: host.asTransport(), adapterOptions: { fake } }
  );
  return { orchestrator, host };
}

function planCard(host: FakeHost): PlanApprovalCard {
  const request = host.gateRequests.find((r) => r.gate === "plan");
  assert.ok(request, "계획 승인 게이트를 물은 적이 없습니다");
  return request.card as PlanApprovalCard;
}

/**
 * 터미널 이벤트에 실린 카운터 — `FinalResult`에는 없다.
 *
 * 카운터는 `tasks.counters_json`의 **파생 캐시를 갱신하는 payload**이므로 이벤트가 정본이다
 * (원칙 7). 결과 객체에서 읽으면 "이벤트 없이 상태를 바꿨다"를 검사가 놓친다.
 */
function countersOf(host: FakeHost): Record<string, number> {
  const terminal = host.events.find((e) => e.type.startsWith("TASK_") && "counters" in (e.payload as object));
  assert.ok(terminal, "터미널 이벤트에 counters가 없습니다");
  return (terminal.payload as { counters: Record<string, number> }).counters;
}

function checklist(host: FakeHost): VerificationChecklistCard {
  const request = host.gateRequests.find((r) => r.gate === "verification");
  assert.ok(request, "검증 체크리스트 게이트를 물은 적이 없습니다");
  return request.card as VerificationChecklistCard;
}

/** 두 계획자가 **다른 계획**을 내게 한다 — 대조를 실제로 켜려면 값이 갈려야 한다. */
function divergentPlans(): FakeProviderOptions {
  return {
    defaultPatch: VALID_PATCH,
    scriptByModel: {
      "fake-executor": [
        {
          kind: "plan",
          payload: {
            summary: "app.ts를 고친다",
            steps: [{ intent: "상수를 바꾼다", files: ["src/app.ts"] }],
            filesToChange: ["src/app.ts"],
            risks: [],
            openQuestions: [],
            doneCriteria: ["app.ts의 상수가 2가 된다"],
            requiredTests: ["npm test"],
            subtasks: [
              { subtaskId: "s1", intent: "상수를 바꾼다", files: ["src/app.ts"], proposedGrade: "economy" },
            ],
          },
        },
      ],
      "fake-reviewer": [
        {
          kind: "plan",
          payload: {
            summary: "other.ts를 고친다",
            steps: [{ intent: "다른 파일을 바꾼다", files: ["src/other.ts"] }],
            filesToChange: ["src/other.ts"],
            risks: [],
            openQuestions: [],
            doneCriteria: ["other.ts의 상수가 2가 된다"],
            requiredTests: ["npm run lint"],
            subtasks: [
              { subtaskId: "s1", intent: "다른 파일을 바꾼다", files: ["src/other.ts"], proposedGrade: "economy" },
            ],
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// 흐름
// ---------------------------------------------------------------------------

test("standard 경로가 72.2절 phase를 순서대로 지난다", async () => {
  const { orchestrator, host } = build();
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(host.phaseSequence(), [
    "SNAPSHOTTING",
    "TRIAGE",
    "OUTLINING",
    "AWAITING_PLAN_APPROVAL",
    "PLAN_REVIEWING",
    "IMPLEMENTING",
    "PLANNING",
    "AWAITING_APPROVAL",
    "EXECUTING",
    "VERIFYING",
    "RESULT_REVIEWING",
    "AWAITING_USER_VERIFICATION",
    "COMPLETED",
  ]);
});

test("`DRAFTING`과 `REVIEWING`은 새 태스크가 진입하지 않는다 — 지워진 것이 아니라 물러난 것이다", async () => {
  const { orchestrator, host } = build();
  await orchestrator.run();
  const phases = host.phaseSequence();
  assert.ok(!phases.includes("DRAFTING"), phases.join(" → "));
  assert.ok(!phases.includes("REVIEWING"), phases.join(" → "));
});

test("승인 + 검토 생략은 PLAN_REVIEWING을 건너뛰고 그 사실이 체크리스트에 남는다", async () => {
  const { orchestrator, host } = build({ planGateChoices: ["approve_skip_review"] });
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.ok(!host.phaseSequence().includes("PLAN_REVIEWING"));
  // **짧아진 목록을 그냥 보여주지 않는다** — 생략했다는 사실이 목록에 적힌다(72.4절).
  assert.ok(
    checklist(host).notes.some((n) => n.includes("독립 검토를 생략")),
    JSON.stringify(checklist(host).notes)
  );
});

test("거부는 REJECTED로 끝나고 파일을 건드리지 않는다", async () => {
  const { orchestrator, host } = build({ planGateChoices: ["reject"] });
  const result = await orchestrator.run();

  assert.equal(result.status, "rejected");
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 0);
  assert.ok(!host.phaseSequence().includes("IMPLEMENTING"));
});

test("수정 요청은 OUTLINING으로 돌아가고 planRounds를 센다", async () => {
  const { orchestrator, host } = build({ planGateChoices: ["revise", "approve_with_review"] });
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.equal(host.phaseSequence().filter((p) => p === "OUTLINING").length, 2);
  assert.equal(countersOf(host).planRounds, 1);
});

test("계획 수정 상한을 소진해도 실패하지 않는다 — 승인 또는 거부가 남는다", async () => {
  // **막다른 길을 만들지 않는다**(72.11절). 상한이 2인데 세 번 고치라고 하면, 셋째 요청은
  // 카운터를 올리지 못하고 카드가 "이제 승인하거나 거부할 수 있습니다"를 적는다.
  const { orchestrator, host } = build({
    planGateChoices: ["revise", "revise", "revise", "approve_with_review"],
  });
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.equal(countersOf(host).planRounds, 2);
  const cards = host.gateRequests.filter((r) => r.gate === "plan").map((r) => r.card as PlanApprovalCard);
  assert.ok(
    cards.some((c) => c.notes.some((n) => n.includes("승인하거나 거부"))),
    JSON.stringify(cards.map((c) => c.notes))
  );
});

// ---------------------------------------------------------------------------
// 승인 카드 (72.4절)
// ---------------------------------------------------------------------------

test("승인 카드는 서브태스크 개수와 각 등급을 싣는다 — 개수만으로는 금액의 근거가 없다", async () => {
  const { orchestrator, host } = build();
  await orchestrator.run();

  const card = planCard(host);
  assert.equal(card.subtasks.length, 1);
  assert.ok(["economy", "frontier", "unmeasured"].includes(card.subtasks[0]!.grade));
  assert.equal(typeof card.estimatedCostUsd, "number");
});

test("승인 카드는 effort를 금액에 곱하지 않고 경고로만 적는다", async () => {
  const { orchestrator, host } = build(undefined, undefined, { policy: { effortLevel: "high" } });
  await orchestrator.run();

  const card = planCard(host);
  assert.ok(
    card.estimateCaveats.some((c) => c.includes("high") && c.includes("곱하지 않았")),
    JSON.stringify(card.estimateCaveats)
  );
});

test("승인 카드는 봉투를 넘는 요청이 거절된다는 것과 C가 빠질 수 있다는 것을 적는다", async () => {
  const { orchestrator, host } = build();
  await orchestrator.run();

  const card = planCard(host);
  // 이 문장이 없으면 사용자는 나중에 물어볼 기회가 있다고 읽는다(72.10.2절).
  assert.ok(card.notes.some((n) => n.includes("중간에 늘릴 수 없습니다")), JSON.stringify(card.notes));
  // 비용만 보여주고 이 대가를 감추면 승인이 반쪽이다(72.10.2절).
  assert.ok(card.notes.some((n) => n.includes("결과 검토")), JSON.stringify(card.notes));
  assert.ok(card.escalation.maxCalls > 0);
});

test("승인 이벤트는 Node가 내지 않는다 — Rust가 답을 받은 뒤 기록한다", async () => {
  const { orchestrator, host } = build();
  await orchestrator.run();

  // fake 호스트는 `gate.userDecision` 처리 안에서만 이 이벤트를 만든다. Node가 냈다면
  // `db.appendEvent` 경로로 들어왔을 것이고, 실제 Rust는 그것을 거절한다(`NODE_MAY_NOT_EMIT`).
  assert.ok(host.eventTypes().includes("PLAN_APPROVED"));
  assert.ok(host.eventTypes().includes("USER_VERIFICATION_APPROVED"));
});

// ---------------------------------------------------------------------------
// B — 계획 검토 (72.6·72.11절)
// ---------------------------------------------------------------------------

test("B의 쟁점은 승인으로 되돌아가고, 같은 계획이면 B를 다시 부르지 않는다", async () => {
  const { orchestrator, host } = build(
    { planGateChoices: ["approve_with_review", "approve_with_review"] },
    {
      defaultPatch: VALID_PATCH,
      // B가 쟁점을 올린다. **verdict가 아니라 쟁점이 산출물이다**(72.6절).
      scriptByModel: {
        "fake-reviewer": [
          {
            kind: "review",
            payload: {
              verdict: "NEED_USER_INPUT",
              rationale: "분해가 너무 거칠다",
              questionsForUser: ["서브태스크를 더 쪼개야 하지 않습니까?"],
            },
          },
        ],
      },
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  // 승인 카드를 **두 번** 물었고, 두 번째 카드에 B의 쟁점이 실려 있다.
  const cards = host.gateRequests.filter((r) => r.gate === "plan").map((r) => r.card as PlanApprovalCard);
  assert.equal(cards.length, 2);
  assert.ok(
    cards[1]!.notes.some((n) => n.startsWith("계획 검토(B):")),
    JSON.stringify(cards[1]!.notes)
  );

  // **계획이 바뀌지 않았으므로 B는 한 번만 돈다**(72.11절). 같은 입력에 같은 검토를 다시
  // 시키면 새로 얻는 정보 없이 호출만 는다.
  const reviewEvents = host.events.filter((e) => e.type === "PLAN_REVIEW_COMPLETED");
  assert.equal(reviewEvents.filter((e) => (e.payload as { ran: boolean }).ran).length, 1);
  assert.equal(reviewEvents.filter((e) => !(e.payload as { ran: boolean }).ran).length, 1);
});

test("계획 검토가 드롭되면 그 사실이 이벤트로 남는다 — 검토한 척하지 않는다", async () => {
  const { orchestrator, host } = build(undefined, undefined, { providers: ["fake-a"] });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  assert.ok(!host.phaseSequence().includes("PLAN_REVIEWING"));
  const event = host.events.find((e) => e.type === "PLAN_REVIEW_COMPLETED");
  assert.ok(event, "드롭도 이벤트로 남아야 한다 — 남기지 않으면 '검토했다'와 구별되지 않는다");
  assert.equal((event.payload as { ran: boolean }).ran, false);
});

// ---------------------------------------------------------------------------
// 대조 (72.9절) — 둘이 되는 것은 executor가 아니라 계획자다
// ---------------------------------------------------------------------------

test("verified는 계획자를 둘 부르고, 갈린 지점은 승인 카드에 실린다 — 따로 멈추지 않는다", async () => {
  const { orchestrator, host } = build(undefined, divergentPlans(), {
    providers: ["fake-a", "fake-b"],
    policy: { executionMode: "verified" },
  });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const detected = host.events.find((e) => e.type === "DISAGREEMENT_DETECTED");
  assert.ok(detected, "대조 리포트가 없습니다");
  // **대조의 대상을 payload가 말한다** — 초안 대조와 계획 대조가 같은 이벤트 이름을 쓴다.
  assert.equal((detected.payload as { contrastOf?: string }).contrastOf, "plan_outline");
  assert.equal((detected.payload as { contrasted: boolean }).contrasted, true);

  // **추가 정지는 0이다**(72.9절). `standard` 경로는 `AWAITING_USER_INPUT`을 쓰지 않는다 —
  // 쓰면 2.1절 표에 없는 전이(`OUTLINING → AWAITING_USER_INPUT`)를 만들게 된다(72.11절).
  assert.ok(!host.phaseSequence().includes("AWAITING_USER_INPUT"), host.phaseSequence().join(" → "));

  // 갈린 자리는 **승인 카드의 일부**로 올라간다.
  assert.ok(
    planCard(host).notes.some((n) => n.startsWith("계획 대조:")),
    JSON.stringify(planCard(host).notes)
  );
});

test("대조가 켜져도 계획 호출은 하나만 늘어난다 — 서브태스크마다 ×2가 아니다", async () => {
  const { orchestrator, host } = build(undefined, divergentPlans(), {
    providers: ["fake-a", "fake-b"],
    policy: { executionMode: "verified" },
  });
  await orchestrator.run();

  // 72.9절: 대조가 **계획 단계로 옮겨왔다.** 구현 단계에 남으면 서브태스크마다 ×2가 되어
  // N배가 되고, 불일치 카드가 붙을 게이트도 없다.
  const planCalls = host.usage.filter((u) => String((u as { callId: string }).callId).startsWith("plan:"));
  const coPlanCalls = host.usage.filter((u) => String((u as { callId: string }).callId).startsWith("plan-co:"));
  assert.equal(planCalls.length, 1);
  assert.equal(coPlanCalls.length, 1);
  // 구현은 서브태스크당 **하나**다.
  const implCalls = host.usage.filter((u) => String((u as { callId: string }).callId).startsWith("impl:"));
  assert.equal(implCalls.length, 1);
});

// ---------------------------------------------------------------------------
// 서브태스크 (72.2.2절)
// ---------------------------------------------------------------------------

test("서브태스크 둘은 순차로 구현된다 — 병렬이면 승인이 동시에 여러 개 뜬다", async () => {
  const { orchestrator, host } = build(undefined, {
    defaultPatch: VALID_PATCH,
    script: [
      {
        kind: "plan",
        payload: {
          summary: "둘로 쪼갠다",
          steps: [{ intent: "쪼갠다", files: ["src/app.ts"] }],
          filesToChange: ["src/app.ts", "src/other.ts"],
          risks: [],
          openQuestions: [],
          doneCriteria: ["둘 다 바뀐다"],
          requiredTests: ["npm test"],
          subtasks: [
            { subtaskId: "s1", intent: "app.ts", files: ["src/app.ts"], proposedGrade: "economy" },
            { subtaskId: "s2", intent: "other.ts", files: ["src/other.ts"], proposedGrade: "economy" },
          ],
        },
      },
    ],
  });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const phases = host.phaseSequence();
  assert.equal(phases.filter((p) => p === "IMPLEMENTING").length, 2);
  // **검증은 전부 끝난 뒤 한 번** 돈다(72.11절) — 그래서 서브태스크별 FIX_LOOP가 없다.
  assert.equal(phases.filter((p) => p === "VERIFYING").length, 1);
  // 순차라는 사실: 두 번째 IMPLEMENTING이 첫 EXECUTING **뒤에** 온다.
  assert.ok(phases.indexOf("EXECUTING") < phases.lastIndexOf("IMPLEMENTING"));
});

test("구현 초안의 완료 기준은 기준으로 승격되지 않는다 — 덮어쓰면 마지막 하나만 남는다", async () => {
  const { orchestrator, host } = build();
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  // `DRAFT_RECEIVED`에 `acceptanceCriteriaReplaces`가 붙으면 서브태스크 N개가 서로의 기준을
  // 차례로 덮어쓴다(72.2.2절). 붙지 않았는지를 직접 본다.
  for (const event of host.events.filter((e) => e.type === "DRAFT_RECEIVED")) {
    assert.equal(
      (event.payload as { acceptanceCriteriaReplaces?: string }).acceptanceCriteriaReplaces,
      undefined,
      JSON.stringify(event.payload)
    );
  }
  // 그리고 기준의 출처는 **사용자가 승인한 계획**이다.
  assert.ok(result.acceptanceCriteria?.some((c) => c.source === "plan_outline"));
  assert.ok(!result.acceptanceCriteria?.some((c) => c.source === "draft_proposal"));
});

// ---------------------------------------------------------------------------
// 체크리스트 (72.7·72.8절)
// ---------------------------------------------------------------------------

test("계획에 없던 파일은 판정하지 않고 보여준다 — 그 절반은 모델 없이 낸다", async () => {
  // 계획은 `src/other.ts`를 고치겠다고 했는데 patch는 `src/app.ts`를 고친다.
  const { orchestrator, host } = build(undefined, {
    defaultPatch: VALID_PATCH,
    script: [
      {
        kind: "plan",
        payload: {
          summary: "other.ts를 고친다",
          steps: [{ intent: "other", files: ["src/other.ts"] }],
          filesToChange: ["src/other.ts"],
          risks: [],
          openQuestions: [],
          doneCriteria: ["other가 바뀐다"],
          requiredTests: ["npm test"],
          subtasks: [{ subtaskId: "s1", intent: "other", files: ["src/other.ts"], proposedGrade: "economy" }],
        },
      },
    ],
  });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const card = checklist(host);
  assert.deepEqual(card.unplannedPaths, ["src/app.ts"]);
  assert.ok(
    card.notes.some((n) => n.includes("위반이 아니라")),
    JSON.stringify(card.notes)
  );
});

test("C가 없으면 체크리스트가 그 사실을 적는다 — 짧아진 목록은 안심의 근거가 아니다", async () => {
  const { orchestrator, host } = build(undefined, undefined, { providers: ["fake-a"] });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  assert.ok(!host.phaseSequence().includes("RESULT_REVIEWING"));
  assert.ok(
    checklist(host).notes.some((n) => n.includes("3자 검토 없이")),
    JSON.stringify(checklist(host).notes)
  );
});

test("C가 괜찮다고 해도 기준이 verified가 되지 않는다", async () => {
  const { orchestrator, host } = build();
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  // 17.9절이 정한 확인의 정의는 **검증 출력에 나타났는가**이고 모델 의견은 거기 해당하지
  // 않는다. fake 검증은 기준과 이어지는 테스트를 내지 않으므로 전부 미확인이어야 한다.
  const card = checklist(host);
  assert.ok(card.items.length > 0);
  assert.ok(card.items.every((i) => i.grade !== "verified"), JSON.stringify(card.items));
});

test("체크리스트의 refix는 fixLoopRounds를 올린다 — 검증이 통과한 뒤 돌아오기 때문이다", async () => {
  const { orchestrator, host } = build({
    // baseline, post, refix 뒤 post
    verifyResults: [{ overall: "pass" }, { overall: "pass" }, { overall: "pass" }],
    verificationGateChoices: ["refix", "approve"],
  }, {
    defaultPatch: VALID_PATCH,
    // `FIX_LOOP`는 `proposeFix`를 부른다. 스크립트가 없으면 fake는 REJECT를 내고 태스크가
    // 실패한다 — 그러면 이 검사가 카운터가 아니라 fake의 기본값을 재게 된다.
    script: [{ kind: "fix", payload: { verdict: "ACCEPT", rationale: "(fake) 고쳤다", patch: VALID_PATCH } }],
  });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  // 종전 정의(*"`VERIFYING` → fail 판정 시"*)로는 이 경로가 **영원히 카운터를 올리지 않는다** —
  // 매 바퀴 검증이 통과하기 때문이다(72.11절).
  assert.equal(countersOf(host).fixLoopRounds, 1);
  const started = host.events.filter((e) => e.type === "FIX_LOOP_STARTED");
  assert.equal(started.length, 1);
  assert.equal((started[0]!.payload as { enteredFrom?: string }).enteredFrom, "verification_checklist");
});

test("결과를 거부하면 CANCELLED가 아니라 REJECTED다", async () => {
  const { orchestrator } = build({ verificationGateChoices: ["revert_and_stop"] });
  const result = await orchestrator.run();
  // 사용자가 중단한 것이 아니라 **결과를 거부한 것**이고, 실패한 것이 없어 FAILED도 아니다.
  assert.equal(result.status, "rejected");
});

/**
 * **"되돌리고 종료"는 실제로 되돌린다** — 72.8절 귀환 경로 3.
 *
 * 이 검사가 없던 동안 코드는 "되돌리기는 Rust가 한다"고 **주석으로만** 말하고 아무것도
 * 되돌리지 않았으며, 최종 보고는 "변경을 되돌렸습니다"라고 했다. 상태만 보는 검사는 그것을
 * 초록색으로 통과시킨다 — 사용자는 파일이 복원됐다고 믿은 채 바뀐 워크스페이스를 갖는다.
 */
test("되돌리고 종료는 Rust에 되돌리기를 시키고, 그 결과만 보고한다", async () => {
  const { orchestrator, host } = build({
    verificationGateChoices: ["revert_and_stop"],
    rollbackResult: { restored: ["src/app.ts"], failed: [] },
  });
  const result = await orchestrator.run();

  assert.equal(result.status, "rejected");
  // **실제로 시켰는가.** 이것이 없으면 주석만 남는다.
  assert.equal(host.rollbackCalls, 1);
  assert.match(result.summary, /1개를 되돌렸습니다/, result.summary);
});

test("되돌리지 못한 파일이 있으면 '되돌렸습니다'라고 말하지 않는다", async () => {
  const { orchestrator } = build({
    verificationGateChoices: ["revert_and_stop"],
    rollbackResult: { restored: ["src/app.ts"], failed: [{ path: "src/other.ts" }] },
  });
  const result = await orchestrator.run();

  assert.equal(result.status, "rejected");
  assert.match(result.summary, /1개는 되돌리지 못했습니다/, result.summary);
});

test("되돌리기 결과가 오지 않으면 되돌렸다고 주장하지 않는다", async () => {
  // 옛 호스트이거나 배선이 끊긴 경우다. 둘 다 "복원됐다"의 근거가 아니다.
  const { orchestrator } = build({ verificationGateChoices: ["revert_and_stop"], rollbackResult: null });
  const result = await orchestrator.run();

  assert.match(result.summary, /그대로 남아 있을 수 있습니다/, result.summary);
});

/**
 * **게이트에는 타임아웃이 없다**(72.12절). 그래서 자리를 뜬 사용자에게 남는 탈출구는
 * **취소뿐**이고, 그 취소가 게이트에 닿지 않으면 태스크는 **터미널 이벤트 없이 매달린다.**
 * 타임아웃을 없앤 결정이 탈출구를 함께 없애면 안 된다(72.11절).
 */
test("게이트 대기 중 취소는 실패가 아니라 취소로 끝난다", async () => {
  const { orchestrator } = build({
    // 실제 Rust는 `PendingGates::cancel_waiting`이 `Unavailable`로 깨운다 — 거부로 뭉개지
    // 않기 위해서다. 그 응답을 받은 Node가 그것을 **실패로 읽으면** 사용자가 누른 취소가
    // "오류"가 된다.
    gateOutcome: { unavailable: "사용자가 태스크를 취소했습니다" },
  });
  orchestrator.cancel();
  const result = await orchestrator.run();

  assert.equal(result.status, "cancelled", result.summary);
  assert.notEqual(result.status, "failed");
});

/**
 * **C는 태스크를 실패시키지 못한다**(72.7절).
 *
 * 필수 호출로 두면 예산 거부·인증 오류·재시도 소진이 그대로 `TASK_FAILED`가 되고,
 * **결정론적 검증을 통과한 결과가 부가 검토자의 가용성 때문에 실패한다** — 그건 원칙 1이
 * 정한 판정 권위를 C에게 넘기는 것과 같다.
 */
test("결과 검토자가 죽어도 검증을 통과한 태스크는 완료된다", async () => {
  const { orchestrator, host } = build(undefined, {
    defaultPatch: VALID_PATCH,
    scriptByModel: {
      // B와 C가 같은 fake를 쓰므로 `review` 스텝 둘을 준다: 첫째는 B가 소비하고,
      // 둘째에서 C가 죽는다. (어댑터 인스턴스별로 커서가 따로 도는 것은 fake의 계약이다.)
      "fake-reviewer": [
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
        { kind: "review", throws: { message: "공급자가 죽었습니다" } },
      ],
    },
  });
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  // 그리고 **조용히 넘어가지 않는다** — 체크리스트가 "3자 검토 없이 만들어졌다"를 적으려면
  // 그 근거가 이벤트로 남아야 한다.
  const done = host.events.filter((e) => e.type === "RESULT_REVIEW_COMPLETED");
  assert.ok(done.some((e) => (e.payload as { ran: boolean }).ran === false), JSON.stringify(done));
});

/**
 * **폐기된 계획의 요구를 들고 가지 않는다.**
 *
 * 재계획하면 옛 계획은 사용자가 승인하지 않은 것이 된다. 그 기준이 남으면 새 구현 프롬프트와
 * 최종 체크리스트에 계속 실리고, **사용자가 승인하지 않은 요구를 구현하게 된다.**
 */
test("계획을 다시 세우면 옛 계획의 기준은 남지 않는다", async () => {
  const { orchestrator, host } = build({ planGateChoices: ["revise", "approve_with_review"] }, {
    defaultPatch: VALID_PATCH,
    script: [
      {
        kind: "plan",
        payload: {
          summary: "첫 계획",
          steps: [{ intent: "첫", files: ["src/app.ts"] }],
          filesToChange: ["src/app.ts"],
          risks: [],
          openQuestions: [],
          doneCriteria: ["폐기될 옛 요구"],
          requiredTests: ["npm test"],
          subtasks: [{ subtaskId: "s1", intent: "첫", files: ["src/app.ts"], proposedGrade: "economy" }],
        },
      },
      {
        kind: "plan",
        payload: {
          summary: "두 번째 계획",
          steps: [{ intent: "둘", files: ["src/app.ts"] }],
          filesToChange: ["src/app.ts"],
          risks: [],
          openQuestions: [],
          doneCriteria: ["살아남을 새 요구"],
          requiredTests: ["npm test"],
          subtasks: [{ subtaskId: "s1", intent: "둘", files: ["src/app.ts"], proposedGrade: "economy" }],
        },
      },
    ],
  });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const texts = (result.acceptanceCriteria ?? []).map((c) => c.text);
  assert.ok(texts.includes("살아남을 새 요구"), JSON.stringify(texts));
  assert.ok(!texts.includes("폐기될 옛 요구"), JSON.stringify(texts));
  // 체크리스트도 같은 목록을 본다.
  assert.ok(!checklist(host).items.some((i) => i.text === "폐기될 옛 요구"));
});

/**
 * **상한은 막다른 길을 만들지 않는다**(72.11절).
 *
 * 화면은 선택지를 그대로 보여준다. 소진된 것을 누르면 태스크가 실패하는 것은 그 규칙과
 * 정면으로 어긋나고, **그 실패는 사용자가 방금 고른 동작의 결과로 나타난다.**
 */
test("체크리스트에서 상한을 넘겨 고르면 실패시키지 않고 다시 묻는다", async () => {
  const { orchestrator, host } = build({
    // 상한이 2인데 세 번 계획으로 되돌아가라고 한다.
    verificationGateChoices: ["replan", "replan", "replan", "approve"],
    verifyResults: [{ overall: "pass" }, { overall: "pass" }, { overall: "pass" }, { overall: "pass" }],
  });
  const result = await orchestrator.run();

  assert.equal(result.status, "completed", result.summary);
  assert.equal(countersOf(host).planRounds, 2);
  // 그리고 소진 사실을 카드가 적는다 — 적지 않으면 사용자는 같은 버튼을 계속 누른다.
  const cards = host.gateRequests
    .filter((r) => r.gate === "verification")
    .map((r) => r.card as VerificationChecklistCardData);
  assert.ok(
    cards.some((c) => c.notes.some((n) => n.includes("다 썼습니다"))),
    JSON.stringify(cards.map((c) => c.notes))
  );
});

// ---------------------------------------------------------------------------
// 예산을 단계로 나눈다 (72.12절)
// ---------------------------------------------------------------------------

/**
 * **승인 시점이 곧 예약 시점이다** — 72.12절.
 *
 * 승인 카드가 예상 비용을 보여주는 바로 그 시점에 그 금액이 실제로 남아 있는지 확인한다 —
 * 확인하지 않으면 *"사용자가 비용을 보고 승인한다"*가 절반만 참이 되고, 태스크는
 * **구현 중간에** 죽는다.
 *
 * 단가를 아는 레지스트리가 필요하다: 기본 fake는 단가가 0이라 잡을 금액이 없고, 그러면
 * 이 검사가 **예약이 일어나지 않는 것을 통과로 읽는다.**
 */
function pricedRegistry(): ModelRegistry {
  const entry = (modelId: string, providerId: string, grade: "economy" | "frontier"): ModelEntry => ({
    modelId,
    providerId,
    protocol: "native",
    transport: "http",
    apiBaseUrl: "local://fake",
    apiKeyEnvName: "TOMVERSE_FAKE_KEY",
    grade,
    accounting: "metered",
    effort: { kind: "none" },
    capabilities: {
      toolCalling: "basic",
      structuredOutput: "strict_schema",
      imageInput: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    economics: { inputPerMTok: 10, outputPerMTok: 30, pricingAsOf: "2026-01-01" },
    availability: { requiresOrgVerification: false },
  });
  return new ModelRegistry([
    entry("fake-executor", "fake-a", "economy"),
    entry("fake-reviewer", "fake-b", "frontier"),
    entry("fake-third", "fake-c", "frontier"),
  ]);
}

function stageReservations(host: FakeHost): { type: string; id: string }[] {
  return host.events
    .filter((e) => e.type.startsWith("BUDGET_RESERVATION"))
    .map((e) => ({ type: e.type, id: String((e.payload as { correlationId?: string }).correlationId ?? "") }))
    .filter((e) => e.id.startsWith("plan-approval:"));
}

function buildPriced(
  hostOptions: FakeHostOptions = {},
  fake: FakeProviderOptions = { defaultPatch: VALID_PATCH }
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({
    ...WORKSPACE_FILES,
    verifyResults: [{ overall: "pass" }, { overall: "pass" }],
    ...hostOptions,
  });
  const orchestrator = new Orchestrator(
    {
      taskRequest: taskRequest(),
      policy: makePolicy({ forceComplexityTier: "standard", budgetUsd: 100 }),
      availableProviders: ["fake-a", "fake-b", "fake-c"],
    },
    { transport: host.asTransport(), adapterOptions: { fake }, registry: pricedRegistry() }
  );
  return { orchestrator, host };
}

test("구현 예산은 계획 승인 시점에 예약되고, 구현 시작 전에 닫힌다", async () => {
  const { orchestrator, host } = buildPriced();
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const staged = stageReservations(host);
  assert.ok(staged.length > 0, JSON.stringify(host.eventTypes()));
  // **열어 둔 채로 호출 예약이 겹치면 같은 돈이 두 번 잡혀 상한이 사실상 절반이 된다.**
  // 그래서 이 예약이 하는 일은 승인 시점의 확인이고, 실제 강제는 호출 예약이 한다.
  assert.ok(staged.some((e) => e.type === "BUDGET_RESERVATION_OPENED"), JSON.stringify(staged));
  assert.ok(staged.some((e) => e.type === "BUDGET_RESERVATION_RELEASED"), JSON.stringify(staged));
  // **`settled`가 아니다** — 이 예약으로는 아무 요청도 나가지 않았다(10.7절 `opened → released`).
  assert.ok(!staged.some((e) => e.type === "BUDGET_RESERVATION_SETTLED"), JSON.stringify(staged));
});

test("B의 쟁점으로 승인에 되돌아가면 연 예약을 닫고 다시 연다", async () => {
  const { orchestrator, host } = buildPriced(
    { planGateChoices: ["approve_with_review", "approve_with_review"] },
    {
      defaultPatch: VALID_PATCH,
      scriptByModel: {
        "fake-reviewer": [
          {
            kind: "review",
            payload: {
              verdict: "NEED_USER_INPUT",
              rationale: "분해가 거칠다",
              questionsForUser: ["더 쪼개야 하지 않습니까?"],
            },
          },
        ],
      },
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  // **다시 여는 금액이 달라질 수 있기 때문에** 닫고 다시 연다(72.12절). 닫아도 되는 근거는
  // 그 사이에 구현이 돌지 않았다는 것이고, **이미 쓴 것은 여기 없다** — 그쪽은 호출 예약이
  // `settled`로 확정했다.
  const opened = stageReservations(host).filter((e) => e.type === "BUDGET_RESERVATION_OPENED");
  assert.equal(opened.length, 2, JSON.stringify(stageReservations(host)));
});

// ---------------------------------------------------------------------------
// 무인 실행 (72.12절)
// ---------------------------------------------------------------------------

test("무인 실행은 게이트에서 멈추고, 그 정지를 사용자 거부로 기록하지 않는다", async () => {
  const { orchestrator, host } = build({ gateOutcome: "unattended" }, undefined, {
    policy: { unattended: true },
  });
  const result = await orchestrator.run();

  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "unattended_stop");
  // 사용자는 아무것도 거부한 적이 없다 — `APPROVAL_DENIED`가 있으면 감사 로그가 거짓말한다.
  assert.ok(!host.eventTypes().includes("APPROVAL_DENIED"));
  assert.ok(host.eventTypes().includes("APPROVAL_UNATTENDED"));
  // 그리고 **아무것도 바꾸지 않았다.**
  assert.equal(host.toolRequests.filter((r) => r.tool === "apply_patch").length, 0);
});

test("게이트를 UI에 전달하지 못한 것은 사용자의 판정이 아니다", async () => {
  const { orchestrator } = build({ gateOutcome: { unavailable: "창이 닫혔습니다" } });
  const result = await orchestrator.run();

  assert.equal(result.status, "failed");
  assert.notEqual(result.status, "rejected");
  assert.match(result.summary, /창이 닫혔습니다/);
});
