import type {
  DraftProposal,
  ModelEntry,
  NormalizedProviderError,
  ProviderCapabilitiesView,
  ReviewDecision,
  SingleModelFixResult,
  TokenUsage,
} from "@tomverse/protocol";
import { validateDraftProposal, validateReviewDecision, validateSingleModelFixResult } from "@tomverse/protocol";
import { effectiveMaxOutputTokens } from "../budget/ledger.js";
import { estimateTokensUpperBound } from "../context/budget.js";
import { normalizeProviderError } from "./errors.js";
import {
  buildDraftPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildSingleModelFixPrompt,
  DRAFT_SCHEMA,
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
 * Google Gemini 어댑터 — M2 커버리지("멀티프로바이더 3사", product-strategy 8.2절).
 *
 * # 구조화 출력은 세 번째 메커니즘이다
 *
 * OpenAI는 `json_schema strict`, Anthropic은 강제 도구 호출, Gemini는
 * `generationConfig.responseSchema`다. `StructuredOutputMode`에 `response_schema`가 이미
 * 있었던 이유가 이것이다 — 축은 설계에 있었고 쓰는 어댑터가 없었을 뿐이다.
 *
 * **세 메커니즘이 같은 스키마 객체를 공유한다.** 모델마다 다른 것을 요구하면 대조·검수·게이트가
 * 재는 차이에 "우리가 다르게 물었다"가 섞인다(적합성 스위트가 이 전제를 지킨다).
 *
 * # SDK를 쓰지 않는 이유
 *
 * 다른 둘은 공식 SDK를 쓴다. 여기서는 `fetch`를 직접 쓴다 — 와이어 형식이 JSON POST 하나이고,
 * 무엇보다 **적합성 스위트가 `fetch`를 주입해 어댑터 본체를 태우기 때문**이다. SDK를 한 겹
 * 더 올리면 그 검증이 SDK 동작에 가려진다. 의존성을 하나 덜 지는 것은 부수 효과다.
 *
 * # 여기서 확인되지 않는 것
 *
 * 이 어댑터의 요청 조립·envelope 해석·정규화는 주입된 `fetch`로 전부 검증된다. 그러나
 * **Gemini가 실제로 이 요청을 받아들이는가는 확인되지 않았다** — 이 저장소의 개발 환경에는
 * Google 자격증명이 없고 egress도 막혀 있다. Windows 전용 코드와 같은 종류의 유보이며
 * (state-machine 20.6절), 착지 기준은 multi-engine-routing.md 19절에 적었다.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly modelId: string;
  private readonly entry: ModelEntry;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly controllers = new Set<AbortController>();

  constructor(deps: AdapterDeps) {
    this.entry = deps.entry;
    this.providerId = deps.entry.providerId;
    this.modelId = deps.entry.modelId;
    this.apiKey = deps.apiKey;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  capabilities(): ProviderCapabilitiesView {
    return {
      providerId: this.providerId,
      modelId: this.modelId,
      supportsStructuredOutput: this.entry.capabilities.structuredOutput !== "none",
      supportsToolCalling: this.entry.capabilities.toolCalling !== "none",
      maxContextTokens: this.entry.capabilities.maxContextTokens,
      maxOutputTokens: effectiveMaxOutputTokens(this.entry),
    };
  }

  cancel(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  /**
   * Gemini는 `usageMetadata`에 다른 이름으로 준다. **여기서 맞추지 않으면 비용 집계가
   * 조용히 0이 된다** — 0인 비용은 "안 썼다"로 읽히므로 가장 나쁜 종류의 정규화 실패다.
   */
  normalizeUsage(raw: unknown): TokenUsage {
    const usage = (raw ?? {}) as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
    return {
      inputTokens: usage.promptTokenCount ?? usage.input_tokens ?? 0,
      outputTokens: usage.candidatesTokenCount ?? usage.output_tokens ?? 0,
    };
  }

  normalizeError(raw: unknown): NormalizedProviderError {
    return normalizeProviderError(raw);
  }

  /**
   * 모델이 **조회되는가**. 유료 호출을 하지 않는다 — `GET /models/{id}`만 쓴다.
   *
   * 다른 어댑터와 같은 문장을 쓴다: 조회는 호출 성공을 보장하지 않는다(17절).
   */
  async checkCredential(signal?: AbortSignal): Promise<CredentialCheck> {
    try {
      const response = await this.fetchImpl(this.modelUrl(), {
        method: "GET",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await this.failureFromResponse(response);
      return {
        providerId: this.providerId,
        modelId: this.modelId,
        status: "listed",
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

  async generateDraft(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<DraftProposal>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(buildDraftPrompt(input), DRAFT_SCHEMA, ctx);
    return {
      value: validateDraftProposal(parsed, {
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
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(buildReviewPrompt(input), REVIEW_SCHEMA, ctx);
    return {
      value: validateReviewDecision(parsed, {
        taskId: ctx.taskId,
        proposalId: input.draft.proposalId,
        // 프롬프트 구성에 대한 사실이므로 우리가 기록한다 — 모델에게 묻지 않는다.
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
      SINGLE_FIX_SCHEMA,
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

  async continueWithToolResult(
    input: FixInput,
    ctx: ProviderCallContext
  ): Promise<ProviderResponse<SingleModelFixResult>> {
    const { parsed, usage, latencyMs, meta } = await this.structuredCall(buildFixPrompt(input), SINGLE_FIX_SCHEMA, ctx);
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

  private headers(): Record<string, string> {
    // 키를 쿼리스트링이 아니라 헤더로 보낸다 — URL은 로그·프록시·오류 메시지에 남는다.
    return { "content-type": "application/json", "x-goog-api-key": this.apiKey };
  }

  private modelUrl(suffix = ""): string {
    const base = this.entry.apiBaseUrl.replace(/\/+$/, "");
    return `${base}/models/${this.modelId}${suffix}`;
  }

  private async structuredCall(
    prompt: string,
    schema: unknown,
    ctx: ProviderCallContext
  ): Promise<{ parsed: unknown; usage: TokenUsage; latencyMs: number; meta: ProviderCallMetadata }> {
    const responseSchema = toResponseSchema(schema);
    // 프롬프트 + 스키마가 이번 요청의 입력 전부다. 스키마를 빼고 세면 상한이 과소해진다.
    const estimatedTokens =
      estimateTokensUpperBound(prompt) + estimateTokensUpperBound(JSON.stringify(responseSchema));

    const controller = new AbortController();
    this.controllers.add(controller);
    const onAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const start = Date.now();
    try {
      const response = await this.fetchImpl(this.modelUrl(":generateContent"), {
        method: "POST",
        headers: this.headers(),
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            // 둘을 **함께** 보낸다. mimeType만 보내면 스키마 없는 JSON이고,
            // schema만 보내면 Gemini가 평문으로 답할 수 있다.
            responseMimeType: "application/json",
            responseSchema,
            maxOutputTokens: effectiveMaxOutputTokens(this.entry),
          },
        }),
      });
      const latencyMs = Date.now() - start;
      if (!response.ok) throw await this.failureFromResponse(response, latencyMs);

      const envelope = (await response.json()) as GeminiEnvelope;
      const usage = this.normalizeUsage(envelope.usageMetadata);
      const meta: ProviderCallMetadata = {
        requestedModelId: this.modelId,
        // **공급자가 말한 모델을 읽는다.** Gemini는 `modelVersion`으로 준다 — 공용
        // `envelopeIdentity`는 `model` 키를 보므로 여기서는 쓸 수 없다. 요청 값으로 채우면
        // exact-model 검증이 언제나 통과해 조용한 대체를 못 잡는다(10.8절).
        ...(typeof envelope.modelVersion === "string" && envelope.modelVersion.length > 0
          ? { providerReportedModelId: envelope.modelVersion }
          : {}),
        ...(typeof envelope.responseId === "string" && envelope.responseId.length > 0
          ? { providerRequestId: envelope.responseId }
          : {}),
        dispatchState: "response_received_with_usage",
        estimatedInputTokens: estimatedTokens,
      };

      const text = extractText(envelope);
      if (text === undefined) {
        // 구조화 출력을 요구했는데 텍스트가 없으면 스키마 계약 위반이다.
        // **응답은 이미 받았고 과금됐다** — 아는 사실을 오류에 실어 보낸다.
        throw new ProviderCallFailure({
          message: "Gemini 응답에서 구조화 출력 텍스트를 찾을 수 없음",
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
      try {
        return { parsed: JSON.parse(text), usage, latencyMs, meta };
      } catch (cause) {
        throw new ProviderCallFailure({
          message: `Gemini 구조화 출력이 JSON이 아님: ${cause instanceof Error ? cause.message : String(cause)}`,
          dispatchState: meta.dispatchState,
          classification: {
            kind: "schema_violation",
            message: "구조화 출력이 JSON이 아님",
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
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
    }
  }

  /**
   * HTTP 오류를 공용 분류기가 읽을 수 있는 모양으로 만든다.
   *
   * **여기서 따로 분류하지 않는다.** 어댑터마다 401을 다르게 읽으면 재시도 정책이 공급자에
   * 따라 달라지고, 그건 "어댑터는 바꿔 끼울 수 있다"는 전제를 깬다.
   */
  private async failureFromResponse(response: Response, latencyMs?: number): Promise<unknown> {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // 본문이 JSON이 아니면 상태 줄만 쓴다 — 파싱 실패를 오류의 원인으로 바꾸지 않는다.
    }
    const error = new Error(message) as Error & { status?: number; latencyMs?: number };
    error.status = response.status;
    if (latencyMs !== undefined) error.latencyMs = latencyMs;
    return error;
  }
}

interface GeminiEnvelope {
  candidates?: { content?: { parts?: { text?: unknown }[] } }[];
  usageMetadata?: unknown;
  modelVersion?: unknown;
  responseId?: unknown;
}

/** 첫 후보의 첫 텍스트 part. 없으면 `undefined` — 여기서 던지면 usage를 오류에 실을 수 없다. */
function extractText(envelope: GeminiEnvelope): string | undefined {
  for (const candidate of envelope.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text.length > 0) return part.text;
    }
  }
  return undefined;
}

/**
 * JSON Schema → Gemini `responseSchema`.
 *
 * # 왜 변환이 필요한가
 *
 * Gemini의 `responseSchema`는 JSON Schema 전체가 아니라 **OpenAPI 3 스키마의 부분집합**을
 * 받는다. 우리 스키마에는 `additionalProperties`·`$schema` 같은 키가 있고, 그대로 보내면
 * 요청이 거부된다. 그리고 그 거부는 **모델의 답이 나쁜 것으로 읽히기 쉽다** — 실제로는 우리가
 * 잘못 물은 것이다.
 *
 * # 모르는 키를 추측해서 옮기지 않는다
 *
 * 아는 키만 통과시키고 나머지는 **버린다**. 버린다는 것은 제약이 느슨해진다는 뜻이고, 느슨한
 * 제약은 우리 경계의 `validate*`가 잡는다(모든 공급자가 같은 검증을 지난다). 반대로 모르는 키를
 * 그대로 보내 요청이 통째로 거부되면 아무것도 받지 못한다 — 둘 중 덜 나쁜 쪽을 고른 것이다.
 *
 * **이 함수가 만든 스키마를 Gemini가 실제로 받아들이는지는 여기서 확인되지 않는다**
 * (자격증명 없음). 그래서 어댑터 착지 기준이 따로 있다(multi-engine-routing.md 19절).
 */
export function toResponseSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return schema;
  if (Array.isArray(schema)) return schema.map(toResponseSchema);

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // OpenAPI 3 부분집합에서 우리가 쓰는 키들. 여기 없는 키는 조용히 버린다.
  for (const key of ["type", "description", "enum", "format", "nullable"]) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  if (source.items !== undefined) out.items = toResponseSchema(source.items);
  if (source.properties !== undefined && typeof source.properties === "object" && source.properties !== null) {
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(source.properties as Record<string, unknown>)) {
      properties[name] = toResponseSchema(value);
    }
    out.properties = properties;
  }
  // `required`는 그대로 옮긴다 — 이건 느슨해지면 안 되는 제약이다.
  if (Array.isArray(source.required)) out.required = [...source.required];
  return out;
}
