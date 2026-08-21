import test from "node:test";
import assert from "node:assert/strict";
import type { Disagreement, TaskRequest } from "@tomverse/protocol";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { FakeHost, VALID_PATCH, type FakeHostOptions } from "./helpers/fakeHost.js";
import { makePolicy } from "./helpers/fixtures.js";
import type { FakeProviderOptions, FakeScriptStep } from "../src/providers/fake.js";

/**
 * 대조 → 사용자 판정의 왕복 — docs/design/state-machine-and-protocol.md 17절,
 * ui-wireframes.md 3.9절.
 *
 * `contrast.test.ts`가 대조 **연산**을 고정한다면, 여기는 그 결과가 상태 머신에서 어떻게
 * 소비되는지를 고정한다: 언제 묻고, 언제 못 묻고, 못 물은 것이 어디에 남는가.
 */

const WORKSPACE_FILES: FakeHostOptions = {
  files: [
    { path: "package.json", isDir: false, sizeBytes: 40 },
    { path: "src/app.ts", isDir: false, sizeBytes: 30 },
    // 기준 충돌 판정은 **실재하는 경로**만 근거로 쓴다 — 두 번째 파일이 없으면
    // "다른 파일을 고치려 한다"는 상황 자체를 만들 수 없다.
    { path: "src/other.ts", isDir: false, sizeBytes: 30 },
  ],
  contents: {
    "package.json": '{"scripts":{"test":"node --test"}}',
    "src/app.ts": "export const a = 1;\n",
    "src/other.ts": "export const b = 1;\n",
  },
  gitStatus: "## main",
};

function taskRequest(): TaskRequest {
  return {
    taskId: "task-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    userMessage: "이메일 검증을 고쳐줘",
    createdAt: new Date().toISOString(),
  };
}

function build(
  fake: FakeProviderOptions,
  overrides: { providers?: string[]; policy?: Parameters<typeof makePolicy>[0] } = {}
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({ ...WORKSPACE_FILES, verifyResults: [{ overall: "pass" }, { overall: "pass" }] });
  const orchestrator = new Orchestrator(
    {
      taskRequest: taskRequest(),
      policy: makePolicy(overrides.policy),
      availableProviders: overrides.providers ?? ["fake-a", "fake-b"],
    },
    { transport: host.asTransport(), adapterOptions: { fake } }
  );
  return { orchestrator, host };
}

/** src/other.ts를 고치는 patch — 기준이 지목한 파일과 **다른 곳**을 건드리는 계획을 만들 때 쓴다. */
const OTHER_PATCH = [
  "--- a/src/other.ts",
  "+++ b/src/other.ts",
  "@@ -1,1 +1,1 @@",
  "-export const b = 1;",
  "+export const b = 2;",
  "",
].join("\n");

/** 초안 payload 하나. 두 실행자가 다른 값을 내도록 스크립트를 만들 때 쓴다. */
function draftStep(payload: {
  interpretation?: string;
  doneCriteria?: string[];
  targetPaths?: string[];
  requiredTests?: string[];
  /** 실제 patch. 기준 충돌은 `targetPaths` 서술이 아니라 **patch가 건드리는 파일**로 판정된다. */
  patch?: string;
}): FakeScriptStep {
  return {
    kind: "draft",
    payload: {
      interpretation: payload.interpretation ?? "이메일 검증 누락",
      patch: payload.patch ?? VALID_PATCH,
      plan: [{ stepId: "s1", description: "고친다", targetPaths: payload.targetPaths ?? ["src/app.ts"] }],
      risks: [],
      requiredTests: payload.requiredTests ?? ["app.test.ts"],
      uncertainties: [],
      doneCriteria: payload.doneCriteria ?? ["테스트 통과"],
    },
  };
}

/**
 * 두 실행자에게 **다른** 스크립트를 준다.
 *
 * `script` 하나로는 안 된다 — 어댑터 인스턴스가 둘이라 커서도 따로이고, 둘 다 스크립트를
 * 처음부터 소비해 언제나 같은 초안이 나온다. 그러면 대조 테스트가 아무것도 검증하지 못한다.
 */
