import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, validateDraftProposal, validateReviewDecision, validateSingleModelFixResult } from "@tomverse/protocol";
import { FakeProviderAdapter } from "../src/providers/fake.js";
import { normalizeProviderError } from "../src/providers/errors.js";
import { backoffDelayMs, callWithRetry, DEFAULT_RETRY_POLICY, ProviderCallFailed, withTimeout } from "../src/providers/retry.js";
import { DRAFT_SCHEMA_STRICT, decodeMcpArguments, OpenAIAdapter } from "../src/providers/openai.js";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { ProviderCallFailure, validateReceived } from "../src/providers/types.js";
import {
  buildDraftPrompt,
  buildFixPrompt,
  buildPlanPrompt,
  buildQuestionPrompt,
  buildReviewPrompt,
  DRAFT_SCHEMA,
  PLAN_SCHEMA,
  QUESTION_SCHEMA,
  REVIEW_SCHEMA,
  SINGLE_FIX_SCHEMA,
} from "../src/providers/prompts.js";
import { BUILTIN_MODELS, ModelRegistry } from "../src/routing/registry.js";
import { makeRelevantFile, makeSnapshot } from "./helpers/fixtures.js";
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

/**
 * 스키마에 나오는 **모든** 속성 이름 — 중첩된 객체와 배열 item까지.
 *
 * 얕게 보면 배열 안의 속성을 "스키마에 없다"고 읽는다. 그 오판의 방향이 나쁘다: 검사가
 * 없는 결함을 보고하면 사람이 검사를 고치는 대신 **검사를 약하게 만든다.**
 */
