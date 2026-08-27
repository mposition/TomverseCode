import OpenAI from "openai";
import type {
  DraftProposal,
  ModelEntry,
  NormalizedProviderError,
  ProviderCapabilitiesView,
  ReviewDecision,
  PlanOutline,
  QuestionAnswer,
  SingleModelFixResult,
  TokenUsage,
} from "@tomverse/protocol";
import { effectiveMaxOutputTokens } from "../budget/ledger.js";
import {
  ValidationError,
  validateDraftProposal,
  validatePlanOutline,
  validateQuestionAnswer,
  validateReviewDecision,
  validateSingleModelFixResult,
} from "@tomverse/protocol";
import { estimateTokensUpperBound } from "../context/budget.js";
import { envelopeIdentity } from "./envelope.js";
import { normalizeProviderError } from "./errors.js";
import {
  buildDraftPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildSingleModelFixPrompt,
  buildPlanPrompt,
  buildQuestionPrompt,
  DRAFT_SCHEMA,
  PLAN_SCHEMA,
  QUESTION_SCHEMA,
  REVIEW_SCHEMA,
  SINGLE_FIX_SCHEMA,
} from "./prompts.js";
import { ProviderCallFailure } from "./types.js";
import type {
  AdapterDeps,
  CredentialCheck,
  DraftInput,
  FixInput,
  ProviderAdapter,
  ProviderCallContext,
  ProviderCallMetadata,
  ProviderResponse,
  ReviewInput,
} from "./types.js";

/**
 * strict 모드로 보낼 수 있게 고친 `DRAFT_SCHEMA` — **OpenAI 어댑터 안에서만 쓴다.**
 *
 * # 왜 파생시키는가
 *
 * OpenAI의 strict structured output은 **모든 객체**에 `additionalProperties: false`를 요구한다.
 * 그런데 `mcpCalls[].arguments`는 도구가 선언한 스키마를 따르는 **자유 형식 객체**라 그 요구를
 * 만족시킬 방법이 없다 — `properties` 없이 `additionalProperties: false`를 붙이면 `{}`만
 * 허용되어 MCP 호출이 인자를 실을 수 없게 된다. strict 모드로는 표현할 수 없는 형태다.
 *
 * 실측: 이 스키마 그대로 보내면 요청이 400으로 거절된다.
 *
 *     400 Invalid schema for response_format 'draft_proposal':
 *     In context=('properties','mcpCalls','items','properties','arguments'),
 *     'additionalProperties' is required to be supplied and to be false.
 *
 * 추론 전 검증 단계에서 죽으므로 **초안 생성이 아예 성립하지 않는다.** 가설 게이트의 첫 실제
 * 호출(`gate:g:probe-models`)이 이걸 처음 드러냈다 — 그 전까지 이 경로는 실제 API에 대해 한
 * 번도 실행된 적이 없었고, mock transport는 스키마를 검증하지 않으므로 통과시켰다.
 *
 * # 왜 `DRAFT_SCHEMA` 자체를 고치지 않는가
 *
 * 그 상수는 **Anthropic·Gemini 어댑터가 함께 쓴다.** 거기서 `arguments`를 문자열로 바꾸면 세
 * 공급자의 전송 계약과 `validateMcpCalls`가 동시에 바뀐다 — 되돌리기 비싼 변경을, 공급자 하나의
 * 제약 때문에 전부에 물리는 것이다. 제약이 OpenAI의 것이므로 대응도 OpenAI 어댑터에 둔다.
 *
 * # 왜 `strict: false`로 내리지 않는가
 *
 * 한 줄이면 되지만 Model Registry가 이 모델을 `structuredOutput: "strict_schema"`로 **선언**하고
 * 있다. 선언과 실제가 갈리면 라우터의 능력 필터가 거짓이 되고, 무엇보다 초안은 patch를 나르는
 * 자리라 형태가 흔들리면 스키마 위반이 늘어난다. 표현할 수 없는 자리 하나를 옮기는 편이,
 * 스키마 전체의 강제를 포기하는 것보다 잃는 것이 적다.
 */
const MCP_ARGUMENTS_AS_JSON_STRING =
  "Named arguments matching the tool's declared schema, serialized as a JSON object string. " +
  'Example: "{\\"path\\":\\"src/a.ts\\"}". Send "{}" when the tool takes no arguments.';

export const DRAFT_SCHEMA_STRICT: unknown = (() => {
  const clone = structuredClone(DRAFT_SCHEMA) as {
    properties: { mcpCalls: { items: { properties: Record<string, unknown> } } };
  };
  clone.properties.mcpCalls.items.properties.arguments = {
    type: "string",
    description: MCP_ARGUMENTS_AS_JSON_STRING,
  };
  return clone;
})();