function twoExecutorScripts(
  primary: FakeScriptStep[],
  co: FakeScriptStep[]
): Record<string, FakeScriptStep[]> {
  return { "fake-executor": primary, "fake-reviewer": co };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 조건이 시간 내에 충족되지 않았습니다");
}

function disagreementCard(host: FakeHost): { disagreements: Disagreement[]; cardKind: string } | undefined {
  const note = host.events.find(
    (e) => e.type === "APPROVAL_REQUESTED_NOTE" && (e.payload as { cardKind?: string }).cardKind === "disagreement"
  );
  return note?.payload as { disagreements: Disagreement[]; cardKind: string } | undefined;
}

test("두 실행자가 독립적으로 호출되고 각 초안이 이벤트에 남는다", async () => {
  const { orchestrator, host } = build({ defaultPatch: VALID_PATCH });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const drafts = host.events.filter((e) => e.type === "DRAFT_RECEIVED");
  assert.equal(drafts.length, 2, "대조가 켜지면 초안 이벤트가 둘이어야 합니다");
  // 어느 쪽이 이후 단계로 가는지가 로그만으로 구별되어야 한다.
  const primaries = drafts.filter((d) => (d.payload as { primaryExecutor: boolean }).primaryExecutor);
  assert.equal(primaries.length, 1);
});

test("불일치가 0건이어도 DISAGREEMENT_DETECTED를 남긴다", async () => {
  // 대조를 돌렸다는 사실 자체가 감사 대상이다 —
  // "쟁점이 없었다"와 "대조하지 않았다"는 다른 사실이다(17.3절).
  const { orchestrator, host } = build({ defaultPatch: VALID_PATCH });
  await orchestrator.run();

  const detected = host.events.find((e) => e.type === "DISAGREEMENT_DETECTED");
  assert.ok(detected, "DISAGREEMENT_DETECTED가 발행되지 않았습니다");
  const payload = detected!.payload as { contrasted: boolean; blockingCount: number; proposalIds: string[] };
  assert.equal(payload.contrasted, true);
  assert.equal(payload.blockingCount, 0);
  assert.equal(payload.proposalIds.length, 2);
});

test("독립 공급자가 없으면 대조를 드롭하고 그 사실이 로그에 남는다", async () => {
  // 같은 공급자로 두 번 부른 "불일치 없음"은 정보가 아니라 착시다(13.2절).
  const { orchestrator, host } = build({ defaultPatch: VALID_PATCH }, { providers: ["fake-a"] });
  await orchestrator.run();

  const routing = host.events.find((e) => e.type === "ROUTING_DECIDED");
  const policies = (routing!.payload as { appliedPolicies: string[] }).appliedPolicies;
  assert.ok(
    policies.some((p) => p.startsWith("contrast_dropped")),
    `대조 드롭 사유가 남지 않았습니다: ${policies.join(" | ")}`
  );
  // 공급자가 하나면 검수자도 드롭되어 단일 모델 경로로 간다. 대조를 시도조차 하지 않았으므로
  // DISAGREEMENT_DETECTED도 없다 — **없는 것이 맞다.** 여기서 빈 리포트를 남기면
  // "대조했는데 쟁점이 없었다"로 읽힌다.
  assert.ok(!host.eventTypes().includes("DISAGREEMENT_DETECTED"));
  assert.equal(host.events.filter((e) => e.type === "DRAFT_RECEIVED").length, 1);
});

