import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, validateDraftProposal, validateReviewDecision, validateSingleModelFixResult } from "@tomverse/protocol";
import { FakeProviderAdapter } from "../src/providers/fake.js";
import { normalizeProviderError } from "../src/providers/errors.js";
import { backoffDelayMs, callWithRetry, DEFAULT_RETRY_POLICY, ProviderCallFailed, withTimeout } from "../src/providers/retry.js";
import { OpenAIAdapter } from "../src/providers/openai.js";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import {
  buildDraftPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  DRAFT_SCHEMA,
  REVIEW_SCHEMA,
  SINGLE_FIX_SCHEMA,
} from "../src/providers/prompts.js";
import { BUILTIN_MODELS, ModelRegistry } from "../src/routing/registry.js";
import { makeSnapshot } from "./helpers/fixtures.js";
import type { ProviderCallContext } from "../src/providers/types.js";

const registry = new ModelRegistry();
const fakeEntry = registry.get("fake-executor")!;

function ctx(overrides: Partial<ProviderCallContext> = {}): ProviderCallContext {
  return {
    taskId: "task-1",
    callId: "draft:1",
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    ...overrides,
  };
}

// ---- 런타임 검증 (LLM 출력을 신뢰하지 않는다) ----

test("DraftProposal 검증: 필수 필드가 없으면 거부한다", () => {
  const meta = { taskId: "t", proposalId: "p", model: "m", createdAt: "now", reviewMode: "informed" as const };
  assert.throws(() => validateDraftProposal({}, meta), ValidationError);
  assert.throws(() => validateDraftProposal({ interpretation: "" }, meta), ValidationError);
  // 타입이 틀린 경우도 거부한다 — 모델이 스키마를 어길 수 있다.
  assert.throws(() => validateDraftProposal({ interpretation: 42 }, meta), ValidationError);
  assert.throws(() => validateDraftProposal({ interpretation: "ok", risks: "not an array" }, meta), ValidationError);
});

test("DraftProposal 검증: 최소 형태를 통과시키고 기본값을 채운다", () => {
  const draft = validateDraftProposal(
    { interpretation: "루트 원인은 오프바이원" },
    { taskId: "t", proposalId: "p", model: "m", createdAt: "now" }
  );
  assert.equal(draft.interpretation, "루트 원인은 오프바이원");
  assert.deepEqual(draft.risks, []);
  assert.deepEqual(draft.plan, []);
});

test("ReviewDecision 검증: 알 수 없는 verdict를 거부한다", () => {
  const meta = { taskId: "t", proposalId: "p", model: "m", createdAt: "now", reviewMode: "informed" as const };
  assert.throws(
    () => validateReviewDecision({ verdict: "LOOKS_GOOD_TO_ME", rationale: "ok" }, meta),
    ValidationError
  );
});

test("NEED_USER_INPUT인데 질문이 없으면 거부한다", () => {
  // 통과시키면 사용자에게 빈 확인 카드를 보여주게 된다.
  const meta = { taskId: "t", proposalId: "p", model: "m", createdAt: "now", reviewMode: "informed" as const };
  assert.throws(
    () => validateReviewDecision({ verdict: "NEED_USER_INPUT", rationale: "모호함" }, meta),
    ValidationError
  );
  assert.throws(
    () => validateReviewDecision({ verdict: "NEED_USER_INPUT", rationale: "모호함", questionsForUser: [] }, meta),
    ValidationError
  );
});

test("SingleModelFixResult는 REVISE를 받지 않는다", () => {
  // 4b절: 검토할 초안이 없으므로 "수정 요청"이 성립하지 않는다.
  assert.throws(
    () =>
      validateSingleModelFixResult(
        { verdict: "REVISE", rationale: "고쳐줘" },
        { taskId: "t", model: "m", createdAt: "now" }
      ),
    ValidationError
  );
});

test("SingleModelFixResult ACCEPT는 적용할 변경을 요구한다", () => {
  assert.throws(
    () =>
      validateSingleModelFixResult(
        { verdict: "ACCEPT", rationale: "고쳤음" },
        { taskId: "t", model: "m", createdAt: "now" }
      ),
    ValidationError
  );
});

/**
 * **삭제만 있는 응답도 성립한다** — state-machine 45절.
 *
 * "이 파일을 지워라"는 patch 없이 완결되는 요구다. 종전 조건(`ACCEPT`면 patch가 있어야 한다)을
 * 그대로 뒀다면 그 요구는 모델이 무엇을 내든 검증 단계에서 죽고, 증상은 "모델이 잘못된 응답을
 * 냈다"로 보인다.
 */
