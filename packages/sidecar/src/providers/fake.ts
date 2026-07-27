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
import { normalizeProviderError } from "./errors.js";
import type {
  AdapterDeps,
  DraftInput,
  FixInput,
  ProviderAdapter,
  ProviderCallContext,
  ProviderResponse,
  ReviewInput,
} from "./types.js";

/**
 * 결정론적 가짜 공급자.
 *
 * 목적(작업 지침 4.6절): "API 키가 없는 테스트 환경에서는 fake provider로 전체 루프를
 * 검증할 수 있어야 한다."
 *
 * 중요한 설계 선택: **fake도 실제 어댑터와 똑같이 `validate*` 경계 검증을 통과한다.**
 * 검증을 건너뛰는 fake는 "우리 검증 코드가 실제로 동작하는가"를 테스트하지 못하고,
 * 프로덕션 어댑터에서만 처음 실패하게 된다.
 *
 * 스크립트를 주입할 수 있게 만든 이유는 실패 경로(REJECT, NEED_USER_INPUT, timeout,
 * 잘못된 patch, fix loop)를 e2e 테스트에서 결정론적으로 재현하기 위한 것이다.
 */

export interface FakeScriptStep {
  /** 어떤 호출에 응답할지 */
  kind: "draft" | "review" | "singleFix" | "fix";
  /** 이 스텝이 던질 오류 (재시도/타임아웃 경로 테스트용) */
  throws?: { message: string; status?: number; name?: string };
  /** 응답 지연 (타임아웃 테스트용) */
  delayMs?: number;
  /** 구조화 출력으로 반환할 값. 검증을 거치므로 잘못된 형태면 여기서 걸린다. */
  payload?: Record<string, unknown>;
  usage?: TokenUsage;
}

export interface FakeProviderOptions {
  /** 순서대로 소비되는 스크립트. 비면 기본 동작(아래 defaults)으로 응답한다. */
  script?: FakeScriptStep[];
  /**
   * 기본 응답에서 쓸 patch. 지정하지 않으면 "변경 없음"을 뜻하는 빈 patch를 낸다 —
   * 조용히 그럴듯한 patch를 지어내면 테스트가 무엇을 검증하는지 불분명해진다.
   */
  defaultPatch?: string;
  defaultVerdict?: "ACCEPT" | "REVISE" | "REJECT" | "NEED_USER_INPUT";
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 1_200, outputTokens: 340 };