/**
 * strict 스키마 때문에 문자열로 받은 `mcpCalls[].arguments`를 객체로 되돌린다.
 *
 * **`validateDraftProposal`에 넘기기 전에** 한다. 그래야 검증기가 보는 것이 다른 공급자에서
 * 오는 것과 같은 모양이 되고, "OpenAI에서 왔는지"를 프로토콜 경계가 알 필요가 없다.
 *
 * 파싱 실패를 조용히 넘기지 않는 이유: 문자열을 그대로 두면 `validateMcpCalls`가
 * "expected an object"라고만 말하는데, 그건 **모델이 객체 대신 문자열을 보냈다**는 뜻으로
 * 읽힌다. 실제 원인(JSON이 깨졌다)과 다른 곳을 가리키는 오류가 가장 오래 걸린다.
 */
export function decodeMcpArguments(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object") return parsed;
  const draft = parsed as { mcpCalls?: unknown };
  if (!Array.isArray(draft.mcpCalls)) return parsed;

  return {
    ...draft,
    mcpCalls: draft.mcpCalls.map((call, i) => {
      if (call === null || typeof call !== "object") return call;
      const withArgs = call as { arguments?: unknown };
      // 다른 형태로 오면 건드리지 않는다 — 판정은 검증기 한 곳에서 한다.
      if (typeof withArgs.arguments !== "string") return call;

      let decoded: unknown;
      try {
        decoded = JSON.parse(withArgs.arguments);
      } catch (error) {
        throw new ValidationError(
          `draftProposal.mcpCalls[${i}].arguments`,
          `JSON 문자열로 받았으나 파싱할 수 없습니다: ${String(error)}`
        );
      }
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new ValidationError(
          `draftProposal.mcpCalls[${i}].arguments`,
          "JSON 객체여야 합니다 (MCP는 이름 있는 인자를 씁니다)"
        );
      }
      return { ...withArgs, arguments: decoded };
    }),
  };
}