test("SingleModelFixResult ACCEPT는 삭제만 있어도 성립한다", () => {
  const result = validateSingleModelFixResult(
    { verdict: "ACCEPT", rationale: "안 쓰는 파일이다", deletions: ["src/old.ts"] },
    { taskId: "t", model: "m", createdAt: "now" }
  );
  assert.deepEqual(result.deletions, ["src/old.ts"]);
  assert.equal(result.patch, undefined);
});

/**
 * **중복을 조용히 합치지 않는다.** 같은 경로가 두 번 오면 두 번째는 게이트에서 거부되고,
 * 프리플라이트가 거부하면 계획 전체가 서지 않는다(42절) — 중복 하나가 나머지 멀쩡한 삭제까지
 * 없앤다. 합쳐서 넘기면 모델은 자기가 같은 파일을 두 번 지우라고 했다는 것을 배우지 못한다.
 */
test("초안의 중복 삭제 경로는 거부된다", () => {
  const meta = { taskId: "t", proposalId: "p", model: "m", createdAt: "now" };
  assert.throws(
    () => validateDraftProposal({ interpretation: "정리", deletions: ["a.ts", "a.ts"] }, meta),
    ValidationError
  );
  // 형태가 아닌 값의 문제이므로 배열이 아닌 것도 같은 자리에서 거부한다.
  assert.throws(() => validateDraftProposal({ interpretation: "정리", deletions: "a.ts" }, meta), ValidationError);
});

test("fake 공급자도 실제 어댑터와 같은 검증을 통과한다", async () => {
  // 검증을 건너뛰는 fake는 우리 검증 코드가 동작하는지 테스트하지 못한다.
  const adapter = new FakeProviderAdapter(
    { entry: fakeEntry, apiKey: "" },
    { script: [{ kind: "draft", payload: { interpretation: 123 } }] }
  );
  await assert.rejects(
    () => adapter.generateDraft({ snapshot: makeSnapshot(), userMessage: "fix" }, ctx()),
    ValidationError
  );
});

// ---- 오류 분류 ----

test("오류 분류: 429는 rate_limit이고 재시도 대상이다", () => {
  const error = normalizeProviderError({ status: 429, message: "Too many requests" });
  assert.equal(error.kind, "rate_limit");
  assert.equal(error.retryable, true);
});

test("오류 분류: Retry-After 헤더를 존중한다", () => {
  const error = normalizeProviderError({ status: 429, message: "slow down", headers: { "retry-after": "5" } });
  assert.equal(error.retryAfterMs, 5_000);
  assert.equal(backoffDelayMs(error, 1, DEFAULT_RETRY_POLICY), 5_000);
});

test("오류 분류: 5xx는 transient, 401은 auth(재시도 불가)", () => {
  assert.equal(normalizeProviderError({ status: 503, message: "unavailable" }).kind, "transient");
  const auth = normalizeProviderError({ status: 401, message: "invalid api key" });
  assert.equal(auth.kind, "auth");
  assert.equal(auth.retryable, false);
});

test("오류 분류: 모델 미지원을 인증 실패와 구별한다", () => {
  // gpt-5 사건: 키는 유효하지만 조직 인증이 없어 그 모델을 못 쓴다. 사용자가 할 일이 다르다.
  const notFound = normalizeProviderError({ status: 404, message: "The model `gpt-5` does not exist" });
  assert.equal(notFound.kind, "model_unavailable");
  assert.equal(notFound.retryable, false);

  const orgVerify = normalizeProviderError({
    status: 403,
    message: "Your organization must be verified to use the model gpt-5",
  });
  assert.equal(orgVerify.kind, "model_unavailable");
});

test("오류 분류: 스키마 위반을 별도로 센다", () => {
  assert.equal(normalizeProviderError({ status: 400, message: "invalid json schema" }).kind, "schema_violation");
});

test("오류 분류: 취소는 재시도하지 않는다", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const normalized = normalizeProviderError(abort);
  assert.equal(normalized.kind, "cancelled");
  assert.equal(normalized.retryable, false);
});