test("blocking 불일치가 생기면 3.9절 카드로 묻고, 답이 기준으로 고정된다", async () => {
  const { orchestrator, host } = build({
    defaultPatch: VALID_PATCH,
    scriptByModel: twoExecutorScripts(
      // 1라운드에서 두 초안이 완료 기준에서 갈리고, 사용자 답변 후 재초안에서는 같아진다.
      [draftStep({ doneCriteria: ["빈 문자열을 거부한다"] }), draftStep({ doneCriteria: ["빈 문자열을 거부한다"] })],
      [draftStep({ doneCriteria: ["빈 문자열을 통과시킨다"] }), draftStep({ doneCriteria: ["빈 문자열을 거부한다"] })]
    ),
  });

  const promise = orchestrator.run();
  await waitFor(() => disagreementCard(host) !== undefined);

  const card = disagreementCard(host)!;
  assert.equal(card.disagreements.length, 1);
  const target = card.disagreements[0]!;
  assert.equal(target.field, "doneCriteria");
  assert.equal(target.blocking, true);

  // 사용자가 첫 번째 선택지를 고른다.
  const option = target.question.options[0]!;
  assert.ok(
    orchestrator.provideUserInput(option.label, [
      { disagreementId: target.disagreementId, optionId: option.optionId, text: option.label },
    ])
  );

  const result = await promise;
  assert.equal(result.status, "completed", result.summary);

  // 판정이 기준으로 고정되고 **어떤 쟁점에 대한 답인지**가 남는다.
  const userDecided = (result.acceptanceCriteria ?? []).filter((c) => c.source === "user_decision");
  assert.equal(userDecided.length, 1);
  assert.equal(userDecided[0]!.text, option.label);
  assert.equal(userDecided[0]!.disagreementId, target.disagreementId);

  // 감사 로그에 optionId까지 남는다 — "무엇을 골랐는가"에 답할 수 있어야 한다.
  const recorded = host.events.find((e) => e.type === "USER_DECISION_RECORDED");
  const decisions = (recorded!.payload as { decisions: { disagreementId: string; optionId: string | null }[] })
    .decisions;
  assert.deepEqual(decisions, [{ disagreementId: target.disagreementId, optionId: option.optionId, freeform: false }]);
});

test("자유 입력은 optionId 없이 freeform으로 기록된다", async () => {
  // 선택지를 고르지 않았다는 것은 **두 초안 모두 틀렸다**는 뜻이라 가장 값진 신호다.
  const { orchestrator, host } = build({
    defaultPatch: VALID_PATCH,
    scriptByModel: twoExecutorScripts(
      [draftStep({ doneCriteria: ["A"] }), draftStep({ doneCriteria: ["C"] })],
      [draftStep({ doneCriteria: ["B"] }), draftStep({ doneCriteria: ["C"] })]
    ),
  });

  const promise = orchestrator.run();
  await waitFor(() => disagreementCard(host) !== undefined);
  const target = disagreementCard(host)!.disagreements[0]!;
  assert.ok(
    orchestrator.provideUserInput("둘 다 아닙니다 — 공백만 있는 값도 거부", [
      { disagreementId: target.disagreementId, text: "둘 다 아닙니다 — 공백만 있는 값도 거부" },
    ])
  );

  const result = await promise;
  assert.equal(result.status, "completed", result.summary);
  const recorded = host.events.find((e) => e.type === "USER_DECISION_RECORDED");
  const decisions = (recorded!.payload as { decisions: { optionId: string | null; freeform: boolean }[] }).decisions;
  assert.deepEqual(decisions, [{ disagreementId: target.disagreementId, optionId: null, freeform: true }]);
});

test("여러 blocking 쟁점은 한 라운드에 묶어서 묻는다", async () => {
  // 라운드는 왕복 횟수이지 질문 개수가 아니다 — 세 번 깨우는 것이 최악이다(17.4절).
  const { orchestrator, host } = build({
    defaultPatch: VALID_PATCH,
    scriptByModel: twoExecutorScripts(
      [
        draftStep({ doneCriteria: ["A"], targetPaths: ["src/app.ts"], requiredTests: ["t1"] }),
        draftStep({ doneCriteria: ["A"], targetPaths: ["src/app.ts"], requiredTests: ["t1"] }),
      ],
      [
        draftStep({ doneCriteria: ["B"], targetPaths: ["src/other.ts"], requiredTests: ["t2"] }),
        draftStep({ doneCriteria: ["A"], targetPaths: ["src/app.ts"], requiredTests: ["t1"] }),
      ]
    ),
  });

  const promise = orchestrator.run();
  await waitFor(() => disagreementCard(host) !== undefined);
  const card = disagreementCard(host)!;

  // 세 쟁점이 한 카드에 들어간다. 카드가 세 번 뜨면 안 된다.
  assert.deepEqual(
    card.disagreements.map((d) => d.field),
    ["doneCriteria", "targetPaths", "requiredTests"]
  );
  assert.equal(host.events.filter((e) => e.type === "APPROVAL_REQUESTED_NOTE").length, 1);

  assert.ok(
    orchestrator.provideUserInput(
      "판정",
      card.disagreements.map((d) => ({
        disagreementId: d.disagreementId,
        optionId: d.question.options[0]!.optionId,
        text: d.question.options[0]!.label,
      }))
    )
  );
  const result = await promise;
  assert.equal(result.status, "completed", result.summary);
  // 쟁점 하나당 기준 하나 — 한 문장으로 합치면 항목별 확인이 불가능해진다.
  assert.equal((result.acceptanceCriteria ?? []).filter((c) => c.source === "user_decision").length, 3);
});

