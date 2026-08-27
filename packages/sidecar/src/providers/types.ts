import type {
  AcceptanceCriterion,
  DraftProposal,
  ModelEntry,
  NormalizedProviderError,
  ProviderCapabilitiesView,
  PlanOutline,
  QuestionAnswer,
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
  /**
   * 직전 계획을 **게이트가 거부해서** 다시 요청하는 경우의 사유 (state-machine 42절).
   *
   * `criteriaFeedback`과 섞지 않는다. 저쪽은 "사용자가 정한 것과 어긋난다"이고 이건 "우리가
   * 받지 않는 모양이다" — 모델이 고쳐야 할 것이 다르므로 프롬프트에서도 다른 문단이다.
   */
  gateFeedback?: string[];
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
  /** 적용된 변경의 **목차**(경로·크기). 내용이 아니다 — 내용은 스냅샷이 나른다. */
  appliedChanges: string;
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

/**
 * **응답을 받은 뒤** 하는 검증의 실패를 usage와 함께 던진다.
 *
 * # 왜 필요한가 — 과금된 호출이 "비용 미측정"이 되고 있었다
 *
 * 어댑터는 응답을 받아 usage를 손에 쥔 상태에서 `validate*`를 부른다. 그 검증이 던지면
 * **usage와 envelope 사실이 예외와 함께 사라진다** — 호출자가 보는 것은 "스키마 위반"뿐이고,
 * 비용을 계산할 근거가 없으니 `dispatched_no_response`가 된다.
 *
 * 그 상태는 예산 관점에서 최악이다. 돈은 확실히 나갔는데(응답을 받았다) 얼마인지 모르므로
 * 예약을 정산할 수도 해제할 수도 없고, 실행이 미해결 예약으로 멈춘다. 문서가 이미 경고한
 * 경우다 — 공급자가 응답을 만들고 과금한 뒤 파싱에서 실패하면, "예외가 났으니 해제"는 쓴 돈을
 * 안 쓴 것으로 만드는 것이다.
 *
 * 실측(가설 게이트 P1, 2026-08-27): 검수 호출이 171초 동안 출력 상한까지 달리다 잘려 구조화
 * 출력이 깨졌다. 응답도 usage도 있었지만 검증이 던지면서 전부 버려졌고, **96건짜리 실행이
 * 7건에서 멈췄다.**
 *
 * usage를 실어 보내면 그 기록은 `schema_violation` — **모델/파이프라인 실패**, 즉 정상적인
 * 실험 결과가 된다. 예산 사고가 아니라 데이터다.
 */
export function validateReceived<T>(
  validate: () => T,
  received: { usage: TokenUsage; latencyMs: number; meta: ProviderCallMetadata }
): T {
  try {
    return validate();
  } catch (error) {
    // 이미 dispatch 사실을 아는 오류면 그대로 둔다 — 여기서 다시 감싸면 분류가 덮인다.
    if (error instanceof ProviderCallFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderCallFailure({
      message: `응답을 받았으나 구조화 출력 검증에 실패했습니다: ${message}`,
      // **응답을 받았다는 사실이 요점이다.** 이 값이 있어야 예약이 실제 비용으로 정산된다.
      dispatchState: received.meta.dispatchState,
      classification: { kind: "schema_violation", message, status: 400, retryable: false },
      usage: received.usage,
      ...(received.meta.providerReportedModelId
        ? { providerReportedModelId: received.meta.providerReportedModelId }
        : {}),
      ...(received.meta.providerRequestId ? { providerRequestId: received.meta.providerRequestId } : {}),
      latencyMs: received.latencyMs,
      status: 400,
    });
  }
}

/**
 * 자격증명 확인 결과 (multi-engine-routing.md 17절).
 *
 * # 이 확인이 증명하는 것과 증명하지 못하는 것
 *
 * **증명하는 것**: 이 키로 이 모델을 조회할 수 있다. 키가 틀렸거나 만료됐거나 다른
 * 프로젝트의 것이면 여기서 걸린다 — 실사용에서 가장 흔한 실패다.
 *
 * **증명하지 못하는 것**: 실제 호출이 성공한다는 것. 조직 인증이 필요한 모델은 목록 조회는
 * 되고 추론에서 `model_not_found`가 난다(gpt-5 사례). 그래서 결과 이름이 `ok`가 아니라
 * `listed`다 — "된다"가 아니라 "조회된다"이고, 그 차이가 이 제품이 지키려는 구별이다.
 *
 * # 왜 무료 엔드포인트인가
 *
 * 최소 추론 호출로 확인하면 더 강한 사실을 얻지만 **돈이 나간다.** 그리고 그 호출은 태스크에
 * 속하지 않으므로 예산 원장에도 전송 기록에도 자리가 없다 — 기록되지 않는 지출이 생긴다.
 * 유료 확인은 가설 게이트의 `probe-models`가 하고(그건 Run Card로 승인받는다), 제품은
 * 무료로 알 수 있는 것까지만 한다.
 */
export interface CredentialCheck {
  providerId: string;
  modelId: string;
  /**
   * `listed` — 이 자격증명으로 모델이 조회됐다.
   * `auth_failed` — 키가 거부됐다(401/403).
   * `model_unavailable` — 키는 받아들여졌지만 그 모델이 없다.
   * `unreachable` — 네트워크/타임아웃. **키 문제가 아니다**를 구별해야 사용자가 키를 다시 만들지 않는다.
   */
  status: "listed" | "auth_failed" | "model_unavailable" | "unreachable";
  /** 사람이 읽는 사유. 자격증명 값은 담지 않는다. */
  detail: string;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly modelId: string;

  capabilities(): ProviderCapabilitiesView;

  /**
   * 이 자격증명으로 이 모델이 **조회되는가** (17절).
   *
   * 유료 호출을 하지 않는다 — 무료 모델 조회 엔드포인트만 쓴다. 그래서 "호출된다"는
   * 증명하지 못하며, 결과 타입이 그 사실을 이름으로 말한다.
   */
  checkCredential(signal?: AbortSignal): Promise<CredentialCheck>;

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
   * ANSWERING — 질문에 답한다 (state-machine 51절).
   *
   * **`generateDraft`와 입력이 같고 출력이 다르다.** 같은 스냅샷을 보되 patch가 아니라 답을
   * 낸다. 입력을 공유하는 것이 중요하다 — 전송 투명성 집계가 "모든 프롬프트가 같은 스냅샷을
   * 싣는다"에 기대고 있다(transmission.rs).
   */
  answerQuestion(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<QuestionAnswer>>;

  /**
   * OUTLINING — 계획을 낸다 (state-machine 53절).
   *
   * `answerQuestion`과 같은 자리다. **출력에 patch가 없는 것이 이 역할의 정의**이며,
   * 그래서 `generateDraft`와 한 함수로 합치지 않는다 — 합치면 "patch를 만들지 않는다"가
   * 호출자의 약속이 되고, 약속은 코드보다 먼저 낡는다.
   */
  outlinePlan(input: DraftInput, ctx: ProviderCallContext): Promise<ProviderResponse<PlanOutline>>;

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
  /**
   * HTTP 전송 계층 주입 — **적합성 스위트가 실제 어댑터를 태우기 위한 것이다.**
   *
   * 왜 프로덕션 타입에 두는가: 이게 없으면 어댑터의 본체(요청 조립 → envelope 해석 →
   * 정규화)는 **네트워크가 있어야만 검증된다.** 즉 유료 실행에서만 확인되고, 그 확인은
   * 실패했을 때 이미 돈을 쓴 뒤다. 그런데 "어댑터는 서로 바꿔 끼울 수 있다"는 전제 위에
   * 가설 게이트의 비교가 서 있으므로(multi-engine-routing.md 2절), 그 전제는 **공짜로 자주**
   * 검증되어야 한다.
   *
   * 주입하지 않으면 SDK 기본 전송을 쓴다 — 프로덕션 경로는 달라지지 않는다.
   */
  fetch?: typeof globalThis.fetch;
}