test("오류 분류: 알 수 없는 오류는 재시도하지 않는다", () => {
  // "모르면 transient"로 두면 알 수 없는 오류에 비용만 쓴다.
  const normalized = normalizeProviderError(new Error("무슨 일이 일어났는지 모르겠음"));
  assert.equal(normalized.retryable, false);
});

// ---- 재시도 상한 ----

test("재시도 상한을 초과하면 exhausted로 실패한다", async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(
    () =>
      callWithRetry(
        async () => {
          calls += 1;
          throw { status: 503, message: "unavailable" };
        },
        { ...DEFAULT_RETRY_POLICY, maxRetries: 3 },
        { sleep: async (ms) => void delays.push(ms) }
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCallFailed);
      assert.equal(error.exhausted, true);
      assert.equal(error.normalized.kind, "transient");
      return true;
    }
  );
  // 첫 시도 + 재시도 3회 = 4회. 상한을 넘어 무한히 도는 일이 없어야 한다.
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
});

test("재시도 불가 오류는 즉시 실패한다", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      callWithRetry(
        async () => {
          calls += 1;
          throw { status: 401, message: "bad key" };
        },
        DEFAULT_RETRY_POLICY,
        { sleep: async () => undefined }
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCallFailed);
      assert.equal(error.exhausted, false);
      return true;
    }
  );
  assert.equal(calls, 1, "인증 오류는 재시도하지 않아야 합니다");
});

test("재시도 후 성공하면 시도 횟수를 보고한다", async () => {
  let calls = 0;
  const result = await callWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw { status: 429, message: "rate limited" };
      return "성공";
    },
    DEFAULT_RETRY_POLICY,
    { sleep: async () => undefined }
  );
  assert.equal(result.value, "성공");
  assert.equal(result.attempts, 3);
});

test("백오프는 상한(cap)을 넘지 않는다", () => {
  const error = normalizeProviderError({ status: 429, message: "x" });
  const delay = backoffDelayMs(error, 20, DEFAULT_RETRY_POLICY);
  assert.equal(delay, DEFAULT_RETRY_POLICY.rateLimitCapMs);
});

// ---- 취소 ----

test("취소 신호가 진행 중인 공급자 호출을 중단한다", async () => {
  const controller = new AbortController();
  const adapter = new FakeProviderAdapter(
    { entry: fakeEntry, apiKey: "" },
    { script: [{ kind: "draft", delayMs: 5_000 }] }
  );
  const promise = adapter.generateDraft({ snapshot: makeSnapshot(), userMessage: "fix" }, ctx({ signal: controller.signal }));
  controller.abort(new Error("사용자 취소"));
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(normalizeProviderError(error).kind, "cancelled");
    return true;
  });
});

test("adapter.cancel()이 이후 호출을 막는다", async () => {
  const adapter = new FakeProviderAdapter({ entry: fakeEntry, apiKey: "" });
  adapter.cancel();
  await assert.rejects(() => adapter.generateDraft({ snapshot: makeSnapshot(), userMessage: "fix" }, ctx()));
});