test("재질문 상한을 소진해도 실패하지 않고, 못 물은 쟁점을 보고에 남긴다", async () => {
  // 17.4절 마지막 항목: 기존 상한 규칙은 "모델이 계속 모호하다고 말하는 경우"를 위한 것이고,
  // 이쪽은 사용자가 이미 답을 준 뒤 남은 쟁점이므로 진행하되 표시한다.
  // 두 실행자가 **끝까지** 갈린다 — 사용자가 답해도 다음 초안에서 또 갈린다.
  const alwaysA = [0, 1, 2, 3].map(() => draftStep({ doneCriteria: ["A"] }));
  const alwaysB = [0, 1, 2, 3].map(() => draftStep({ doneCriteria: ["B"] }));
  const { orchestrator, host } = build(
    { defaultPatch: VALID_PATCH, scriptByModel: twoExecutorScripts(alwaysA, alwaysB) },
    { policy: { limits: { clarificationRounds: 1 } as never } }
  );

  const promise = orchestrator.run();
  await waitFor(() => disagreementCard(host) !== undefined);
  const first = disagreementCard(host)!.disagreements[0]!;
  assert.ok(
    orchestrator.provideUserInput("첫 판정", [
      { disagreementId: first.disagreementId, optionId: first.question.options[0]!.optionId, text: "A" },
    ])
  );

  const result = await promise;
  // **실패가 아니다.** 상한에 걸렸다고 태스크를 죽이면 사용자가 이미 답한 판정까지 버려진다.
  assert.equal(result.status, "completed", result.summary);
  assert.ok((result.unresolvedDisagreements?.length ?? 0) > 0, "묻지 못한 쟁점이 기록되지 않았습니다");
  // 요약이 그 사실을 말한다 — 질문 예산이 모자랐다는 것을 숨기지 않는다.
  assert.match(result.summary, /묻지 못한 쟁점/, result.summary);
});

