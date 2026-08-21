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
import type { DispatchState } from "../budget/ledger.js";
import { estimateTokensUpperBound } from "../context/budget.js";
import {
  buildDraftPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildSingleModelFixPrompt,
} from "./prompts.js";
import { normalizeProviderError } from "./errors.js";
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
  /**
   * 이 스텝이 던질 오류 (재시도/타임아웃 경로 테스트용).
   *
   * `dispatchState`를 주면 실제 어댑터처럼 `ProviderCallFailure`를 던진다 — 응답을 받은 뒤
   * 파싱/스키마에서 실패한 경우(=과금됐을 수 있는 경우)를 fake로 재현하기 위한 것이다.
   * 주지 않으면 예전처럼 평범한 `Error`를 던진다(기존 재시도 테스트가 그 경로를 쓴다).
   */
  throws?: {
    message: string;
    status?: number;
    name?: string;
    dispatchState?: DispatchState;
    usage?: TokenUsage;
  };
  /** 응답 지연 (타임아웃 테스트용) */
  delayMs?: number;
  /** 구조화 출력으로 반환할 값. 검증을 거치므로 잘못된 형태면 여기서 걸린다. */
  payload?: Record<string, unknown>;
  usage?: TokenUsage;
  /**
   * 이 응답의 **envelope 모델 ID**. 지정하지 않으면 요청 모델 ID와 같다.
   *
   * 조용한 대체(공급자가 다른 모델로 응답)를 테스트하려면 여기에 다른 값을 넣는다.
   * `null`은 "envelope에 model이 없음"을 뜻한다 — 그것도 검증이 막아야 하는 상태다.
   */
  providerReportedModelId?: string | null;
}

export interface FakeProviderOptions {
  /**
   * 스크립트가 지정하지 않을 때 쓸 envelope 모델 ID. 기본은 요청 모델 ID와 같다.
   * `null`이면 envelope에 model이 없는 공급자를 흉내낸다.
   */
  providerReportedModelId?: string | null;
  /** 순서대로 소비되는 스크립트. 비면 기본 동작(아래 defaults)으로 응답한다. */
  script?: FakeScriptStep[];
  /**
   * 모델별 스크립트. **대조(executor ×2)를 테스트하려면 이게 필요하다.**
   *
   * `script` 하나만 있으면 두 실행자가 같은 스크립트를 **각자 처음부터** 소비한다 —
   * 어댑터 인스턴스가 다르니 커서도 따로이기 때문이다. 그러면 두 초안이 언제나 같아져
   * 불일치를 만들 수 없다. 실측으로 그렇게 대조 테스트가 조용히 통과했다.
   *
   * 여기 키가 있으면 그 모델은 이 스크립트를 쓰고, 없으면 `script`로 떨어진다.
   */
  scriptByModel?: Record<string, FakeScriptStep[]>;
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

  /**
   * 실제 어댑터와 **같은 계약**으로 메타데이터를 만든다.
   *
   * fake가 이 필드를 안 채우면 fake로 도는 테스트는 exact-model 검증 경로를 전혀 지나지 않고,
   * 결함은 실제 공급자에서만 처음 드러난다. 그래서 fake도 envelope을 흉내낸다.
   */
  /**
   * fake도 **실제 프롬프트를 조립해서** 입력 토큰을 추정한다.
   *
   * 네트워크로 나가지 않으므로 조립할 이유가 없어 보이지만, 그러면 추정→기록→집계 배선이
   * fake 경로에서 통째로 비어 있게 된다 — e2e가 통과해도 그 통과가 배선에 대해 아무것도
   * 말하지 않는다. 그리고 `renderSnapshot`을 실제로 태우므로 **스냅샷이 프롬프트에서
   * 차지하는 크기**가 테스트에서 눈에 보인다.
   */
  private metaFor(step: FakeScriptStep | undefined, prompt?: string): ProviderCallMetadata {
    const scripted = step?.providerReportedModelId !== undefined ? step.providerReportedModelId : this.options.providerReportedModelId;
    const reported = scripted === undefined ? this.modelId : scripted;
    return {
      requestedModelId: this.modelId,
      ...(reported === null ? {} : { providerReportedModelId: reported }),
      providerRequestId: `fake-req-${this.cursor}`,
      dispatchState: "response_received_with_usage",
      // 프롬프트를 모르는 경로(오류 주입 등)에서는 **키를 넣지 않는다.** 0으로 채우면
      // 집계가 그것을 "추정이 0이었다"로 읽고, 그건 무한대 배 과소 추정이다.
      ...(prompt === undefined ? {} : { estimatedInputTokens: estimateTokensUpperBound(prompt) }),
    };
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
        // **모델 ID를 넣는다.** 대조에서는 초안이 둘이고 둘 다 cursor가 1이라, 모델을 빼면
        // 두 초안의 proposalId가 같아진다 — 그러면 `Disagreement.positions`가 어느 초안의
        // 값인지 추적하지 못한다(3.9절 선택지 출처).
        proposalId: `${ctx.taskId}-${this.modelId}-proposal-${this.cursor}`,
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage: step?.usage ?? DEFAULT_USAGE,
      latencyMs: step?.delayMs ?? 1,
      meta: this.metaFor(step, buildDraftPrompt(input)),
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
        // 프롬프트를 어떻게 구성했는지에 대한 사실이므로 우리가 기록한다 — 모델에게 묻지 않는다.
        reviewMode: input.blind ? "blind" : "informed",
        model: this.modelId,
        createdAt: new Date().toISOString(),
      }),
      usage: step?.usage ?? DEFAULT_USAGE,
      latencyMs: step?.delayMs ?? 1,
      meta: this.metaFor(step, buildReviewPrompt(input)),
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
      meta: this.metaFor(step, buildSingleModelFixPrompt(input)),
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
      meta: this.metaFor(step, buildFixPrompt(input)),
    };
  }

  /**
   * 스크립트에서 다음 스텝을 꺼낸다. 취소와 지연을 실제 어댑터와 같은 방식으로 처리한다 —
   * AbortSignal을 존중하지 않는 fake는 취소 경로를 테스트하지 못한다.
   */
  private async consume(kind: FakeScriptStep["kind"], ctx: ProviderCallContext): Promise<FakeScriptStep | undefined> {
    this.calls.push({ kind, callId: ctx.callId });
    this.throwIfAborted(ctx);

    const script = this.options.scriptByModel?.[this.modelId] ?? this.options.script;
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
      if (step.throws.dispatchState !== undefined) {
        const meta = this.metaFor(step);
        throw new ProviderCallFailure({
          message: step.throws.message,
          dispatchState: step.throws.dispatchState,
          classification: normalizeProviderError(
            Object.assign(new Error(step.throws.message), { status: step.throws.status })
          ),
          ...(step.throws.usage ? { usage: step.throws.usage } : {}),
          ...(meta.providerReportedModelId ? { providerReportedModelId: meta.providerReportedModelId } : {}),
          ...(step.throws.status !== undefined ? { status: step.throws.status } : {}),
        });
      }
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
