import type {
  DraftProposal,
  ModelEntry,
  NormalizedProviderError,
  ProviderCapabilitiesView,
  ReviewDecision,
  SingleModelFixResult,
  TokenUsage,
  VerificationDigest,
  WorkspaceSnapshot,
} from "@tomverse/protocol";

/**
 * 공급자 중립 인터페이스 — 작업 지침 4.6절.
 *
 * 설계 원칙: 어댑터는 **프롬프트 조립 + 구조화 출력 강제 + 응답 정규화**만 한다.
 * 상태 머신 판단(다음 phase, 재시도 여부)은 Orchestrator가 하고, 어댑터는 그 판단에 필요한
 * 재료(정규화된 오류 종류, usage)를 제공한다.
 */

export interface ProviderCallContext {
  taskId: string;
  /** "draft:1", "review:2", "fix:1" — providerRetries 카운터의 키와 같다 */
  callId: string;
  /** 취소 신호. 어댑터는 이걸 SDK의 abort signal로 전달해야 한다. */
  signal: AbortSignal;
  timeoutMs: number;
}

export interface DraftInput {
  snapshot: WorkspaceSnapshot;
  userMessage: string;
  /** AWAITING_USER_INPUT을 거쳐 돌아온 경우의 사용자 답변 */
  userAnswers?: { question: string; answer: string }[];
}

export interface ReviewInput {
  snapshot: WorkspaceSnapshot;
  userMessage: string;
  draft: DraftProposal;
  /**
   * Blind Review 여부 (product-strategy.md 4절).
   * true면 초안 작성자의 자기설명(`interpretation`, `risks` 등)을 검수자에게 보여주지 않는다.
   * M0에서는 기본 false — Blind Review는 M1의 차별화 항목이며, 여기서는 축만 열어둔다.
   */
  blind?: boolean;
}

export interface FixInput {
  snapshot: WorkspaceSnapshot;
  userMessage: string;
  /** 직전에 적용된 변경 (전체 스냅샷 재전송 대신 delta만 — 문서 6절) */
  appliedDiff: string;
  digest: VerificationDigest;
  attemptNumber: number;
}

export interface ProviderResponse<T> {
  value: T;
  usage: TokenUsage;
  latencyMs: number;
  /** 응답 원문을 보관하지 않는다 — 작업 지침 4.6절 "provider 응답 원문 전체를 일반 로그에 남기지 않는다" */
  raw?: never;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly modelId: string;

  capabilities(): ProviderCapabilitiesView;

  /** DRAFTING / SINGLE_MODEL_FIX — executor 역할 */
  generateDraft(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<DraftProposal>>;

  /** REVIEWING — reviewer 역할 */
  reviewProposal(input: ReviewInput, ctx: ProviderCallContext): Promise<ProviderResponse<ReviewDecision>>;

  /**
   * SINGLE_MODEL_FIX — 검토할 초안 없이 곧바로 최종안/모호함/거부를 판정한다.
   * DraftProposal과 달리 verdict를 갖는다(state-machine-and-protocol.md 4b절, 14.1절).
   */
  singleModelFix(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<SingleModelFixResult>>;

  /**
   * FIX_LOOP — VerificationReport(정확히는 digest)만을 근거로 수정한다.
   * 이름이 `continueWithToolResult`인 이유: M0의 유일한 "도구 결과로 이어가기"가 검증 결과 재전달이다.
   * 일반적인 tool-call 루프로 확장될 때 같은 자리에 들어간다.
   */
  continueWithToolResult(input: FixInput, ctx: ProviderCallContext): Promise<ProviderResponse<SingleModelFixResult>>;

  /** 진행 중 호출 취소. AbortSignal로 이미 전달되지만, 명시적 정리 지점을 둔다. */
  cancel(): void;

  normalizeUsage(raw: unknown): TokenUsage;
  normalizeError(raw: unknown): NormalizedProviderError;
}

export interface AdapterDeps {
  entry: ModelEntry;
  apiKey: string;
}
