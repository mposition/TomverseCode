import test from "node:test";
import assert from "node:assert/strict";
import type { ModelEntry } from "@tomverse/protocol";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { FakeProviderAdapter } from "../src/providers/fake.js";
import { GeminiAdapter } from "../src/providers/gemini.js";
import { OpenAIAdapter } from "../src/providers/openai.js";
import { ProviderCallFailure, type ProviderAdapter, type ProviderCallContext } from "../src/providers/types.js";
import { createAdapter, MissingCredentialError } from "../src/providers/factory.js";
import { BUILTIN_MODELS, providerKindOf } from "../src/routing/registry.js";
import { makeSnapshot } from "./helpers/fixtures.js";

/**
 * 어댑터 **적합성 스위트** — multi-engine-routing.md 12절.
 *
 * # 왜 필요한가
 *
 * 이 제품의 비교(대조·검수·가설 게이트)는 전부 **"어댑터는 서로 바꿔 끼울 수 있다"**는 전제
 * 위에 서 있다. 그런데 종전 어댑터 테스트는 공급자마다 따로 손으로 쓴 것이었다 —
 * "OpenAI usage 정규화"와 "Anthropic usage 정규화"가 서로 다른 것을 확인했다. 그러면 한쪽에만
 * 있는 규칙이 생겨도 아무 테스트도 실패하지 않는다.
 *
 * 실제로 그 방식으로 두 가지가 벌어져 있었다: `envelopeIdentity`가 두 파일에 **글자 그대로
 * 복사**되어 있었고, `estimatedInputTokens`를 붙일 때 두 어댑터를 손으로 똑같이 고쳐야 했다.
 * 둘 다 "한쪽만 고치면 조용히 갈라지는" 모양이다.
 *
 * 그래서 여기서는 **같은 표를 모든 어댑터에 돌린다.** 새 공급자를 추가하면 아래 `ADAPTERS`에
 * 한 줄을 넣게 되고, 계약을 만족하지 못하면 그 줄 때문에 실패한다.
 *
 * # 네트워크 없이 실제 어댑터를 태운다
 *
 * `fetch`를 주입해 SDK의 전송 계층만 바꾼다. 요청 조립·envelope 해석·정규화는 **프로덕션
 * 코드 그대로** 돈다. 이걸 안 하면 어댑터 본체는 유료 실행에서만 검증되고, 그 검증은 실패했을
 * 때 이미 돈을 쓴 뒤다.
 */