export class FakeProviderAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly modelId: string;
  private readonly entry: ModelEntry;
  private readonly options: FakeProviderOptions;
  private cursor = 0;
  private cancelled = false;
  /** 호출 기록 — 테스트가 "reviewer가 실제로 호출됐는가"를 확인한다. */
  readonly calls: { kind: string; callId: string }[] = [];

  constructor(deps: AdapterDeps, options: FakeProviderOptions = {}) {
    this.entry = deps.entry;
    this.providerId = deps.entry.providerId;
    this.modelId = deps.entry.modelId;
    this.options = options;
  }

  capabilities(): ProviderCapabilitiesView {
    return {
      providerId: this.providerId,
      modelId: this.modelId,
      supportsStructuredOutput: this.entry.capabilities.structuredOutput !== "none",
      supportsToolCalling: this.entry.capabilities.toolCalling !== "none",
      maxContextTokens: this.entry.capabilities.maxContextTokens,
      maxOutputTokens: this.entry.capabilities.maxOutputTokens,
    };
  }

  cancel(): void {
    this.cancelled = true;
  }

  normalizeUsage(raw: unknown): TokenUsage {
    const candidate = (raw ?? {}) as { inputTokens?: number; outputTokens?: number };
    return {
      inputTokens: candidate.inputTokens ?? 0,
      outputTokens: candidate.outputTokens ?? 0,
    };
  }

  normalizeError(raw: unknown): NormalizedProviderError {
    return normalizeProviderError(raw);
  }

  async generateDraft(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<DraftProposal>> {
    const step = await this.consume("draft", ctx);
    const payload = step?.payload ?? {
      interpretation: `(fake) ${input.userMessage}를 처리하기 위한 초안`,
      patch: this.options.defaultPatch ?? "",
      plan: [{ stepId: "step-1", description: "patch 적용", targetPaths: [] }],
      risks: [],
      requiredTests: [],
      uncertainties: [],
      doneCriteria: ["테스트 통과"],
    };
    return {
      value: validateDraftProposal(payload, {
        taskId: ctx.taskId,
        proposalId: `${ctx.taskId}-proposal-${this.cursor}`,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage: step?.usage ?? DEFAULT_USAGE,
      latencyMs: step?.delayMs ?? 1,
    };
  }

  async reviewProposal(input: ReviewInput, ctx: ProviderCallContext): Promise<ProviderResponse<ReviewDecision>> {
    const step = await this.consume("review", ctx);
    const payload = step?.payload ?? {
      verdict: this.options.defaultVerdict ?? "ACCEPT",
      rationale: "(fake) 초안을 독립적으로 검토했고 문제를 찾지 못함",
    };
    return {
      value: validateReviewDecision(payload, {
        taskId: ctx.taskId,
        proposalId: input.draft.proposalId,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage: step?.usage ?? DEFAULT_USAGE,
      latencyMs: step?.delayMs ?? 1,
    };
  }

  async singleModelFix(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<SingleModelFixResult>> {
    const step = await this.consume("singleFix", ctx);
    const payload = step?.payload ?? {
      verdict: "ACCEPT",
      rationale: `(fake) ${input.userMessage}에 대한 단일 모델 수정`,
      patch: this.options.defaultPatch ?? "",
    };
    return {
      value: validateSingleModelFixResult(payload, {
        taskId: ctx.taskId,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage: step?.usage ?? DEFAULT_USAGE,
      latencyMs: step?.delayMs ?? 1,
    };
  }

  async continueWithToolResult(input: FixInput, ctx: ProviderCallContext): Promise<ProviderResponse<SingleModelFixResult>> {
    const step = await this.consume("fix", ctx);
    const payload = step?.payload ?? {
      verdict: "REJECT",
      rationale: "(fake) 검증 실패를 고칠 방법을 제시하도록 스크립트되지 않았음",
      rejectionReason: `attempt ${input.attemptNumber}에 대한 fake 수정안이 없음`,
    };
    return {
      value: validateSingleModelFixResult(payload, {
        taskId: ctx.taskId,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage: step?.usage ?? DEFAULT_USAGE,
      latencyMs: step?.delayMs ?? 1,
    };
  }

  /**
   * 스크립트에서 다음 스텝을 꺼낸다. 취소와 지연을 실제 어댑터와 같은 방식으로 처리한다 —
   * AbortSignal을 존중하지 않는 fake는 취소 경로를 테스트하지 못한다.
   */
  private async consume(kind: FakeScriptStep["kind"], ctx: ProviderCallContext): Promise<FakeScriptStep | undefined> {
    this.calls.push({ kind, callId: ctx.callId });
    this.throwIfAborted(ctx);

    const script = this.options.script;
    let step: FakeScriptStep | undefined;
    if (script) {
      // 이 kind에 해당하는 다음 스텝을 찾는다 — 스크립트를 호출 순서에 정확히 맞추지 않아도
      // 테스트를 쓸 수 있게 한다.
      const index = script.findIndex((s, i) => i >= this.cursor && s.kind === kind);
      if (index >= 0) {
        step = script[index];
        this.cursor = index + 1;
      }
    }

    if (step?.delayMs) {
      await this.sleepRespectingAbort(step.delayMs, ctx);
    }
    this.throwIfAborted(ctx);

    if (step?.throws) {
      const error = new Error(step.throws.message) as Error & { status?: number };
      if (step.throws.name) error.name = step.throws.name;
      if (step.throws.status !== undefined) error.status = step.throws.status;
      throw error;
    }
    return step;
  }

  private throwIfAborted(ctx: ProviderCallContext): void {
    if (this.cancelled || ctx.signal.aborted) {
      const error = new Error("호출이 취소되었습니다");
      error.name = "AbortError";
      throw error;
    }
  }

  private sleepRespectingAbort(ms: number, ctx: ProviderCallContext): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        const error = new Error("호출이 취소되었습니다");
        error.name = "AbortError";
        reject(error);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