test("사용자가 고른 파일을 건드리지 않는 계획은 실행 전에 되돌려진다", async () => {
  // 17.3절 규칙 1: "기준과 충돌하는 patch가 오면 FIX_LOOP가 아니라 재요청 대상이다."
  // 1라운드에서 수정 위치가 갈리고, 사용자가 src/app.ts를 고른다. 그런데 두 초안 모두
  // src/other.ts를 고치는 patch를 낸다 → PLANNING 게이트가 잡아 초안부터 다시 요청한다.
  const wrongPlace = draftStep({ targetPaths: ["src/other.ts"], doneCriteria: ["A"], patch: OTHER_PATCH });
  const rightPlace = draftStep({ targetPaths: ["src/app.ts"], doneCriteria: ["A"], patch: VALID_PATCH });
  const { orchestrator, host } = build({
    defaultPatch: VALID_PATCH,
    scriptByModel: twoExecutorScripts(
      [draftStep({ targetPaths: ["src/app.ts"], doneCriteria: ["A"] }), wrongPlace, rightPlace],
      [draftStep({ targetPaths: ["src/other.ts"], doneCriteria: ["A"], patch: OTHER_PATCH }), wrongPlace, rightPlace]
    ),
  });

  const promise = orchestrator.run();
  await waitFor(() => disagreementCard(host) !== undefined);
  const target = disagreementCard(host)!.disagreements.find((d) => d.field === "targetPaths")!;
  // 사용자가 "src/app.ts"를 고른다.
  const option = target.question.options.find((o) => o.label.includes("src/app.ts"))!;
  assert.ok(
    orchestrator.provideUserInput(option.label, [
      { disagreementId: target.disagreementId, optionId: option.optionId, text: option.label },
    ])
  );

  const result = await promise;
  assert.equal(result.status, "completed", result.summary);

  // 충돌이 감지됐고, **FIX_LOOP가 아니라** 초안 재요청으로 처리됐다.
  const conflict = host.events.find((e) => e.type === "CRITERIA_CONFLICT_DETECTED");
  assert.ok(conflict, `기준 충돌이 감지되지 않았습니다: ${host.eventTypes().join(", ")}`);
  assert.equal((conflict!.payload as { fixLoopRounds: number }).fixLoopRounds, 0);
  assert.equal(orchestrator.counters.fixLoopRounds, 0, "실행 전 충돌에 fix loop 예산을 썼습니다");
  assert.ok(orchestrator.counters.reviseRounds > 0, "실행 전 합의 실패 예산(reviseRounds)이 쓰이지 않았습니다");

  // 되돌린 뒤 나온 계획은 사용자가 고른 파일을 건드린다.
  const plans = host.events.filter((e) => e.type === "PLAN_CREATED");
  const lastPlan = plans[plans.length - 1]!.payload as { changedPaths: string[] };
  assert.deepEqual(lastPlan.changedPaths, ["src/app.ts"]);
});

test("감지된 충돌은 결말이 빠짐없이 남는다 (집계의 두 수가 어긋나지 않도록)", async () => {
  // 결말을 세는 지표는 결말이 빠짐없이 남을 때만 의미가 있다(17.10절 ②). 감지 N건에 결말
  // M건(M<N)이면 차이가 어디서 났는지 알 수 없고, 그 차이가 하필 실패한 태스크에 몰려
  // 있으면 지표가 낙관 쪽으로 휜다.
  //
  // 여기서는 **끝까지 다른 곳을 고치는** 모델을 재현한다 → 재요청 예산을 소진하고 진행한다.
  const wrongPlace = draftStep({ targetPaths: ["src/other.ts"], doneCriteria: ["A"], patch: OTHER_PATCH });
  const { orchestrator, host } = build(
    {
      defaultPatch: OTHER_PATCH,
      scriptByModel: twoExecutorScripts(
        [draftStep({ targetPaths: ["src/app.ts"], doneCriteria: ["A"] }), wrongPlace, wrongPlace, wrongPlace],
        [
          draftStep({ targetPaths: ["src/other.ts"], doneCriteria: ["A"], patch: OTHER_PATCH }),
          wrongPlace,
          wrongPlace,
          wrongPlace,
        ]
      ),
    },
    { policy: { limits: { clarificationRounds: 2, reviseRounds: 1 } as never } }
  );

  const promise = orchestrator.run();
  await waitFor(() => disagreementCard(host) !== undefined);
  const target = disagreementCard(host)!.disagreements.find((d) => d.field === "targetPaths")!;
  const option = target.question.options.find((o) => o.label.includes("src/app.ts"))!;
  assert.ok(
    orchestrator.provideUserInput(option.label, [
      { disagreementId: target.disagreementId, optionId: option.optionId, text: option.label },
    ])
  );
  const result = await promise;
  assert.ok(result.status === "completed" || result.status === "failed", result.summary);

  const detected = host.events
    .filter((e) => e.type === "CRITERIA_CONFLICT_DETECTED")
    .reduce((sum, e) => sum + (e.payload as { conflicts: unknown[] }).conflicts.length, 0);
  const settled = host.events
    .filter((e) => e.type === "CRITERIA_CONFLICT_RESOLVED")
    .reduce((sum, e) => sum + (e.payload as { outcomes: unknown[] }).outcomes.length, 0);

  assert.ok(detected > 0, "충돌이 감지되지 않아 이 테스트가 아무것도 검증하지 못합니다");
  assert.equal(settled, detected, `감지 ${detected}건에 결말 ${settled}건 — 결말이 새고 있습니다`);
  // 예산을 소진했으므로 마지막 결말은 "그대로 진행"이어야 한다.
  const outcomes = host.events
    .filter((e) => e.type === "CRITERIA_CONFLICT_RESOLVED")
    .flatMap((e) => (e.payload as { outcomes: { outcome: string }[] }).outcomes.map((o) => o.outcome));
  assert.ok(outcomes.includes("proceeded_without_change"), outcomes.join(", "));
});