test("withTimeout은 부모 취소와 자체 타임아웃을 모두 전달한다", async () => {
  const parent = new AbortController();
  const scoped = withTimeout(parent.signal, 10_000);
  assert.equal(scoped.signal.aborted, false);
  parent.abort(new Error("부모 취소"));
  assert.equal(scoped.signal.aborted, true);
  scoped.dispose();

  const parent2 = new AbortController();
  const scoped2 = withTimeout(parent2.signal, 20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(scoped2.signal.aborted, true, "자체 타임아웃이 걸려야 합니다");
  scoped2.dispose();
});

// ---- usage 정규화 ----

test("OpenAI usage 정규화: input_tokens/prompt_tokens 양쪽을 받는다", () => {
  const entry = registry.get("gpt-4.1")!;
  const adapter = new OpenAIAdapter({ entry, apiKey: "sk-test" });
  assert.deepEqual(adapter.normalizeUsage({ input_tokens: 100, output_tokens: 20 }), {
    inputTokens: 100,
    outputTokens: 20,
  });
  assert.deepEqual(adapter.normalizeUsage({ prompt_tokens: 7, completion_tokens: 3 }), {
    inputTokens: 7,
    outputTokens: 3,
  });
  // usage가 없으면 0으로 정규화한다 — undefined를 그대로 흘리면 비용 계산이 NaN이 된다.
  assert.deepEqual(adapter.normalizeUsage(undefined), { inputTokens: 0, outputTokens: 0 });
});

test("Anthropic usage 정규화", () => {
  const entry = registry.get("claude-sonnet-5")!;
  const adapter = new AnthropicAdapter({ entry, apiKey: "sk-test" });
  assert.deepEqual(adapter.normalizeUsage({ input_tokens: 55, output_tokens: 11 }), {
    inputTokens: 55,
    outputTokens: 11,
  });
});

test("레지스트리 비용 계산이 가격 스냅샷을 쓴다", () => {
  const cost = registry.costUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(cost, 2.0);
  // 알 수 없는 모델은 0이 아니라 undefined — 0으로 위장하면 비용 표시가 거짓이 된다.
  assert.equal(registry.costUsd("no-such-model", { inputTokens: 100, outputTokens: 100 }), undefined);
});

test("모든 레지스트리 엔트리에 가격 기준일이 있다", () => {
  // 가격은 빠르게 낡는다 — 언제 기준인지 없으면 비용 표시를 신뢰할 수 없다.
  for (const entry of BUILTIN_MODELS) {
    assert.ok(entry.economics.pricingAsOf.length > 0, `${entry.modelId}에 pricingAsOf가 없습니다`);
    assert.ok(entry.apiKeyEnvName.length > 0, `${entry.modelId}에 apiKeyEnvName이 없습니다`);
  }
});

test("레지스트리는 API 키 값을 담지 않는다", () => {
  // 환경변수 **이름**만 있어야 한다 — 레지스트리를 로그로 찍어도 키가 새지 않아야 한다.
  const serialized = JSON.stringify(BUILTIN_MODELS);
  assert.ok(!serialized.includes("sk-"), "레지스트리에 키처럼 보이는 값이 있습니다");
  for (const entry of BUILTIN_MODELS) {
    assert.ok(/^[A-Z0-9_]+$/.test(entry.apiKeyEnvName), `${entry.apiKeyEnvName}는 환경변수 이름 형태여야 합니다`);
  }
});

/**
 * **게이트 거부 사유가 실제로 프롬프트에 실린다** — state-machine 42절.
 *
 * 이게 없으면 되돌리기가 눈을 가린 채로 돈다: 모델은 자기 계획이 거부됐다는 것도, 왜인지도
 * 모른 채 같은 것을 다시 그린다. 그리고 그 공허함은 **아무 테스트도 깨뜨리지 않는다** —
 * 프롬프트에서 그 문단을 지워도 오케스트레이터 검사는 전부 통과했다(실측).
 */
test("게이트 거부 사유가 프롬프트에 실리고, 기준 충돌과 다른 문단으로 간다", () => {
  const base = {
    snapshot: makeSnapshot(),
    userMessage: "고쳐주세요",
  };
  const withGate = buildDraftPrompt({ ...base, gateFeedback: ["run_command: 인자에 && 가 있습니다"] });
  assert.ok(withGate.includes("인자에 && 가 있습니다"), withGate);
  // **적용된 것이 없다는 사실**을 말한다 — FIX_LOOP처럼 읽히면 모델이 없는 변경을 되돌리려 한다.
  assert.ok(withGate.includes("Nothing has been applied"), withGate);

  // 없으면 그 문단도 없다 — 빈 문단이 남으면 모델에게 잡음이다.
  const without = buildDraftPrompt(base);
  assert.ok(!without.includes("refused by the policy gate"), without);

  // 기준 충돌과 **다른 문단**이다. 모델이 고쳐야 할 것이 다르기 때문이다.
  const both = buildDraftPrompt({
    ...base,
    criteriaFeedback: ["기준과 어긋납니다"],
    gateFeedback: ["게이트가 거부했습니다"],
  });
  assert.ok(both.includes("rejected before it was applied"), both);
  assert.ok(both.includes("refused by the policy gate"), both);
});

/**
 * **문을 만들었으면 걸어 들어가는 길도 있어야 한다** — state-machine 31절의 교훈, 44절에 적용.
 *
 * `moves` 필드를 만들어도 프롬프트가 말하지 않으면 모델은 그것을 채우지 않는다. 그리고 그
 * 공허함은 **아무 테스트도 깨뜨리지 않는다** — 지워 보니 오케스트레이터 검사가 전부
 * 통과했다(실측). 이름 바꾸기는 다시 파일 전체를 실어 보내는 일로 돌아간다.
 */
test("프롬프트가 파일 이동을 요청하는 방법을 말한다", () => {
  const prompt = buildDraftPrompt({ snapshot: makeSnapshot(), userMessage: "파일 이름을 바꿔주세요" });
  assert.ok(prompt.includes("`moves`"), prompt);
  // **순서까지 말한다.** 이동이 patch보다 먼저 돌므로 patch는 옮긴 뒤 경로 기준이어야 한다.
  assert.ok(prompt.includes("then moves, then the patch"), prompt);
  // 지우고 다시 만들지 말라고 명시한다 — 그게 이 필드가 없앨 낭비다.
  assert.ok(prompt.toLowerCase().includes("delete-and-recreate"), prompt);
});

/**
 * **문을 두 번 만들었으면 길도 두 번 만든다** — 44.7절의 교훈, 45절에 적용.
 *
 * 삭제도 같다. 프롬프트가 `deletions`를 말하지 않으면 모델은 파일을 지우려고 전체를 `-`로
 * 실어 보내거나(그건 파일을 비우는 것이지 지우는 것이 아니다) 계획 문장에만 적는다 —
 * 둘 다 아무 파일도 지우지 못하고, **그 공허함은 아무 테스트도 깨뜨리지 않는다.**
 */
test("프롬프트가 파일 삭제를 요청하는 방법을 말한다", () => {
  const prompt = buildDraftPrompt({ snapshot: makeSnapshot(), userMessage: "안 쓰는 파일을 지워주세요" });
  assert.ok(prompt.includes("`deletions`"), prompt);
  // patch로 비우는 것과 지우는 것이 다르다는 것을 말한다.
  assert.ok(prompt.toLowerCase().includes("blank it out"), prompt);
  // **삭제가 이동보다 먼저**라는 것도 말한다 — 지운 자리로 옮기는 것이 성립하려면 그 순서여야 한다.
  assert.ok(prompt.includes("Deletions run first"), prompt);
  // **patch가 비어도 된다**는 것을 말하지 않으면 삭제만 하는 요구에 모델이 억지 patch를 짓는다.
  assert.ok(prompt.includes("leave `patch` empty"), prompt);
});

/**
 * **스키마가 진짜 문이다** — state-machine 46절.
 *
 * 44·45절은 `moves`/`deletions` 필드를 만들고 프롬프트에 쓰는 법까지 적었는데
 * `DRAFT_SCHEMA`에 넣지 않았다. 그 스키마는 `strict: true` + `additionalProperties: false`로
 * 세 어댑터(OpenAI/Anthropic/Gemini) 모두가 쓰므로, **그 이름의 속성은 아예 나올 수
 * 없었다.** 프롬프트가 "`moves` 배열에 넣어라"고 말하는 동안 스키마는 그것을 금지하고 있었다.
 *
 * fake 공급자는 스키마를 지나지 않으므로 340개 테스트가 전부 통과했다.
 *
 * # 판정 기준은 손으로 적은 필드 목록이 아니다
 *
 * 목록을 여기 적으면 다음 필드가 늘 때 같은 일이 반복된다. **프롬프트가 실제로 말하는
 * 필드 이름**(규칙 문단의 백틱 안 식별자)을 뽑아 스키마 속성과 대조한다.
 */

/** 규칙 문단에서 백틱으로 감싼 **식별자**만 뽑는다. `@@ …`나 `{from, to}`는 이름이 아니다. */
function fieldNamesMentionedIn(rules: string): string[] {
  const names = new Set<string>();
  for (const m of rules.matchAll(/`([^`]+)`/g)) {
    const token = (m[1] ?? "").trim();
    if (/^[a-z][A-Za-z0-9]*$/.test(token)) names.add(token);
  }
  return [...names];
}

/** 프롬프트에서 규칙 문단만 잘라낸다 — 스냅샷 본문의 백틱을 세지 않기 위해서다. */
function rulesSectionOf(prompt: string, heading: string): string {
  const at = prompt.indexOf(`## ${heading}`);
  assert.notEqual(at, -1, `${heading} 문단을 찾지 못했습니다`);
  return prompt.slice(at);
}

test("프롬프트가 채우라고 말하는 필드는 전부 응답 스키마에 있다", () => {
  const snapshot = makeSnapshot();
  const draft = {
    taskId: "t",
    proposalId: "p",
    interpretation: "고친다",
    relevantFiles: [],
    plan: [],
    patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-1\n+2\n",
    moves: [{ from: "src/app.ts", to: "src/renamed.ts" }],
    deletions: ["src/gone.ts"],
    risks: [],
    requiredTests: [],
    uncertainties: [],
    doneCriteria: [],
    model: "m",
    createdAt: "now",
  };

  const cases = [
    {
      what: "draft",
      rules: rulesSectionOf(buildDraftPrompt({ snapshot, userMessage: "고쳐주세요" }), "Output rules"),
      schema: DRAFT_SCHEMA,
    },
    {
      what: "review",
      rules: rulesSectionOf(buildReviewPrompt({ snapshot, userMessage: "고쳐주세요", draft }), "Verdict rules"),
      schema: REVIEW_SCHEMA,
    },
    {
      what: "fix",
      rules: rulesSectionOf(
        buildFixPrompt({
          snapshot,
          userMessage: "고쳐주세요",
          appliedChanges: "src/app.ts (12 bytes)",
          digest: {
            taskId: "t",
            reportId: "r",
            attemptNumber: 1,
            failingChecks: [{ kind: "test", excerpt: "1 failing", fileReferences: [] }],
            passingChecksSummary: "build ok",
          },
        }),
        "Output rules"
      ),
      schema: SINGLE_FIX_SCHEMA,
    },
  ];

  for (const c of cases) {
    const mentioned = fieldNamesMentionedIn(c.rules);
    // **빈 집합에 대한 전칭 명제는 언제나 참이다** — 무엇을 셌는지 먼저 확인한다.
    assert.ok(mentioned.length >= 2, `${c.what}: 규칙에서 필드 이름을 ${mentioned.length}개만 찾았습니다`);
    const properties = Object.keys(c.schema.properties as Record<string, unknown>);
    const missing = mentioned.filter((name) => !properties.includes(name));
    assert.deepEqual(
      missing,
      [],
      `${c.what} 프롬프트가 채우라고 말하지만 스키마에 없는 필드: ${missing.join(", ")}. ` +
        `strict 스키마에서는 그 이름의 속성이 아예 나올 수 없습니다.`
    );
  }
});

/**
 * **검수자는 실행될 것을 본다** — 46절.
 *
 * 종전 검수 프롬프트는 `patch`만 보여줬다. 이동과 삭제는 검수자가 보지 못한 채 실행됐고,
 * 그래서 `REVIEW_RECEIVED`의 "검수자가 수락했다"는 **다른 제안에 대한 수락**이었다.
 */
test("검수 프롬프트가 초안의 이동과 삭제를 보여준다", () => {
  const snapshot = makeSnapshot();
  const base = {
    taskId: "t",
    proposalId: "p",
    interpretation: "이름을 바꾼다",
    relevantFiles: [],
    plan: [],
    patch: "--- a/src/renamed.ts\n+++ b/src/renamed.ts\n@@ -1,1 +1,1 @@\n-1\n+2\n",
    risks: [],
    requiredTests: [],
    uncertainties: [],
    doneCriteria: [],
    model: "m",
    createdAt: "now",
  };
  const draft = { ...base, moves: [{ from: "src/app.ts", to: "src/renamed.ts" }], deletions: ["src/gone.ts"] };

  for (const blind of [false, true]) {
    // **blind에서도 숨기지 않는다.** Blind가 숨기는 것은 작성자의 자기설명이지 제안 자체가 아니다.
    const prompt = buildReviewPrompt({ snapshot, userMessage: "정리해줘", draft, blind });
    assert.ok(prompt.includes("src/app.ts → src/renamed.ts"), `blind=${blind}: ${prompt}`);
    assert.ok(prompt.includes("delete: src/gone.ts"), `blind=${blind}`);
    // **옳은 초안을 엉뚱한 이유로 거부하지 않게 하는 문장.** patch가 가리키는 새 경로는
    // Files 섹션에 없는데, 출력 규칙은 "Files 섹션에 있는 파일만"이라고 말한다.
    assert.ok(prompt.includes("that is expected, not an error"), `blind=${blind}`);
  }

  // 조작이 없으면 **없다고 말한다.** 섹션을 빼면 "없다"와 "안 보여줬다"가 같아진다.
  const plain = buildReviewPrompt({ snapshot, userMessage: "고쳐줘", draft: base });
  assert.ok(plain.includes("File operations requested outside the patch"), plain);
  assert.ok(plain.includes("(none — the patch is the whole change)"), plain);
});
