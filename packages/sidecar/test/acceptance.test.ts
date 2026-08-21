import test from "node:test";
import assert from "node:assert/strict";
import type { AcceptanceCriterion, FinalResult, TaskRequest } from "@tomverse/protocol";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { FakeHost, VALID_PATCH, type FakeHostOptions } from "./helpers/fakeHost.js";
import { makePolicy } from "./helpers/fixtures.js";
import type { FakeProviderOptions } from "../src/providers/fake.js";

/**
 * 사용자 판정의 수명 — docs/design/state-machine-and-protocol.md 17.3절.
 *
 * 이 파일이 고정하는 것은 **판정이 소비되는 자리가 있다**는 사실이다. 프롬프트에 들어가는지는
 * 여기서 보지 않는다(프롬프트는 요청이지 기록이 아니다). 기준 목록에 남고, 감사 로그에 원문이
 * 남고, 최종 보고가 그것을 참조하는지를 본다.
 *
 * 비밀값 마스킹은 여기 없다 — **Rust 신뢰 경계의 몫**이라 core 크레이트에서 검증한다
 * (`host::tests::user_decision_keeps_the_answer_but_masks_secret_shapes`).
 * Node가 스스로 가리게 두면 장악당한 Node에서 그 규칙이 사라진다(CLAUDE.md 원칙 2).
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
    userMessage: "이메일 검증을 고쳐줘",
    createdAt: new Date().toISOString(),
  };
}

function build(
  hostOptions: FakeHostOptions,
  fake: FakeProviderOptions
): { orchestrator: Orchestrator; host: FakeHost } {
  const host = new FakeHost({ ...WORKSPACE_FILES, ...hostOptions });
  const orchestrator = new Orchestrator(
    { taskRequest: taskRequest(), policy: makePolicy(), availableProviders: ["fake-a", "fake-b"] },
    { transport: host.asTransport(), adapterOptions: { fake } }
  );
  return { orchestrator, host };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 조건이 시간 내에 충족되지 않았습니다");
}

/** 재질문 한 번을 태우고 사용자가 답한 뒤 완료되는 실행. */
async function runWithOneClarification(answer: string): Promise<{ result: FinalResult; host: FakeHost }> {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [
        {
          kind: "review",
          payload: {
            verdict: "NEED_USER_INPUT",
            rationale: "모호함",
            questionsForUser: ["빈 문자열 이메일은 통과입니까, 거부입니까?"],
          },
        },
        { kind: "review", payload: { verdict: "ACCEPT", rationale: "이제 명확하다" } },
      ],
    }
  );
  const promise = orchestrator.run();
  await waitFor(() => host.events.some((e) => e.type === "APPROVAL_REQUESTED_NOTE"));
  assert.ok(orchestrator.provideUserInput(answer));
  return { result: await promise, host };
}

test("사용자 답변이 AcceptanceCriterion으로 승격되어 FinalResult에 나타난다", async () => {
  const { result } = await runWithOneClarification("빈 문자열은 거부해주세요");

  assert.equal(result.status, "completed", result.summary);
  const criteria = result.acceptanceCriteria ?? [];
  const userDecided = criteria.filter((c) => c.source === "user_decision");
  assert.equal(userDecided.length, 1, `사용자 판정이 기준으로 남지 않았습니다: ${JSON.stringify(criteria)}`);
  // 답변 원문이 그대로 기준 텍스트가 된다 — 모델에게 "여기서 기준을 뽑아라"고 시키면
  // 사용자의 판정이 다시 모델의 해석을 거치게 되고 권위를 사용자에 두기로 한 결정이 무효가 된다.
  assert.equal(userDecided[0]!.text, "빈 문자열은 거부해주세요");
  assert.ok(userDecided[0]!.decidedAt);
});

test("USER_DECISION_RECORDED에 답변 원문이 남는다 (길이만 남기지 않는다)", async () => {
  const answer = "빈 문자열은 거부하고 공백만 있는 값도 거부합니다";
  const { host } = await runWithOneClarification(answer);

  const decision = host.events.find((e) => e.type === "USER_DECISION_RECORDED");
  assert.ok(decision, "USER_DECISION_RECORDED가 발행되지 않았습니다");
  const payload = decision!.payload as { answer?: string; acceptanceCriteria?: AcceptanceCriterion[] };
  assert.equal(payload.answer, answer);
  // 파생 캐시를 갱신할 재료가 같은 이벤트에 실려야 한다 — 이벤트 없이 기준이 생기는 경로를
  // 만들지 않기 위한 것이다(CLAUDE.md 원칙 7).
  assert.equal(payload.acceptanceCriteria?.length, 1);
  assert.equal(payload.acceptanceCriteria?.[0]!.source, "user_decision");
});

test("DraftProposal.doneCriteria가 draft_proposal 기준으로 흡수된다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [
        {
          kind: "draft",
          payload: {
            interpretation: "이메일 검증 누락",
            patch: VALID_PATCH,
            plan: [{ stepId: "s1", description: "고친다", targetPaths: [] }],
            risks: [],
            requiredTests: [],
            uncertainties: [],
            doneCriteria: ["빈 문자열을 거부한다", "기존 로그인 흐름을 깨뜨리지 않는다"],
          },
        },
      ],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);

  const texts = (result.acceptanceCriteria ?? [])
    .filter((c) => c.source === "draft_proposal")
    .map((c) => c.text);
  assert.deepEqual(texts, ["빈 문자열을 거부한다", "기존 로그인 흐름을 깨뜨리지 않는다"]);

  // 이벤트도 파생 캐시 갱신 재료를 실어야 하고, 재초안이 오면 대체된다는 표식이 있어야 한다.
  const draft = host.events.find((e) => e.type === "DRAFT_RECEIVED");
  const payload = draft!.payload as { acceptanceCriteriaReplaces?: string };
  assert.equal(payload.acceptanceCriteriaReplaces, "draft_proposal");
});