function allPropertyNames(schema: unknown): string[] {
  const out = new Set<string>();
  const walk = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const props = obj.properties;
    if (props !== null && typeof props === "object") {
      for (const [name, child] of Object.entries(props as Record<string, unknown>)) {
        out.add(name);
        walk(child);
      }
    }
    if (obj.items !== undefined) walk(obj.items);
  };
  walk(schema);
  return [...out];
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
      what: "question",
      rules: rulesSectionOf(buildQuestionPrompt({ snapshot, userMessage: "왜 이렇습니까?" }), "Answer rules"),
      schema: QUESTION_SCHEMA,
    },
    {
      what: "plan",
      rules: rulesSectionOf(buildPlanPrompt({ snapshot, userMessage: "리팩터링하고 싶습니다" }), "Plan rules"),
      schema: PLAN_SCHEMA,
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
    // **중첩된 스키마까지 훑는다**(53절). 종전에는 최상위 `properties`만 봤고, 그래서
    // 배열 item 안의 속성을 규칙이 이름으로 부르면 "스키마에 없다"고 거짓 실패했다 —
    // 계획 스키마의 `steps[].intent`가 첫 사례다. 얕게 보는 검사는 스키마가 깊어지는 순간
    // **틀린 쪽으로** 틀린다: 있는 것을 없다고 한다.
    const properties = allPropertyNames(c.schema);
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

/**
 * **잘라 넣었으면 어디를 실었는지 모델에게 말한다** — context-engine 14절.
 *
 * 종전 문구는 "이 파일은 잘렸다"뿐이었다. 창 방식으로 바뀌면 그 문장이 부족하다 — 모델은
 * 자기가 파일의 **앞부분**을 보고 있다고 가정하고, 없는 import를 있다고 여기거나 파일 앞쪽에
 * 대한 patch를 쓴다.
 *
 * 그리고 그 사실은 **머리글에만** 있어야 한다. 본문에 `… 생략 …`을 넣으면 모델이 그것을
 * patch context로 복사하고, `apply_patch`가 실패하며, 그 실패는 "모델이 잘못된 patch를 냈다"로
 * 보인다.
 */
test("잘린 파일의 머리글이 실린 줄 범위를 말한다", () => {
  const body = "line a\nline b\nline c\n";
  const snapshot = makeSnapshot({
    relevantFiles: [
      makeRelevantFile({
        path: "src/ledger.ts",
        content: body,
        truncated: true,
        includedRange: { startLine: 740, endLine: 920, totalLines: 1400 },
      }),
    ],
  });
  const prompt = buildDraftPrompt({ snapshot, userMessage: "고쳐주세요" });

  assert.ok(prompt.includes("lines 740-920 of 1400"), prompt);
  // **연속된 조각이라는 사실**도 말한다 — 구멍이 있다고 오해하면 모델이 방어적으로 쓴다.
  assert.ok(prompt.includes("contiguous slice"), prompt);
  // 본문에는 생략 표시가 없다.
  assert.ok(!prompt.includes("생략"), prompt);
});

/** 범위가 없는 잘림(앵커 없는 접두사 자르기)은 종전 문구 그대로다 — 없는 정보를 지어내지 않는다. */
test("범위를 모르면 종전 문구를 쓴다", () => {
  const snapshot = makeSnapshot({
    relevantFiles: [makeRelevantFile({ content: "x\n", truncated: true })],
  });
  const prompt = buildDraftPrompt({ snapshot, userMessage: "고쳐주세요" });
  assert.ok(prompt.includes("this file is TRUNCATED"), prompt);
  assert.ok(!prompt.includes("contiguous slice"), prompt);
});

/**
 * **질문 프롬프트는 patch를 요구하지 않는다** — state-machine 51절.
 *
 * 출력 규칙(`PATCH_RULES`)을 붙이면 모델이 묻지도 않은 수정안을 내놓고, 그것은 어디로도 가지
 * 않으므로 토큰만 쓰고 버려진다 — 그리고 사용자는 답 대신 diff를 읽는다.
 */
test("질문 프롬프트가 patch를 요구하지 않는다", () => {
  const prompt = buildQuestionPrompt({ snapshot: makeSnapshot(), userMessage: "왜 이렇습니까?" });
  assert.ok(!prompt.includes("unified diff"), prompt);
  assert.ok(!prompt.includes("`moves`"), prompt);
  assert.ok(prompt.includes("Do not propose a diff"), prompt);
  // 바꾸지 않는다는 것을 **첫 줄에서** 말한다.
  assert.ok(prompt.startsWith("You are answering a question"), prompt.slice(0, 80));
});

/**
 * **모르면 모른다고 하라고 말한다.** 이 경로에는 결정론적 판정자가 없으므로(검증할 결과가
 * 없다) 틀린 답을 잡아낼 것이 사용자뿐이고, 모델이 자기가 못 본 것을 말할 수 있어야 한다.
 *
 * 그리고 컨텍스트가 **잘린 조각**일 수 있다는 사실도 말한다(context-engine 14절) — 말해 주지
 * 않으면 모델은 보지 못한 코드에 대해 자신 있게 답한다.
 */
test("질문 프롬프트가 컨텍스트의 한계를 말한다", () => {
  const prompt = buildQuestionPrompt({ snapshot: makeSnapshot(), userMessage: "왜 이렇습니까?" });
  assert.ok(prompt.includes("budgeted SUBSET"), prompt);
  assert.ok(prompt.includes("truncated to a slice"), prompt);
  assert.ok(prompt.includes("say so instead of guessing"), prompt);
});

/**
 * **계획 프롬프트는 diff를 요구하지 않는다** — state-machine 53절.
 *
 * 이 모드가 존재하는 이유가 **patch를 만들기 전에 멈추는 것**이므로, 규칙에 diff 이야기가
 * 있으면 모델이 계획과 함께 diff를 쓰고 그 순간 이 모드가 아끼려던 토큰이 나간다.
 *
 * 프로브로 확인했다: 금지 문장을 지워도 **아무 검사도 실패하지 않았다.** 모드의 핵심 규칙이
 * 아무 데서도 확인되지 않고 있었다.
 */
test("계획 프롬프트가 diff를 요구하지도 허용하지도 않는다", () => {
  const prompt = buildPlanPrompt({ snapshot: makeSnapshot(), userMessage: "리팩터링하고 싶습니다" });
  assert.ok(!prompt.includes("unified diff"), prompt);
  assert.ok(!prompt.includes("`patch`"), prompt);
  assert.ok(prompt.includes("Do NOT write a diff"), prompt);
  // 만들지 않는다는 것을 **첫 줄에서** 말한다.
  assert.ok(prompt.startsWith("You are producing a PLAN"), prompt.slice(0, 80));
});

/**
 * **계획에도 컨텍스트의 한계를 말한다** — 답변보다 더 필요하다.
 *
 * 답변은 최소한 기댄 파일을 대지만, 계획은 **아직 존재하지 않는 코드**에 대한 서술이라
 * 대조할 것이 아무것도 없다. 그래서 위험을 값으로 요구하고, 빈 목록이 주장이라는 것까지
 * 말한다 — 말하지 않으면 빈 `risks`가 기본값처럼 돌아온다.
 */
test("계획 프롬프트가 컨텍스트의 한계와 빈 위험 목록의 뜻을 말한다", () => {
  const prompt = buildPlanPrompt({ snapshot: makeSnapshot(), userMessage: "리팩터링하고 싶습니다" });
  assert.ok(prompt.includes("budgeted SUBSET"), prompt);
  assert.ok(prompt.includes("outside what you were shown"), prompt);
  assert.ok(prompt.includes("An empty `risks` list is a claim"), prompt);
});

/**
 * **이름이 프롬프트까지 가야 한다** — state-machine 54절, 끝에서 끝까지.
 *
 * 리포트가 이름 단위로 갈라도, 프롬프트가 그것을 싣지 않으면 모델은 긴 출력에서 "무엇이 내
 * 책임인가"를 스스로 골라야 한다 — 원래 실패하던 테스트가 섞여 있으면 대개 틀린다.
 * 값을 만들어 놓고 아무도 읽지 않는 것은 이 저장소가 여러 번 밟은 모양이다.
 */
test("FIX_LOOP 프롬프트가 새로 깨진 테스트를 이름으로 말한다", () => {
  const prompt = buildFixPrompt({
    snapshot: makeSnapshot(),
    userMessage: "고쳐주세요",
    appliedChanges: "src/app.ts (12 bytes)",
    digest: {
      taskId: "t",
      reportId: "r",
      attemptNumber: 1,
      failingChecks: [
        {
          kind: "test",
          excerpt: "3 failed",
          fileReferences: [],
          newlyFailingTests: ["tests/new.py::a", "tests/new.py::b"],
        },
      ],
      passingChecksSummary: "build ok",
    },
  });
  assert.ok(prompt.includes("NEWLY failing"), prompt);
  assert.ok(prompt.includes("tests/new.py::a"), prompt);
  assert.ok(prompt.includes("fix these first"), prompt);
});

/** **없으면 아무 말도 하지 않는다.** "새로 깨진 것 없음"은 우리가 아는 사실이 아니다. */
test("가르지 못했으면 프롬프트가 새 실패를 말하지 않는다", () => {
  const prompt = buildFixPrompt({
    snapshot: makeSnapshot(),
    userMessage: "고쳐주세요",
    appliedChanges: "src/app.ts (12 bytes)",
    digest: {
      taskId: "t",
      reportId: "r",
      attemptNumber: 1,
      failingChecks: [{ kind: "test", excerpt: "3 failed", fileReferences: [] }],
      passingChecksSummary: "build ok",
    },
  });
  assert.ok(!prompt.includes("NEWLY failing"), prompt);
});

// ---- OpenAI strict structured output ----
//
// 이 검사가 실제 호출이 아니라 **스키마 자체**를 보는 이유: mock transport는 스키마를
// 검증하지 않으므로 어떤 형태든 통과시킨다. 그래서 이 경로는 실제 API에 대해 한 번도 돌지
// 않은 채 400을 내는 상태로 남아 있었고, 가설 게이트의 첫 유료 호출이 되어서야 드러났다.
// 규칙을 여기 적어두면 무료로, 그리고 다음 사람이 스키마를 건드릴 때 바로 잡힌다.

/** OpenAI strict 모드의 요구사항을 스키마 트리 전체에 대해 확인한다. */
function strictViolations(node: unknown, path: string, out: string[] = []): string[] {
  if (node === null || typeof node !== "object") return out;
  const schema = node as Record<string, any>;

  if (schema.type === "object") {
    if (schema.additionalProperties !== false) {
      out.push(`${path}: additionalProperties가 false여야 합니다`);
    }
    const properties = schema.properties ?? {};
    const names = Object.keys(properties);
    if (names.length === 0) {
      // properties가 없는 자유 객체는 strict로 표현할 수 없다 — 400의 원인이었던 형태다.
      out.push(`${path}: properties 없는 자유 객체는 strict 모드로 표현할 수 없습니다`);
    }
    const required = new Set<string>(schema.required ?? []);
    for (const name of names) {
      if (!required.has(name)) out.push(`${path}.${name}: strict 모드는 모든 속성이 required여야 합니다`);
      strictViolations(properties[name], `${path}.${name}`, out);
    }
  }
  if (schema.type === "array") strictViolations(schema.items, `${path}[]`, out);
  return out;
}

test("strict로 보내는 스키마가 OpenAI의 요구를 만족한다", () => {
  assert.deepEqual(strictViolations(DRAFT_SCHEMA_STRICT, "draft_proposal"), []);
});

test("고치기 전의 DRAFT_SCHEMA는 strict로 보낼 수 없다 — 검사가 공허하지 않다는 증거", () => {
  // 이 단언이 없으면 위 테스트는 "검사기가 아무것도 안 잡는다"로도 통과할 수 있다.
  const violations = strictViolations(DRAFT_SCHEMA, "draft_proposal");
  assert.ok(
    violations.some((v) => v.includes("mcpCalls[].arguments")),
    `실제 400의 원인을 검사기가 잡지 못합니다: ${JSON.stringify(violations)}`
  );
});

test("strict 때문에 문자열로 온 mcp arguments를 객체로 되돌린다", () => {
  const decoded = decodeMcpArguments({
    patch: "",
    mcpCalls: [{ server: "s", tool: "t", arguments: "{\"path\":\"src/a.ts\"}", reason: "r" }],
  }) as { mcpCalls: { arguments: unknown }[] };
  assert.deepEqual(decoded.mcpCalls[0]!.arguments, { path: "src/a.ts" });

  // 빈 인자도 정상이다 — 인자가 없는 도구가 있다.
  const empty = decodeMcpArguments({ mcpCalls: [{ server: "s", tool: "t", arguments: "{}", reason: "r" }] }) as {
    mcpCalls: { arguments: unknown }[];
  };
  assert.deepEqual(empty.mcpCalls[0]!.arguments, {});

  // 비어 있는 배열이 정상 경로다 — 손대지 않는다.
  assert.deepEqual(decodeMcpArguments({ mcpCalls: [] }), { mcpCalls: [] });
});

test("깨진 JSON은 원인을 가리키는 오류가 된다", () => {
  // 문자열을 그대로 흘려보내면 검증기가 "expected an object"라고만 말해 원인과 먼 곳을 가리킨다.
  assert.throws(
    () => decodeMcpArguments({ mcpCalls: [{ server: "s", tool: "t", arguments: "{not json", reason: "r" }] }),
    (error: unknown) => error instanceof ValidationError && String(error).includes("파싱할 수 없습니다")
  );
  // 배열은 이름 있는 인자가 아니다.
  assert.throws(
    () => decodeMcpArguments({ mcpCalls: [{ server: "s", tool: "t", arguments: "[1,2]", reason: "r" }] }),
    (error: unknown) => error instanceof ValidationError
  );
});

test("타임아웃은 취소와 구별되어 기록된다", () => {
  // 타임아웃도 구현상 abort지만 두 사실은 다르다: 취소는 **사용자가 그만두게 한 것**이고
  // 타임아웃은 **우리가 정한 실행 예산을 넘긴 것**이다. 순서가 뒤바뀌어 있어서 모든
  // 타임아웃이 cancelled로 기록됐고, 그러면 어느 쪽도 셀 수 없다.
  const timeout = new Error("공급자 호출이 120000ms 후 타임아웃됨");
  timeout.name = "TimeoutError";
  assert.equal(normalizeProviderError(timeout).kind, "timeout");

  // SDK가 내는 이름도 같은 사실이다.
  const sdk = new Error("connection timed out");
  sdk.name = "APIConnectionTimeoutError";
  assert.equal(normalizeProviderError(sdk).kind, "timeout");

  // 진짜 취소는 그대로 cancelled다 — 구분이 한쪽으로 무너지면 안 된다.
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(normalizeProviderError(abort).kind, "cancelled");
});

test("응답을 받은 뒤의 검증 실패는 usage를 잃지 않는다", () => {
  // 실측(가설 게이트 P1, 2026-08-27): 검수 호출이 출력 상한까지 달리다 잘려 구조화 출력이
  // 깨졌다. 응답도 usage도 있었는데 검증이 던지면서 전부 사라졌고, 비용을 계산할 수 없어
  // 예약이 미해결로 남아 **96건짜리 실행이 7건에서 멈췄다.**
  const received = {
    usage: { inputTokens: 2500, outputTokens: 16000 },
    latencyMs: 171_000,
    meta: {
      requestedModelId: "claude-sonnet-5",
      providerReportedModelId: "claude-sonnet-5",
      dispatchState: "response_received_with_usage" as const,
    },
  };

  let thrown: unknown;
  try {
    validateReceived(() => {
      throw new ValidationError("reviewDecision.verdict", "expected one of ACCEPT/REVISE/REJECT");
    }, received);
  } catch (error) {
    thrown = error;
  }

  const failure = thrown as InstanceType<typeof ProviderCallFailure>;
  assert.equal(failure.name, "ProviderCallFailure");
  // **이 세 가지가 요점이다** — 없으면 과금된 호출이 "안 썼다"나 "모른다"가 된다.
  assert.deepEqual(failure.usage, received.usage);
  assert.equal(failure.dispatchState, "response_received_with_usage");
  assert.equal(failure.classification.kind, "schema_violation");
  assert.equal(failure.providerReportedModelId, "claude-sonnet-5");
});

test("성공한 검증은 그대로 통과시킨다", () => {
  const received = {
    usage: { inputTokens: 1, outputTokens: 2 },
    latencyMs: 3,
    meta: { requestedModelId: "m", dispatchState: "response_received_with_usage" as const },
  };
  assert.equal(validateReceived(() => 42, received), 42);
});

test("이미 dispatch 사실을 아는 오류는 다시 감싸지 않는다", () => {
  // 감싸면 어댑터가 확보한 분류(예: tool_use 블록 없음)가 덮인다.
  const original = new ProviderCallFailure({
    message: "tool_use 블록 없음",
    dispatchState: "response_received_with_usage",
    classification: { kind: "schema_violation", message: "없음", status: 400, retryable: false },
    usage: { inputTokens: 5, outputTokens: 6 },
  });
  const received = {
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 1,
    meta: { requestedModelId: "m", dispatchState: "response_received_with_usage" as const },
  };
  assert.throws(
    () => validateReceived(() => { throw original; }, received),
    (error: unknown) => error === original
  );
});
