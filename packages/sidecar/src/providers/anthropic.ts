import Anthropic from "@anthropic-ai/sdk";
import type {
  DraftProposal,
  ModelEntry,
  NormalizedProviderError,
  ProviderCapabilitiesView,
  ReviewDecision,
  SingleModelFixResult,
  TokenUsage,
} from "@tomverse/protocol";
import { effectiveMaxOutputTokens } from "../budget/ledger.js";
import { validateDraftProposal, validateReviewDecision, validateSingleModelFixResult } from "@tomverse/protocol";
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
  DraftInput,
  FixInput,
  ProviderAdapter,
  ProviderCallContext,
  ProviderCallMetadata,
  ProviderResponse,
  ReviewInput,
} from "./types.js";

/**
 * Anthropic 어댑터.
 *
 * 구조화 출력: Messages API + `tool_choice: { type: "tool", name }`로 특정 도구 호출을 강제한다.
 * Phase 0 스파이크(`spike/src/providers/anthropic.ts`)에서 검증된 패턴이다
 * (state-machine-and-protocol.md 13.3절).
 *
 * OpenAI와 다른 메커니즘(강제 도구 호출 vs strict json_schema)을 쓰지만 **같은 스키마 객체**를
 * 공유한다 — 두 모델에게 다른 것을 요구하면 모델 간 판정 차이를 비교할 수 없게 된다.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly modelId: string;
  private readonly entry: ModelEntry;
  private readonly client: Anthropic;
  private readonly controllers = new Set<AbortController>();

  constructor(deps: AdapterDeps) {
    this.entry = deps.entry;
    this.providerId = deps.entry.providerId;
    this.modelId = deps.entry.modelId;
    this.client = new Anthropic({
      apiKey: deps.apiKey,
      baseURL: deps.entry.apiBaseUrl,
      // 재시도는 우리 정책이 관리한다 (openai.ts와 같은 이유).
      maxRetries: 0,
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
    const usage = (raw ?? {}) as { input_tokens?: number; output_tokens?: number };
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };
  }

  normalizeError(raw: unknown): NormalizedProviderError {
    return normalizeProviderError(raw);
  }

  async generateDraft(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<DraftProposal>> {
    const { parsed, usage, latencyMs, meta } = await this.forcedToolCall(
      buildDraftPrompt(input),
      { name: "submit_draft", description: "Submit your draft fix.", schema: DRAFT_SCHEMA },
      ctx
    );
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
    const { parsed, usage, latencyMs, meta } = await this.forcedToolCall(
      buildReviewPrompt(input),
      {
        name: "submit_review",
        description:
          "Submit your independent review verdict. Judge the patch against the task and the files — do not assume the draft is correct.",
        schema: REVIEW_SCHEMA,
      },
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
    const { parsed, usage, latencyMs, meta } = await this.forcedToolCall(
      buildSingleModelFixPrompt(input),
      { name: "submit_fix", description: "Submit your fix, a question, or a rejection.", schema: SINGLE_FIX_SCHEMA },
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
    const { parsed, usage, latencyMs, meta } = await this.forcedToolCall(
      buildFixPrompt(input),
      {
        name: "submit_fix",
        description: "Submit a corrected patch based on the verification output.",
        schema: SINGLE_FIX_SCHEMA,
      },
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

  private async forcedToolCall(
    prompt: string,
    tool: { name: string; description: string; schema: unknown },
    ctx: ProviderCallContext
  ): Promise<{ parsed: unknown; usage: TokenUsage; latencyMs: number; meta: ProviderCallMetadata }> {
    // 프롬프트 + 구조화 출력 정의가 이번 요청의 입력 전부다. 스키마를 빼고 세면 우리
    // 추정이 실제보다 작아지는데, **상한을 재는 값이 과소하면 재는 의미가 없다.**
    const estimatedTokens =
      estimateTokensUpperBound(prompt) + estimateTokensUpperBound(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.schema)}`);

    const controller = new AbortController();
    this.controllers.add(controller);
    const onAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const start = Date.now();
    try {
      const message = await this.client.messages.create(
        {
          model: this.modelId,
          max_tokens: effectiveMaxOutputTokens(this.entry),
          tools: [
            {
              name: tool.name,
              description: tool.description,
              input_schema: tool.schema as Anthropic.Tool.InputSchema,
            },
          ],
          // 구조화 출력 강제: 이 도구를 반드시 호출하게 한다.
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content: prompt }],
        },
        { signal: controller.signal }
      );

      const latencyMs = Date.now() - start;
      const usage = this.normalizeUsage(message.usage);
      // **Messages API 응답 envelope의 model을 읽는다.** ReviewDecision.model은 우리가 넣은
      // 요청 ID이므로 exact-model 검증에 쓸 수 없다.
      const meta: ProviderCallMetadata = {
        requestedModelId: this.modelId,
        ...envelopeIdentity(message),
        dispatchState: "response_received_with_usage",
        // **우리가 추정했던 입력 토큰.** 공급자가 보고한 실제와 나란히 남겨야 우리 추정이
        // 정말 상한이었는지 사후에 잴 수 있다(context/budget.ts).
        estimatedInputTokens: estimatedTokens,
      };
      const block = message.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name
      );
      if (!block) {
        // tool_choice로 강제했는데도 도구 호출이 없으면 스키마 계약 위반이다.
        // **응답은 이미 받았고 과금됐다** — 아는 사실을 오류에 실어 보낸다.
        throw new ProviderCallFailure({
          message: `Anthropic 응답에 ${tool.name} tool_use 블록이 없음`,
          dispatchState: meta.dispatchState,
          classification: {
            kind: "schema_violation",
            message: `${tool.name} tool_use 블록 없음`,
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
      return { parsed: block.input, usage, latencyMs, meta };
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
    }
  }
}

/**
 * 응답 envelope에서 모델 ID와 요청 ID를 뽑는다. **없으면 채우지 않는다** —
 * `this.modelId`로 폴백하면 exact-model 검증이 항상 통과해 무의미해진다.
 */
function envelopeIdentity(message: unknown): { providerReportedModelId?: string; providerRequestId?: string } {
  const candidate = message as { model?: unknown; id?: unknown };
  const out: { providerReportedModelId?: string; providerRequestId?: string } = {};
  if (typeof candidate.model === "string" && candidate.model.length > 0) {
    out.providerReportedModelId = candidate.model;
  }
  if (typeof candidate.id === "string" && candidate.id.length > 0) out.providerRequestId = candidate.id;
  return out;
}

/** 레지스트리 엔트리에 맞는 어댑터를 만든다. 모델 ID를 코드에 고정하지 않기 위한 팩토리. */
export function createNativeAdapter(entry: ModelEntry, apiKey: string): ProviderAdapter {
  switch (entry.providerId) {
    case "anthropic":
      return new AnthropicAdapter({ entry, apiKey });
    default:
      throw new Error(`createNativeAdapter는 ${entry.providerId}를 다루지 않습니다`);
  }
}