function entryFor(providerId: string, modelId: string): ModelEntry {
  return {
    modelId,
    providerId,
    protocol: "native",
    // 주입한 fetch가 받는 주소일 뿐 실제로 연결되지 않는다.
    apiBaseUrl: "https://conformance.invalid",
    apiKeyEnvName: "TOMVERSE_CONFORMANCE_KEY",
    capabilities: {
      toolCalling: "basic",
      structuredOutput: "strict_schema",
      imageInput: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    economics: { inputPerMTok: 1, outputPerMTok: 2, pricingAsOf: "2026-01-01" },
    availability: { requiresOrgVerification: false },
  };
}

/** 초안 하나. 어떤 공급자로 오든 같은 값이어야 한다. */
const DRAFT_PAYLOAD = {
  interpretation: "상수를 2로 바꾼다",
  patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
  plan: [{ stepId: "s1", description: "patch 적용", targetPaths: ["src/app.ts"] }],
  risks: [],
  requiredTests: [],
  uncertainties: [],
  doneCriteria: ["테스트 통과"],
};

interface Scripted {
  /** 응답 envelope이 말하는 모델. `null`이면 envelope에 model이 없는 공급자를 흉내낸다. */
  reportedModel?: string | null;
  status?: number;
  /** 구조화 출력을 빼고 응답한다 — 스키마 계약 위반 경로. */
  omitPayload?: boolean;
}

/** 한 공급자를 이 스위트가 다루기 위해 알아야 하는 것 전부. */
interface AdapterUnderTest {
  providerId: string;
  modelId: string;
  create(entry: ModelEntry, fetchImpl: typeof globalThis.fetch): ProviderAdapter;
  /** 이 공급자의 성공 응답 본문. `usage` 필드 이름이 공급자마다 다르므로 여기서만 갈린다. */
  body(script: Scripted, requestedModel: string): unknown;
}

const ADAPTERS: AdapterUnderTest[] = [
  {
    providerId: "openai",
    modelId: "gpt-conformance",
    create: (entry, fetchImpl) => new OpenAIAdapter({ entry, apiKey: "k", fetch: fetchImpl }),
    body: (script, requestedModel) => ({
      id: "resp_123",
      ...(script.reportedModel === null ? {} : { model: script.reportedModel ?? requestedModel }),
      output: script.omitPayload
        ? []
        : [{ content: [{ type: "output_text", text: JSON.stringify(DRAFT_PAYLOAD) }] }],
      usage: { input_tokens: 1_234, output_tokens: 56 },
    }),
  },
  {
    providerId: "anthropic",
    modelId: "claude-conformance",
    create: (entry, fetchImpl) => new AnthropicAdapter({ entry, apiKey: "k", fetch: fetchImpl }),
    body: (script, requestedModel) => ({
      id: "msg_123",
      type: "message",
      role: "assistant",
      ...(script.reportedModel === null ? {} : { model: script.reportedModel ?? requestedModel }),
      content: script.omitPayload
        ? [{ type: "text", text: "no tool call" }]
        : [{ type: "tool_use", id: "tu_1", name: "submit_draft", input: DRAFT_PAYLOAD }],
      usage: { input_tokens: 1_234, output_tokens: 56 },
    }),
  },
  {
    providerId: "google",
    modelId: "gemini-conformance",
    create: (entry, fetchImpl) => new GeminiAdapter({ entry, apiKey: "k", fetch: fetchImpl }),
    // Gemini는 세 가지를 **다른 이름으로** 준다: 본문은 candidates/parts/text,
    // 모델은 `modelVersion`(다른 둘은 `model`), 사용량은 `usageMetadata`.
    // 정규화가 한 군데라도 빠지면 이 표의 다른 검사들이 잡는다.
    body: (script, requestedModel) => ({
      responseId: "resp_gemini_123",
      ...(script.reportedModel === null ? {} : { modelVersion: script.reportedModel ?? requestedModel }),
      candidates: script.omitPayload
        ? [{ content: { parts: [] } }]
        : [{ content: { parts: [{ text: JSON.stringify(DRAFT_PAYLOAD) }] } }],
      usageMetadata: { promptTokenCount: 1_234, candidatesTokenCount: 56 },
    }),
  },
];

function stubFetch(target: AdapterUnderTest, script: Scripted): typeof globalThis.fetch {
  return (async () => {
    const status = script.status ?? 200;
    const body = status === 200 ? target.body(script, target.modelId) : { error: { message: "scripted failure" } };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function ctx(): ProviderCallContext {
  return { taskId: "task-1", callId: "draft:1", signal: new AbortController().signal, timeoutMs: 5_000 };
}

function draft(adapter: ProviderAdapter) {
  return adapter.generateDraft({ snapshot: makeSnapshot(), userMessage: "상수를 2로 고쳐줘" }, ctx());
}

for (const target of ADAPTERS) {
  const label = target.providerId;
  const entry = entryFor(target.providerId, target.modelId);

  /**
   * 성공 응답의 **모든 정규화 결과**가 공급자와 무관하게 같은 모양이어야 한다.
   * 하나라도 갈리면 그 위에 선 비교(대조·검수·게이트)가 공급자 차이를 모델 차이로 읽는다.
   */
  test(`[적합성/${label}] 성공 응답은 같은 모양으로 정규화된다`, async () => {
    const adapter = target.create(entry, stubFetch(target, {}));
    const response = await draft(adapter);

    assert.equal(adapter.providerId, target.providerId);
    assert.equal(adapter.modelId, target.modelId);
    // 값은 우리 검증기를 통과한 것이다 — 공급자 응답을 그대로 흘리지 않는다.
    assert.equal(response.value.interpretation, DRAFT_PAYLOAD.interpretation);
    assert.ok(response.value.patch?.includes("export const a = 2;"), "patch가 비었습니다");
    // usage는 공급자마다 필드 이름이 다르지만 **정규화된 이름과 수**는 같아야 한다.
    assert.deepEqual(response.usage, { inputTokens: 1_234, outputTokens: 56 });
    assert.ok(Number.isFinite(response.latencyMs) && response.latencyMs >= 0);
    // meta 계약.
    assert.equal(response.meta.requestedModelId, target.modelId);
    assert.equal(response.meta.providerReportedModelId, target.modelId);
    assert.equal(response.meta.dispatchState, "response_received_with_usage");
    assert.ok(
      (response.meta.estimatedInputTokens ?? 0) > 0,
      `입력 토큰 추정이 없습니다: ${JSON.stringify(response.meta)}`
    );
  });

  /**
   * **조용한 대체가 보여야 한다.** envelope이 다른 모델을 말하면 그대로 실어야 하고,
   * 우리가 요청한 값으로 덮으면 exact-model 검증이 언제나 통과한다(10.8절).
   */
  test(`[적합성/${label}] 응답 envelope의 모델을 그대로 싣는다`, async () => {
    const adapter = target.create(entry, stubFetch(target, { reportedModel: "substituted-model" }));
    const response = await draft(adapter);
    assert.equal(response.meta.providerReportedModelId, "substituted-model");
    assert.equal(response.meta.requestedModelId, target.modelId);
  });

  /** envelope에 모델이 없으면 **없는 채로 둔다.** 요청 ID로 채우면 모르는 것을 아는 것처럼 적는 것이다. */
  test(`[적합성/${label}] envelope에 모델이 없으면 요청 ID로 채우지 않는다`, async () => {
    const adapter = target.create(entry, stubFetch(target, { reportedModel: null }));
    const response = await draft(adapter);
    assert.equal(response.meta.providerReportedModelId, undefined);
  });

  /**
   * **응답을 받고 파싱에 실패한 것은 "요청이 안 나간 것"이 아니다.** 공급자는 이미 생성했고
   * 과금했을 수 있으므로, 예약을 해제하면 쓴 돈을 안 쓴 것으로 만든다(10.7절).
   */
  test(`[적합성/${label}] 구조화 출력이 없으면 과금 가능성을 실어 실패한다`, async () => {
    const adapter = target.create(entry, stubFetch(target, { omitPayload: true }));
    await assert.rejects(
      () => draft(adapter),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallFailure, `예상치 못한 오류 타입: ${error}`);
        assert.equal(error.dispatchState, "response_received_with_usage");
        return true;
      }
    );
  });

  /**
   * **자격증명 확인은 유료 호출을 하지 않는다** (17절). 여기서 확인하는 것은 결과 분류가
   * 공급자와 무관하게 같다는 것이다 — 같은 401이 한쪽에서는 `auth_failed`, 다른 쪽에서는
   * `unreachable`이면 화면이 사용자에게 다른 조치를 시킨다.
   */
  test(`[적합성/${label}] 자격증명 확인 결과를 같은 이름으로 분류한다`, async () => {
    const cases: [number, string][] = [
      [200, "listed"],
      [401, "auth_failed"],
      [403, "auth_failed"],
      [500, "unreachable"],
    ];
    for (const [status, expected] of cases) {
      const adapter = target.create(entry, stubFetch(target, { status }));
      const check = await adapter.checkCredential();
      assert.equal(check.status, expected, `${status} → ${check.status} (${check.detail})`);
      assert.equal(check.providerId, target.providerId);
      assert.equal(check.modelId, target.modelId);
    }
  });

  /**
   * **"조회된다"와 "호출된다"는 다른 사실이다.** 조직 인증이 필요한 모델은 조회되고 추론에서
   * 죽는다(gpt-5 사례). 성공 문구가 그 구별을 말하지 않으면 사용자는 확인을 보증으로 읽는다.
   */
  test(`[적합성/${label}] 확인 성공 문구가 보증으로 읽히지 않는다`, async () => {
    const adapter = target.create(entry, stubFetch(target, {}));
    const check = await adapter.checkCredential();
    assert.equal(check.status, "listed");
    assert.ok(check.detail.includes("조회"), check.detail);
    assert.ok(check.detail.includes("보장"), `한계를 말하지 않습니다: ${check.detail}`);
  });

  test(`[적합성/${label}] 전송과 무관한 계약`, () => {
    assertTransportIndependentContract(target.create(entry, stubFetch(target, {})), entry, label);
  });
}

/**
 * **fake도 같은 계약을 지켜야 한다.**
 *
 * e2e는 fake 위에서 돈다. fake의 계약이 실제 어댑터와 갈라지면 e2e가 통과해도 그 통과가
 * 실제 경로에 대해 아무것도 말하지 않는다. HTTP를 타지 않으므로 위 표에는 넣을 수 없지만,
 * 전송과 무관한 부분은 **같은 함수로** 확인한다.
 */
test("[적합성/fake] 전송과 무관한 계약", () => {
  const entry = entryFor("fake-a", "fake-executor");
  assertTransportIndependentContract(new FakeProviderAdapter({ entry, apiKey: "" }, {}), entry, "fake");
});

/**
 * 전송 계층을 타지 않는 계약 — 모든 어댑터(실제 + fake)가 지켜야 한다.
 *
 * 함수 하나로 두는 이유가 이 스위트의 요점이다: 공급자마다 손으로 쓴 테스트는 한쪽에만 있는
 * 규칙을 만들어내고, 그 규칙이 갈라져도 아무것도 실패하지 않는다.
 */
function assertTransportIndependentContract(adapter: ProviderAdapter, entry: ModelEntry, label: string): void {
  // ① 오류 분류가 공급자마다 다르면 재시도 정책이 공급자마다 달라지고, 그러면 비용과 지연의
  //    비교가 오염된다. 같은 상태 코드는 같은 분류여야 한다.
  const cases: [number, string, boolean][] = [
    [429, "rate_limit", true],
    [500, "transient", true],
    [401, "auth", false],
  ];
  for (const [status, kind, retryable] of cases) {
    const normalized = adapter.normalizeError(Object.assign(new Error("boom"), { status }));
    assert.equal(normalized.kind, kind, `${label}: ${status} → ${normalized.kind}`);
    assert.equal(normalized.retryable, retryable, `${label}: ${status} 재시도 가능성`);
  }

  // ② usage가 없는 응답을 `undefined`나 NaN으로 흘리면 비용 계산이 조용히 무의미해진다.
  assert.deepEqual(adapter.normalizeUsage(undefined), { inputTokens: 0, outputTokens: 0 }, label);
  assert.deepEqual(adapter.normalizeUsage({}), { inputTokens: 0, outputTokens: 0 }, label);

  // ③ 취소는 어느 시점에나 올 수 있다 — 호출 전에도 안전해야 한다.
  adapter.cancel();
  adapter.cancel();

  // ④ 보고하는 출력 상한과 **실제로 요청하는 값**이 달라지면 감사 기록이 실제를 설명하지 못한다.
  const caps = adapter.capabilities();
  assert.equal(caps.providerId, entry.providerId, label);
  assert.equal(caps.modelId, entry.modelId, label);
  assert.equal(caps.maxContextTokens, entry.capabilities.maxContextTokens, label);
  assert.ok(caps.maxOutputTokens <= entry.capabilities.maxOutputTokens, label);
}

/**
 * **이 스위트가 비어 있으면 안 된다.** 어댑터 목록이 실수로 줄면 위 테스트들이 전부 사라지고,
 * 그때 테스트 실행은 조용히 초록색이 된다 — 없는 테스트는 실패하지 않는다.
 */
test("[적합성] 실제 공급자 어댑터가 둘 이상 검사된다", () => {
  assert.ok(ADAPTERS.length >= 2, `검사된 어댑터: ${ADAPTERS.length}개`);
  assert.equal(new Set(ADAPTERS.map((a) => a.providerId)).size, ADAPTERS.length, "공급자가 중복됩니다");
});

// ---- 표에 넣는 것을 강제하는 장치 (multi-engine-routing.md 12절) ----

/**
 * 표가 덮지 못한 실제 공급자.
 *
 * 위 스위트에는 **조용한 구멍**이 하나 있었다: 새 공급자를 추가할 때 `ADAPTERS`에 줄을
 * 넣는 것을 강제하는 것이 없었다. 넣지 않으면 그 어댑터에 대해서는 아무 테스트도 돌지 않고,
 * **없는 테스트는 실패하지 않으므로** 실행 결과는 조용히 초록색이다. 루트 `test`에서
 * 워크스페이스가 빠지던 것과 같은 모양이고, 거기서와 같은 방식으로 막는다 —
 * 사람이 지키는 규칙이 아니라 **다른 목록에서 유도한 대조**로.
 *
 * 유도의 출발점을 레지스트리로 잡은 이유: 제품이 실제로 호출하는 공급자의 정본이 거기다.
 * 어댑터 파일이 있어도 레지스트리에 없으면 호출되지 않고, 레지스트리에 있으면 반드시
 * 호출된다. `providerKindOf`를 쓰는 것도 같은 이유다 — `local://` 규칙을 여기 복사하면
 * 그 규칙이 바뀔 때 둘이 갈라진다.
 */
function uncoveredProviders(entries: readonly ModelEntry[], covered: ReadonlySet<string>): string[] {
  const real = entries.filter((e) => providerKindOf(e) === "real").map((e) => e.providerId);
  return [...new Set(real)].filter((p) => !covered.has(p)).sort();
}

test("[적합성] 레지스트리의 실제 공급자가 전부 이 표에 있다", () => {
  const real = BUILTIN_MODELS.filter((e) => providerKindOf(e) === "real");
  // 빈 집합에 대해 통과하는 검사를 허용하지 않는다 — 레지스트리를 잘못 읽으면
  // "빠진 공급자 없음"과 "공급자 없음"이 같은 초록색으로 보인다.
  assert.ok(real.length > 0, "레지스트리에서 실제 공급자를 하나도 찾지 못했습니다");
  const missing = uncoveredProviders(BUILTIN_MODELS, new Set(ADAPTERS.map((a) => a.providerId)));
  assert.deepEqual(
    missing,
    [],
    `적합성 표에 없는 공급자: ${missing.join(", ")} — conformance.test.ts의 ADAPTERS에 줄을 추가하세요`
  );
});

/**
 * **위 검사가 실제로 무언가를 잡는지 확인한다.** 대조 검사는 대조 대상이 비거나 비교가
 * 어긋나면 언제나 통과하는 방식으로 고장 나고, 그 고장은 초록색으로 보인다.
 */
test("[적합성] 표에 없는 공급자가 생기면 위 검사가 잡는다", () => {
  // **표에 이미 있는 공급자를 쓰면 안 된다.** 예전에는 `google`을 썼는데 실제로 google
  // 어댑터가 생기면서 이 검사가 "빠진 것 없음"으로 조용히 통과하게 됐다 — 공허성 검사가
  // 공허해지는 정확한 방식이다. 표에 없는 이름을 고르고, 그 사실을 먼저 확인한다.
  const covered = new Set(ADAPTERS.map((a) => a.providerId));
  const hypothetical = "not-a-real-provider";
  assert.ok(!covered.has(hypothetical), `${hypothetical}가 이미 표에 있어 이 검사가 공허합니다`);
  const newcomer = entryFor(hypothetical, "hypothetical-model");
  const missing = uncoveredProviders([...BUILTIN_MODELS, newcomer], covered);
  assert.deepEqual(missing, [hypothetical]);
  // fake 공급자는 실전 어댑터가 아니므로 요구하지 않는다 — 요구하면 표가
  // 검사할 수 없는 것(로컬 스크립트)까지 떠안는다.
  const fake = BUILTIN_MODELS.filter((e) => providerKindOf(e) === "fake");
  assert.ok(fake.length > 0, "레지스트리에 fake 공급자가 없어 이 구별을 확인할 수 없습니다");
  assert.deepEqual(uncoveredProviders(fake, new Set()), []);
});

/**
 * 표에 있는 것만으로는 부족하다 — **팩토리가 그 공급자를 만들 수 있어야** 한다.
 *
 * 레지스트리에 엔트리를 넣고 `createAdapter`의 분기를 빠뜨리면 실행 시점에야
 * "어댑터가 아직 없습니다"로 죽는다. 그 시점은 사용자가 그 모델을 고른 뒤이고,
 * 라우터는 그 모델을 **고를 수 있는 것으로 이미 보여준 뒤**다.
 */
test("[적합성] 레지스트리의 실제 공급자는 팩토리가 어댑터를 만들 수 있다", () => {
  const real = BUILTIN_MODELS.filter((e) => providerKindOf(e) === "real");
  assert.ok(real.length > 0, "레지스트리에서 실제 공급자를 하나도 찾지 못했습니다");
  for (const entry of real) {
    const assignment = {
      role: "executor" as const,
      modelId: entry.modelId,
      providerId: entry.providerId,
      reason: "적합성 검사",
    };
    // 자격증명은 **주입한 환경변수에서만** 읽는다. process.env를 쓰면 개발 머신에 키가
    // 있는지 여부에 따라 결과가 달라진다 — 그건 이 검사가 답해야 할 질문이 아니다.
    const adapter = createAdapter(entry, assignment, { env: { [entry.apiKeyEnvName]: "conformance" } });
    assert.equal(adapter.capabilities().providerId, entry.providerId, entry.modelId);
    assert.equal(adapter.capabilities().modelId, entry.modelId, entry.modelId);
  }
});

/** 자격증명이 없으면 **만들기 전에** 거부한다 — 키 없이 만들어진 어댑터는 호출 때 죽는다. */
test("[적합성] 자격증명이 없으면 어댑터를 만들지 않는다", () => {
  const entry = BUILTIN_MODELS.find((e) => providerKindOf(e) === "real");
  assert.ok(entry, "실제 공급자 엔트리가 없습니다");
  assert.throws(
    () =>
      createAdapter(
        entry,
        { role: "executor", modelId: entry.modelId, providerId: entry.providerId, reason: "적합성 검사" },
        { env: {} }
      ),
    MissingCredentialError
  );
});
