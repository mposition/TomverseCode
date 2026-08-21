import type {
  AcceptanceCriterion,
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
import type { DispatchState } from "../budget/ledger.js";
import { redactSecrets } from "./redact.js";

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
  /**
   * 확정된 기준 (state-machine-and-protocol.md 17.3절 규칙 1).
   *
   * `userAnswers`와 **따로** 넘긴다. 답변은 대화 기록이고 기준은 **구속 조건**이라, 프롬프트에서
   * 같은 자리에 놓으면 모델이 참고 사항으로 읽는다. 프롬프트에 넣는다고 강제력이 생기는 것은
   * 아니지만(그래서 PLANNING 게이트가 따로 있다), 넣지 않으면 강제할 대상조차 없다.
   */
  acceptanceCriteria?: AcceptanceCriterion[];
  /**
   * 직전 계획이 기준과 충돌해 다시 요청하는 경우의 사유.
   *
   * 검증 실패가 아니라 **실행 전** 사유이므로 FIX_LOOP digest와 섞지 않는다 —
   * 아직 아무것도 적용되지 않았고, 모델이 "적용된 변경을 고치는" 모드로 읽으면 안 된다.
   */
  criteriaFeedback?: string[];
}

export interface ReviewInput {
  snapshot: WorkspaceSnapshot;
  userMessage: string;
  draft: DraftProposal;
  /**
   * 검수자가 확인해야 할 기준 (17.1절 REVIEWING 행).
   *
   * 검수자의 역할이 "초안이 옳은지 자유 재량으로 판단"에서 **"사용자가 고정한 기준이 반영됐는지
   * 확인"**으로 바뀌었다. 자유 재량보다 훨씬 검증 가능한 역할이고, 검수자에게 결정론에 가까운
   * 기준을 준다(product-strategy.md 16.3절).
   */
  acceptanceCriteria?: AcceptanceCriterion[];
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

/**
 * 어댑터 계약 버전.
 *
 * `ProviderResponse`의 모양이나 exact-model 검증에 쓰이는 필드가 바뀌면 올린다. probe evidence에
 * 박아 두므로, 계약이 바뀐 뒤 예전 evidence로 유료 실행을 승인하는 것을 막는다 —
 * "그때 확인한 것"과 "지금 검증하는 것"이 다른 계약이면 그 확인은 이 실행을 보증하지 않는다.
 *
 * 2: 응답 envelope의 모델 ID(`providerReportedModelId`)와 dispatch 상태를 실어 나르기 시작.
 */
export const ADAPTER_CONTRACT_VERSION = "2";

/**
 * 공급자 호출 메타데이터 — **응답 envelope이 말한 사실.**
 *
 * # 왜 `DraftProposal.model`로는 안 되는가
 *
 * `validateDraftProposal`은 `model` 필드에 `this.modelId`를 **우리가 넣는다.** 그건 우리가
 * 요청한 모델 ID이고, 공급자가 무엇으로 응답했는지와는 무관하다. 그 값으로 "요청한 모델이
 * 그대로 왔다"를 판정하면 항상 통과한다 — 즉 조용한 대체를 절대 잡지 못한다.
 *
 * 그래서 응답 envelope의 `model` 필드를 따로 실어 나른다. 없으면 `undefined`이며,
 * **요청 ID로 대체하지 않는다** — 모르는 것을 아는 것처럼 적으면 검증이 무의미해진다.
 */
export interface ProviderCallMetadata {
  /** 우리가 요청한 모델 ID. */
  requestedModelId: string;
  /** 응답 envelope이 실어 온 모델 ID. 없으면 `undefined`(요청 ID로 채우지 않는다). */
  providerReportedModelId?: string;
  /** 공급자 요청 ID(제공되는 경우). 자격증명이 아니며 공급자 지원 문의에 쓸 수 있다. */
  providerRequestId?: string;
  /** 요청이 실제로 나갔는가 — 과금 가능성 판정의 근거다. */
  dispatchState: DispatchState;
  /**
   * **우리가** 이 요청의 입력 토큰으로 추정했던 수 (`context/budget.ts`).
   *
   * `usage.inputTokens`(공급자가 보고한 실제)와 나란히 두는 것이 요점이다. 우리 추정은
   * 상한이라고 주장하는 값인데, 그 주장이 참인지는 두 수를 비교해야만 알 수 있다.
   * 하나만 남기면 계수를 고칠 근거가 감밖에 없다.
   *
   * 없을 수 있다 — 추정하지 않은 경로가 있으면 그 사실이 `undefined`로 남아야 하고,
   * 0으로 채우면 "추정이 0이었다"(=무한대 배 과소 추정)로 집계된다.
   */
  estimatedInputTokens?: number;
}

export interface ProviderResponse<T> {
  value: T;
  usage: TokenUsage;
  latencyMs: number;
  /** 응답 envelope이 말한 사실. exact-model 검증은 **이것만** 쓴다. */
  meta: ProviderCallMetadata;
  /** 응답 원문을 보관하지 않는다 — 작업 지침 4.6절 "provider 응답 원문 전체를 일반 로그에 남기지 않는다" */
  raw?: never;
}

/**
 * 호출이 실패했지만 **과금됐을 수 있는** 경우에 던지는 오류 (§6).
 *
 * 공급자가 응답을 만들고 과금한 뒤 JSON 파싱이나 스키마 검증에서 실패할 수 있다. 그때 평범한
 * `Error`를 던지면 호출자는 "요청이 나갔는지"조차 알 수 없고, 그러면 예약을 해제(=쓴 돈을
 * 안 쓴 것으로 만들기)하는 쪽으로 기울게 된다. 그래서 **아는 사실을 오류에 실어 보낸다.**
 *
 * 메시지는 `redactSecrets`를 지난 값만 담는다 — 공급자 오류 본문에 요청 헤더가 되돌아오는
 * 경우가 있고, 결과 파일 저장 단계의 사후 검사만으로는 stdout에 이미 나간 것을 되돌릴 수 없다.
 */
export class ProviderCallFailure extends Error {
  readonly dispatchState: DispatchState;
  readonly usage?: TokenUsage;
  readonly providerReportedModelId?: string;
  readonly providerRequestId?: string;
  readonly latencyMs?: number;
  readonly classification: NormalizedProviderError;

  constructor(input: {
    message: string;
    dispatchState: DispatchState;
    classification: NormalizedProviderError;
    usage?: TokenUsage;
    providerReportedModelId?: string;
    providerRequestId?: string;
    latencyMs?: number;
    /** HTTP 상태 — 기존 재시도 분류기가 읽는다. */
    status?: number;
  }) {
    super(redactSecrets(input.message));
    this.name = "ProviderCallFailure";
    this.dispatchState = input.dispatchState;
    this.classification = input.classification;
    if (input.usage !== undefined) this.usage = input.usage;
    if (input.providerReportedModelId !== undefined) this.providerReportedModelId = input.providerReportedModelId;
    if (input.providerRequestId !== undefined) this.providerRequestId = input.providerRequestId;
    if (input.latencyMs !== undefined) this.latencyMs = input.latencyMs;
    if (input.status !== undefined) (this as { status?: number }).status = input.status;
  }
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