test("재질문 뒤 새 초안이 오면 이전 초안의 기준은 대체되고 사용자 판정은 살아남는다", async () => {
  const { orchestrator, host } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [
        {
          kind: "draft",
          payload: {
            interpretation: "1차 해석",
            patch: VALID_PATCH,
            plan: [{ stepId: "s1", description: "고친다", targetPaths: [] }],
            risks: [],
            requiredTests: [],
            uncertainties: [],
            doneCriteria: ["1차 초안이 세운 기준"],
          },
        },
        {
          kind: "review",
          payload: { verdict: "NEED_USER_INPUT", rationale: "모호", questionsForUser: ["둘 중 뭡니까?"] },
        },
        {
          kind: "draft",
          payload: {
            interpretation: "2차 해석",
            patch: VALID_PATCH,
            plan: [{ stepId: "s1", description: "고친다", targetPaths: [] }],
            risks: [],
            requiredTests: [],
            uncertainties: [],
            doneCriteria: ["2차 초안이 세운 기준"],
          },
        },
        { kind: "review", payload: { verdict: "ACCEPT", rationale: "좋다" } },
      ],
    }
  );

  const promise = orchestrator.run();
  await waitFor(() => host.events.some((e) => e.type === "APPROVAL_REQUESTED_NOTE"));
  assert.ok(orchestrator.provideUserInput("후자입니다"));
  const result = await promise;
  assert.equal(result.status, "completed", result.summary);

  const criteria = result.acceptanceCriteria ?? [];
  const texts = criteria.map((c) => c.text);
  // 철회된 해석이 최종 보고에 남으면 아무도 지지하지 않는 기준을 사용자에게 보여주게 된다.
  assert.ok(!texts.includes("1차 초안이 세운 기준"), `철회된 기준이 남았습니다: ${texts.join(" / ")}`);
  assert.ok(texts.includes("2차 초안이 세운 기준"));
  // 모델 산출물이 사용자 판정을 덮지 않는다 — 권위가 다르다.
  assert.ok(texts.includes("후자입니다"));
});

test("최종 보고는 기준이 하나도 확인되지 않았음을 미확인으로 말한다 (통과로 위장하지 않는다)", async () => {
  const { result } = await runWithOneClarification("빈 문자열은 거부");

  assert.equal(result.status, "completed");
  assert.match(result.summary, /미확인/, `요약이 미확인을 말하지 않습니다: ${result.summary}`);
  // 확인된 개수는 이제 결정론적 판정에서 나온다(criteria.ts). 이 fixture의 기준은 어떤 테스트도
  // 지목하지 않으므로 0이어야 한다 — 0이 아니면 이을 근거 없이 확인을 만들어낸 것이다.
  assert.match(result.summary, /테스트로 확인 0개/, result.summary);
  const evaluations = result.criterionEvaluations ?? [];
  assert.equal(evaluations.length, (result.acceptanceCriteria ?? []).length, "기준마다 판정이 하나씩 있어야 합니다");
  assert.ok(
    evaluations.every((e) => e.status === "UNVERIFIED"),
    `이을 근거가 없는데 확인으로 판정됐습니다: ${JSON.stringify(evaluations)}`
  );
  // 판정에는 언제나 결정론적 근거 문장이 붙는다 — 화면의 물음표가 결함처럼 보이지 않도록.
  assert.ok(evaluations.every((e) => e.reason.trim().length > 0));
  // 확인 여부를 담는 필드 자체가 없어야 한다 — 필드가 있으면 언젠가 모델이 그걸 채우게 되고,
  // 그 순간 product-strategy.md 9절의 순환 의존이 재현된다.
  for (const criterion of result.acceptanceCriteria ?? []) {
    assert.deepEqual(
      Object.keys(criterion).sort(),
      ["criterionId", "decidedAt", "source", "text"],
      `기준에 예상 밖의 필드가 있습니다: ${JSON.stringify(criterion)}`
    );
  }
});

test("기준이 하나도 없으면 요약에 기준 문장을 넣지 않는다", async () => {
  // 없는 것을 "0개 확인됨"으로 말하면 있었는데 다 실패한 것처럼 읽힌다.
  const { orchestrator } = build(
    { verifyResults: [{ overall: "pass" }, { overall: "pass" }] },
    {
      defaultPatch: VALID_PATCH,
      script: [
        {
          kind: "draft",
          payload: {
            interpretation: "기준을 내지 않은 초안",
            patch: VALID_PATCH,
            plan: [{ stepId: "s1", description: "고친다", targetPaths: [] }],
            risks: [],
            requiredTests: [],
            uncertainties: [],
            doneCriteria: [],
          },
        },
      ],
    }
  );
  const result = await orchestrator.run();
  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.acceptanceCriteria, undefined);
  assert.doesNotMatch(result.summary, /미확인/, result.summary);
});