/**
 * OpenAI 어댑터.
 *
 * 구조화 출력: Responses API의 `text.format = { type: "json_schema", strict: true }`.
 * 이 패턴은 Phase 0 스파이크(`spike/src/providers/openai.ts`)에서 실제 호출로 검증됐다
 * (state-machine-and-protocol.md 13.3절). 스파이크 코드를 그대로 복사하지 않고 다시 쓴 이유:
 *  - 스파이크는 "파일 전체 교체"만 다뤘고 여기는 unified diff를 다룬다
 *  - 모델 ID를 상수로 갖지 않고 `ModelEntry`에서 받는다 (작업 지침 4.6절)
 *  - 취소/타임아웃/오류 분류가 필요하다 (스파이크에는 없었다)
 *
 * `strict: true`는 `required`에 모든 프로퍼티가 들어가야 하므로, verdict에 따라 필드가
 * 달라지는 REVIEW/SINGLE_FIX 스키마에는 strict를 쓰지 않는다 — 강제하면 모델이 REJECT일 때도
 * patch를 억지로 채운다(스파이크에서 겪은 문제). 대신 `validate*`가 경계에서 일관성을 확인한다.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly modelId: string;
  private readonly entry: ModelEntry;
  private readonly client: OpenAI;
  private readonly controllers = new Set<AbortController>();

  constructor(deps: AdapterDeps) {
    this.entry = deps.entry;
    this.providerId = deps.entry.providerId;
    this.modelId = deps.entry.modelId;
    this.client = new OpenAI({
      apiKey: deps.apiKey,
      baseURL: deps.entry.apiBaseUrl,
      // 재시도는 우리 정책(state-machine-and-protocol.md 9절)으로 관리하므로 SDK 재시도를 끈다.
      // 두 층이 각각 재시도하면 실제 시도 횟수가 곱해지고 카운터가 사실과 달라진다.
      maxRetries: 0,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  }

  capabilities(): ProviderCapabilitiesView {
    return {
      providerId: this.providerId,
      modelId: this.modelId,
      supportsStructuredOutput: this.entry.capabilities.structuredOutput !== "none",
      supportsToolCalling: this.entry.capabilities.toolCalling !== "none",
      maxContextTokens: this.entry.capabilities.maxContextTokens,
      // 보고값과 실제 요청값을 일치시킨다 — 다르면 감사 기록이 실제를 설명하지 못한다.
      maxOutputTokens: effectiveMaxOutputTokens(this.entry),
    };
  }

  cancel(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  normalizeUsage(raw: unknown): TokenUsage {
    const usage = (raw ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
    };
    return {
      inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    };
  }

  /**
   * 이 자격증명으로 이 모델이 **조회되는가** (multi-engine-routing.md 17절).
   *
   * 무료 모델 조회 엔드포인트만 쓴다 — 유료 호출은 태스크에 속하지 않아 예산 원장에도
   * 전송 기록에도 자리가 없고, 기록되지 않는 지출을 만들지 않기 위해서다.
   *
   * **오류를 재분류하지 않고 공용 분류기를 쓴다.** 여기서 따로 판단하면 같은 401이
   * 호출 경로와 확인 경로에서 다르게 읽힌다.
   */
  async checkCredential(signal?: AbortSignal): Promise<CredentialCheck> {
    try {
      await this.client.models.retrieve(this.modelId, ...((signal ? [{ signal }] : []) as []));
      return {
        providerId: this.providerId,
        modelId: this.modelId,
        status: "listed",
        // "된다"가 아니라 "조회된다"라고 쓴다 — 조직 인증이 필요한 모델은 조회되고 호출에서 죽는다.
        detail: "이 자격증명으로 모델이 조회됩니다 (실제 호출 성공을 보장하지는 않습니다)",
      };
    } catch (raw) {
      const normalized = normalizeProviderError(raw);
      const status: CredentialCheck["status"] =
        normalized.kind === "auth"
          ? "auth_failed"
          : normalized.kind === "model_unavailable"
            ? "model_unavailable"
            : "unreachable";
      return { providerId: this.providerId, modelId: this.modelId, status, detail: normalized.message };
    }
  }

  normalizeError(raw: unknown): NormalizedProviderError {
    return normalizeProviderError(raw);
  }

  async generateDraft(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<DraftProposal>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(
      buildDraftPrompt(input),
      { name: "draft_proposal", schema: DRAFT_SCHEMA_STRICT, strict: true },
      ctx
    );
    return {
      value: validateDraftProposal(decodeMcpArguments(parsed), {
        taskId: ctx.taskId,
        proposalId: `${ctx.taskId}-${ctx.callId}`,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage,
      latencyMs,
      meta,
    };
  }

  async reviewProposal(input: ReviewInput, ctx: ProviderCallContext): Promise<ProviderResponse<ReviewDecision>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(
      buildReviewPrompt(input),
      { name: "review_decision", schema: REVIEW_SCHEMA, strict: false },
      ctx
    );
    return {
      value: validateReviewDecision(parsed, {
        taskId: ctx.taskId,
        proposalId: input.draft.proposalId,
        // 프롬프트를 어떻게 구성했는지에 대한 사실이므로 우리가 기록한다 — 모델에게 묻지 않는다.
        reviewMode: input.blind ? "blind" : "informed",
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage,
      latencyMs,
      meta,
    };
  }

  async singleModelFix(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<SingleModelFixResult>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(
      buildSingleModelFixPrompt(input),
      { name: "single_model_fix", schema: SINGLE_FIX_SCHEMA, strict: false },
      ctx
    );
    return {
      value: validateSingleModelFixResult(parsed, {
        taskId: ctx.taskId,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage,
      latencyMs,
      meta,
    };
  }

  async answerQuestion(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<QuestionAnswer>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(
      buildQuestionPrompt(input),
      { name: "question_answer", schema: QUESTION_SCHEMA, strict: false },
      ctx
    );
    return {
      value: validateQuestionAnswer(parsed, {
        taskId: ctx.taskId,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage,
      latencyMs,
      meta,
    };
  }

  async outlinePlan(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<PlanOutline>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(
      buildPlanPrompt(input),
      { name: "plan_outline", schema: PLAN_SCHEMA, strict: false },
      ctx
    );
    return {
      value: validatePlanOutline(parsed, {
        taskId: ctx.taskId,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage,
      latencyMs,
      meta,
    };
  }

  async continueWithToolResult(
    input: FixInput,
    ctx: ProviderCallContext
  ): Promise<ProviderResponse<SingleModelFixResult>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(
      buildFixPrompt(input),
      { name: "single_model_fix", schema: SINGLE_FIX_SCHEMA, strict: false },
      ctx
    );
    return {
      value: validateSingleModelFixResult(parsed, {
        taskId: ctx.taskId,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage,
      latencyMs,
      meta,
    };
  }

  private async structuredCall(
    prompt: string,
    format: { name: string; schema: unknown; strict: boolean },
    ctx: ProviderCallContext
  ): Promise<{ parsed: unknown; usage: TokenUsage; latencyMs: number; meta: ProviderCallMetadata }> {
    // 프롬프트 + 구조화 출력 정의가 이번 요청의 입력 전부다. 스키마를 빼고 세면 우리
    // 추정이 실제보다 작아지는데, **상한을 재는 값이 과소하면 재는 의미가 없다.**
    const estimatedTokens =
      estimateTokensUpperBound(prompt) + estimateTokensUpperBound(`${format.name}\n${JSON.stringify(format.schema)}`);

    const controller = new AbortController();
    this.controllers.add(controller);
    const onAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const start = Date.now();
    try {
      const response = await this.client.responses.create(
        {
          model: this.modelId,
          input: [{ role: "user", content: prompt }],
          max_output_tokens: effectiveMaxOutputTokens(this.entry),
          text: {
            format: {
              type: "json_schema",
              name: format.name,
              strict: format.strict,
              schema: format.schema as Record<string, unknown>,
            },
          },
        },
        { signal: controller.signal }
      );

      const latencyMs = Date.now() - start;
      const usage = this.normalizeUsage(response.usage);
      // **응답 envelope의 model을 읽는다.** 우리가 요청한 값이 아니라 공급자가 말한 값이며,
      // 조용한 대체를 잡을 수 있는 유일한 근거다. 없으면 undefined로 남긴다.
      const meta: ProviderCallMetadata = {
        requestedModelId: this.modelId,
        ...envelopeIdentity(response),
        dispatchState: "response_received_with_usage",
        // **우리가 추정했던 입력 토큰.** 공급자가 보고한 실제와 나란히 남겨야 우리 추정이
        // 정말 상한이었는지 사후에 잴 수 있다(context/budget.ts).
        estimatedInputTokens: estimatedTokens,
      };
      const text = extractOutputText(response);
      if (text === undefined) {
        // 구조화 출력을 강제했는데도 텍스트가 없으면 스키마 계약 위반이다.
        // **응답은 이미 받았고 과금됐다** — 아는 사실을 오류에 실어 보낸다.
        // (Anthropic 어댑터의 "tool_use 블록 없음"과 같은 경우이며, 적합성 스위트가 두
        // 어댑터에 같은 것을 요구한다.)
        throw new ProviderCallFailure({
          message: "OpenAI 응답에서 구조화 출력 텍스트를 찾을 수 없음",
          dispatchState: meta.dispatchState,
          classification: {
            kind: "schema_violation",
            message: "구조화 출력 텍스트 없음",
            status: 400,
            retryable: false,
          },
          usage,
          ...(meta.providerReportedModelId ? { providerReportedModelId: meta.providerReportedModelId } : {}),
          ...(meta.providerRequestId ? { providerRequestId: meta.providerRequestId } : {}),
          latencyMs,
          status: 400,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        // 구조화 출력을 강제했는데도 JSON이 아니면 schema_violation이다 —
        // 재시도 정책이 이 구분에 의존하므로 일반 오류로 뭉개지 않는다.
        //
        // **응답은 이미 받았고 과금됐다.** 그래서 평범한 Error가 아니라 아는 사실을 실은
        // ProviderCallFailure를 던진다 — 호출자가 예약을 해제할지 미해결로 남길지 판단할 수 있어야 한다.
        throw new ProviderCallFailure({
          message: `OpenAI 구조화 출력이 JSON이 아님: ${cause instanceof Error ? cause.message : String(cause)}`,
          dispatchState: meta.dispatchState,
          classification: { kind: "schema_violation", message: "구조화 출력이 JSON이 아님", status: 400, retryable: false },
          usage,
          ...(meta.providerReportedModelId ? { providerReportedModelId: meta.providerReportedModelId } : {}),
          ...(meta.providerRequestId ? { providerRequestId: meta.providerRequestId } : {}),
          latencyMs,
          status: 400,
        });
      }
      return { parsed, usage, latencyMs, meta };
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
    }
  }
}

/**
 * 구조화 출력 텍스트를 꺼낸다. `output_text` 편의 프로퍼티가 없거나 빈 SDK 형태에 대한
 * 폴백까지 본다 — 스파이크에서 이미 필요했던 방어다.
 *
 * **찾지 못하면 `undefined`다.** 예전에는 여기서 평범한 `Error`를 던졌는데, 그러면 호출자가
 * 이미 받은 응답의 usage·모델 ID를 오류에 실을 수 없다(적합성 스위트가 잡은 결함).
 */
function extractOutputText(response: unknown): string | undefined {
  const candidate = response as {
    output_text?: unknown;
    output?: { content?: { text?: unknown }[] }[];
  };
  if (typeof candidate.output_text === "string" && candidate.output_text.length > 0) {
    return candidate.output_text;
  }
  for (const item of candidate.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.length > 0) return content.text;
    }
  }
  return undefined;
}