/**
 * `plan_unchanged`가 났을 때 **해석 텍스트가 움직였는지**를 함께 남긴다 — 17.10절 ⑧.
 *
 * 두 실행을 대조한다. 계획이 그대로인 것은 같지만 원인이 다르고, 그 차이가 payload에 보여야
 * 지표가 "고칠 곳이 게이트인가 프롬프트인가"를 가를 수 있다.
 */
async function planUnchangedOutcomes(interpretations: [string, string]): Promise<
  { outcome: string; interpretationTextChanged: boolean | null }[]
> {
  const wrong = (interpretation: string) =>
    draftStep({ interpretation, targetPaths: ["src/other.ts"], doneCriteria: ["A"], patch: OTHER_PATCH });
  const { orchestrator, host } = build(
    {
      defaultPatch: OTHER_PATCH,
      scriptByModel: twoExecutorScripts(
        [
          draftStep({ targetPaths: ["src/app.ts"], doneCriteria: ["A"] }),
          wrong(interpretations[0]),
          wrong(interpretations[1]),
          wrong(interpretations[1]),
        ],
        [
          draftStep({ targetPaths: ["src/other.ts"], doneCriteria: ["A"], patch: OTHER_PATCH }),
          wrong(interpretations[0]),
          wrong(interpretations[1]),
          wrong(interpretations[1]),
        ]
      ),
    },
    { policy: { limits: { clarificationRounds: 2, reviseRounds: 1 } as never } }
  );

  const promise = orchestrator.run();
  await waitFor(() => disagreementCard(host) !== undefined);
  const target = disagreementCard(host)!.disagreements.find((d) => d.field === "targetPaths")!;
  const option = target.question.options.find((o) => o.label.includes("src/app.ts"))!;
  assert.ok(
    orchestrator.provideUserInput(option.label, [
      { disagreementId: target.disagreementId, optionId: option.optionId, text: option.label },
    ])
  );
  await promise;

  return host.events
    .filter((e) => e.type === "CRITERIA_CONFLICT_RESOLVED")
    .flatMap(
      (e) =>
        (e.payload as { outcomes: { outcome: string; interpretationTextChanged: boolean | null }[] }).outcomes
    );
}

test("계획이 그대로일 때 해석 텍스트가 움직였는지를 함께 남긴다", async () => {
  // 12절 "충돌 결말 실측": plan_unchanged 비율만으로는 고칠 곳을 알 수 없다. 다시 요청했는데
  // **해석조차 그대로**면 모델이 피드백을 읽지 않은 쪽에 가깝고(고칠 곳은 프롬프트), 해석은
  // 바뀌었는데 계획이 그대로면 읽고도 같은 곳을 고르겠다고 한 것이다(게이트를 의심할 자리).
  const same = await planUnchangedOutcomes(["이메일 검증 누락", "이메일 검증 누락"]);
  const unchanged = same.filter((o) => o.outcome === "plan_unchanged");
  assert.ok(unchanged.length > 0, `plan_unchanged가 없어 이 테스트가 아무것도 검증하지 못합니다: ${JSON.stringify(same)}`);
  assert.ok(
    unchanged.every((o) => o.interpretationTextChanged === false),
    JSON.stringify(same)
  );

  const moved = await planUnchangedOutcomes(["이메일 검증 누락", "경계 조건 처리 누락"]);
  const movedUnchanged = moved.filter((o) => o.outcome === "plan_unchanged");
  assert.ok(movedUnchanged.length > 0, JSON.stringify(moved));
  assert.ok(
    movedUnchanged.every((o) => o.interpretationTextChanged === true),
    JSON.stringify(moved)
  );

  // **재요청이 일어나지 않은 결말은 언제나 null이다.** false로 쓰면 "다시 물었는데 해석이
  // 그대로였다"로 읽히는데, 다시 묻지도 않았다.
  const proceeded = same.filter((o) => o.outcome === "proceeded_without_change");
  assert.ok(proceeded.length > 0, JSON.stringify(same));
  assert.ok(proceeded.every((o) => o.interpretationTextChanged === null), JSON.stringify(same));
});

test("VERIFYING 뒤에 기준 판정이 계산되고 근거 없는 기준은 미확인으로 남는다", async () => {
  // 17.3절 규칙 2: 검증 결과 옆에 기준 체크리스트를 함께 낸다. **모델에게 판정시키지 않는다.**
  const { orchestrator, host } = build({ defaultPatch: VALID_PATCH });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const evaluated = host.events.find((e) => e.type === "CRITERIA_EVALUATED");
  assert.ok(evaluated, "기준 판정이 이벤트로 남지 않았습니다");
  const payload = evaluated!.payload as { verified: number; evaluations: { status: string; reason: string }[] };
  // fake 초안의 기준("테스트 통과")은 어떤 테스트 파일도 지목하지 않으므로 확인될 수 없다.
  assert.equal(payload.verified, 0);
  assert.ok(payload.evaluations.every((e) => e.status === "UNVERIFIED"));
  assert.ok(payload.evaluations.every((e) => e.reason.trim().length > 0));
});

test("공급자가 셋이면 대조와 독립 검수를 동시에 만족한다", async () => {
  // 13.3절 절충이 필요 없는 경우. 라우터는 완전 독립 배정을 우선한다.
  const { orchestrator, host } = build({ defaultPatch: VALID_PATCH }, { providers: ["fake-a", "fake-b", "fake-c"] });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const routing = (host.events.find((e) => e.type === "ROUTING_DECIDED")!.payload as {
    assignments: { role: string; providerId: string }[];
    reviewerIndependent: boolean;
    appliedPolicies: string[];
  });
  const executors = routing.assignments.filter((a) => a.role === "executor");
  assert.equal(executors.length, 2);
  assert.notEqual(executors[0]!.providerId, executors[1]!.providerId);
  assert.equal(routing.reviewerIndependent, true);
  assert.ok(!routing.appliedPolicies.some((p) => p.startsWith("reviewer_shares_provider")));
});

test("공급자가 둘이면 대조가 검수보다 우선하고, 그 절충이 로그에 남는다", async () => {
  // 13.3절: 불변식 1과 2를 동시에 만족시킬 수 없다. 대조는 사용자 판정을 위한 질문을 만들고
  // 검수는 모델 의견을 하나 더 얻으므로, 포기할 것은 모델 의견 쪽이다.
  const { orchestrator, host } = build({ defaultPatch: VALID_PATCH }, { providers: ["fake-a", "fake-b"] });
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const routing = host.events.find((e) => e.type === "ROUTING_DECIDED")!.payload as {
    reviewerIndependent: boolean;
    appliedPolicies: string[];
  };
  // 절충의 대가를 숨기지 않는다.
  assert.equal(routing.reviewerIndependent, false);
  assert.ok(routing.appliedPolicies.some((p) => p.startsWith("reviewer_shares_provider")));

  // 그럼에도 **자기가 쓴 안을 자기가 검수하지 않는다.**
  const review = host.events.find((e) => e.type === "REVIEW_RECEIVED")!.payload as {
    actualReviewerModel: string;
  };
  const primaryDraft = host.events.find(
    (e) => e.type === "DRAFT_RECEIVED" && (e.payload as { primaryExecutor: boolean }).primaryExecutor
  )!.payload as { model: string };
  assert.notEqual(review.actualReviewerModel, primaryDraft.model);
});
