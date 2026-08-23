/**
 * UI가 다루는 형태.
 *
 * 프로토콜 타입의 단일 소스는 `@tomverse/protocol`이지만, UI는 Vite 번들러 환경(bundler
 * moduleResolution)이고 sidecar는 NodeNext라 tsconfig가 다르다. M0에서는 UI가 소비하는
 * 좁은 부분만 여기 두고, UI 빌드를 프로토콜 패키지 빌드에 묶지 않는다 —
 * 나중에 UI에서도 프로토콜을 직접 import하려면 tsconfig 정리가 선행되어야 한다(README 참조).
 *
 * 여기 있는 타입은 프로토콜의 **부분 미러**이며 필드를 추가할 때는 프로토콜을 먼저 바꾼다.
 */

export type TaskPhase =
  | "CREATED"
  | "SNAPSHOTTING"
  | "TRIAGE"
  | "DRAFTING"
  | "SINGLE_MODEL_FIX"
  | "REVIEWING"
  | "AWAITING_USER_INPUT"
  | "PLANNING"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "VERIFYING"
  | "FIX_LOOP"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED"
  | "REJECTED";

export const TERMINAL_PHASES: TaskPhase[] = ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED", "REJECTED"];

/** ui-wireframes.md 2절 — 내부 14 phase를 사용자에게 보이는 단계로 압축한다. */
export type UserStage = "준비 중" | "분석" | "검수" | "확인 필요" | "승인 대기" | "실행" | "검증" | "취소 중" | "완료";

export const STAGE_ORDER: UserStage[] = ["준비 중", "분석", "검수", "승인 대기", "실행", "검증", "완료"];

export function phaseToStage(phase: TaskPhase): UserStage {
  switch (phase) {
    case "CREATED":
    case "SNAPSHOTTING":
    case "TRIAGE":
      return "준비 중";
    case "DRAFTING":
    case "SINGLE_MODEL_FIX":
      return "분석";
    case "REVIEWING":
      return "검수";
    case "AWAITING_USER_INPUT":
      return "확인 필요";
    case "PLANNING":
    case "AWAITING_APPROVAL":
      return "승인 대기";
    case "EXECUTING":
      return "실행";
    case "VERIFYING":
    case "FIX_LOOP":
      return "검증";
    // 취소는 즉시 끝나지 않는다 — 자식 프로세스 종료를 기다리는 구간이 실제로 존재한다.
    // "완료"로 접어버리면 아직 프로세스가 살아 있는 동안 끝난 것처럼 보인다.
    case "CANCELLING":
      return "취소 중";
    default:
      return "완료";
  }
}

export interface TaskEvent {
  taskId: string;
  eventId: number;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalItem {
  requestId: string;
  tool: string;
  riskLevel: "none" | "low" | "medium" | "high" | "prohibited";
  reason: string;
  /** run_command일 때만. 여기 보이는 값이 실제 실행되는 argv와 정확히 같다. */
  command?: { program: string; args: string[]; cwd: string };
  path?: string;
  preview?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  /**
   * 이 명령이 실행될 워크스페이스 루트.
   *
   * **같은 argv라도 대상 저장소가 다르면 다른 동작이다.** 원칙 6이 약속하는 "보인 것과
   * 실행되는 것이 같다"는 워크스페이스까지 보여야 완성된다 — 여러 프로젝트를 오가는 순간
   * 사용자는 자기가 어느 저장소에서 `git clean`을 승인하는지 알 수 없다.
   */
  workspaceRoot: string;
  items: ApprovalItem[];
  createdAt: string;
}

export type VerificationStatus = "PASSED" | "FAILED" | "NOT_CONFIGURED" | "SKIPPED_WITH_REASON" | "TIMED_OUT";

export interface VerificationCheck {
  kind: "build" | "test" | "lint" | "typecheck" | "diff_review";
  command?: { program: string; args: string[]; cwd: string };
  status: VerificationStatus;
  summary: string;
  detail?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface VerificationReport {
  reportId: string;
  phase: "baseline" | "post";
  attemptNumber: number;
  checks: VerificationCheck[];
  newlyFailing?: string[];
  preexistingFailures?: string[];
  overall: "pass" | "fail" | "not_configured" | "could_not_run";
}

/** `list_tasks` / `get_task`가 돌려주는 저장된 작업 한 줄. Rust `TaskRow`의 미러. */
export interface TaskRow {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  workspacePath: string | null;
  mode: string | null;
  userMessage: string;
  currentPhase: TaskPhase;
  terminalStatus: string | null;
  errorSummary: string | null;
  cancellationRequestedAt: string | null;
  mutationCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 저장된 이벤트 — 실시간 `TaskEvent`와 달리 `taskId`가 없다(이미 아는 작업의 것이므로). */
export interface StoredEvent {
  eventId: number;
  seq: number;
  type: string;
  phase: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * 프로토콜 `AcceptanceCriterion`의 부분 미러 — docs/design/state-machine-and-protocol.md 17.2절.
 *
 * **충족 여부 필드가 없는 것은 누락이 아니다.** 기준↔테스트 자동 연결 방법이 아직 없으므로
 * 확인된 기준은 0개이고, 그 사실을 "확인됨: false"가 아니라 "그런 필드가 없음"으로 표현한다.
 * 필드를 두면 언젠가 모델이 그걸 채우게 되고, 그 순간 미확인이 확인으로 둔갑한다.
 */
export interface AcceptanceCriterion {
  criterionId: string;
  text: string;
  source: "user_decision" | "draft_proposal" | "user_message";
  disagreementId?: string;
  decidedAt: string;
}

/** 대조 가능한 필드 — state-machine-and-protocol.md 17.2절. */
/** **판정 가능한** 필드만. 자유 서술은 `NarrativeField`다 — 근거는 17.12절. */
export type DisagreementField = "doneCriteria" | "requiredTests" | "targetPaths";

/** 자유 서술. 비교하지 않고 나란히 보여줄 뿐이다. */
export type NarrativeField = "interpretation" | "risks";

/**
 * 두 초안이 갈린 지점 하나. 프로토콜 `Disagreement`의 부분 미러.
 *
 * **`positions[].proposalId`를 평소 화면에 그리지 않는다**(ui-wireframes 3.9절) — 출처가 보이면
 * 사용자가 요구가 아니라 모델 선호로 판단한다. 개발자 모드 전용이다.
 */
export interface Disagreement {
  disagreementId: string;
  field: DisagreementField;
  positions: { proposalId: string; value: string[] }[];
  blocking: boolean;
  blockingReason: string;
  question: {
    text: string;
    options: { optionId: string; label: string; fromProposalId: string }[];
    allowFreeform: true;
  };
}

/**
 * 각 초안의 자유 서술. **차이를 주장하지 않는다** (17.12절).
 *
 * `Disagreement`와 달리 `blocking`도 `question`도 없다. 물을 수 없는 것에 질문 구조가 달려
 * 있으면 언젠가 카드에 들어가고, 그러면 답할 수 없는 항목이 사용자의 주의를 먹는다.
 */
export interface DraftNarrative {
  field: NarrativeField;
  positions: { proposalId: string; value: string[] }[];
}

/** 3.9절 카드에서 사용자가 고른 답 하나. */
export interface UserDecisionInput {
  disagreementId: string;
  optionId?: string;
  text: string;
}

/** 기준 하나에 대한 결정론적 판정 — state-machine-and-protocol.md 17.3절 규칙 2. */
export type CriterionCheckStatus =
  | "VERIFIED_BY_TEST"
  | "CONTRADICTED_BY_TEST"
  | "CONFLICTS_WITH_CHANGE"
  | "UNVERIFIED";

export interface CriterionEvaluation {
  criterionId: string;
  status: CriterionCheckStatus;
  /** 왜 그 판정인지. 결정론적 근거만 들어간다 — 화면이 이 문장을 그대로 보여준다. */
  reason: string;
  evidence?: string[];
}

export interface FinalResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "rejected";
  failureReason?: string;
  summary: string;
  finalDiff?: string;
  verificationReport?: VerificationReport;
  mutatedPaths?: string[];
  diffs?: [string, string][];
  /** 이 작업에서 확정된 기준. 최종 화면이 체크리스트로 제시한다(ui-wireframes 3.10절). */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** 예산이 모자라 묻지 못한 blocking 쟁점 — 있으면 숨기지 않는다(17.4절). */
  unresolvedDisagreements?: string[];
  /**
   * 기준별 판정. 비어 있거나 없으면 **아무것도 확인되지 않았다는 뜻**이지 충족했다는 뜻이 아니다.
   */
  criterionEvaluations?: CriterionEvaluation[];
  /** 예산 결말. 성공·실패를 가리지 않고 온다 — 돈은 결과와 무관하게 나갔다. */
  budget?: TaskBudgetOutcome;
}

/**
 * 이 자격증명으로 **실제로 쓸 수 있는** 모델 (multi-engine-routing.md 15절).
 *
 * 전체 카탈로그가 아니다 — 화면이 거르면 화면과 라우터가 서로 다른 규칙을 갖게 되어
 * "고를 수 있게 보였는데 시작하면 거부되는" 모델이 생긴다.
 */
export interface AvailableModel {
  modelId: string;
  providerId: string;
  inputPerMTok: number;
  outputPerMTok: number;
  maxContextTokens: number;
  /**
   * 이 모델 한 번 호출의 **최대 비용** — 예산 원장이 예약할 바로 그 수다.
   *
   * **화면이 계산하지 않는다.** 같은 공식이 두 벌이 되면 "예상"과 "실제로 예약되는 금액"이
   * 조용히 갈라지고, 화면은 통과라고 말하는데 시작하면 거부되는 상태가 된다.
   *
   * 가격을 모르는 모델에는 **없다**(0이 아니다).
   */
  maxCallCostUsd?: number;
}

/**
 * 자격증명 확인 결과 (multi-engine-routing.md 17절).
 *
 * `listed`는 **"조회된다"이지 "호출된다"가 아니다.** 조직 인증이 필요한 모델은 조회되고
 * 추론에서 죽는다(gpt-5 사례) — 화면이 이 구별을 지우면 확인이 보증으로 읽힌다.
 */
export interface CredentialCheck {
  providerId: string;
  modelId: string;
  status: "listed" | "auth_failed" | "model_unavailable" | "unreachable";
  detail: string;
}

export interface WorkspaceInfo {
  rootPath: string;
  name: string;
  workspaceId: string;
  sessionId: string;
  /**
   * 이 워크스페이스에서 허용된 공급자 (multi-engine-routing.md 16절).
   *
   * `null`은 **제한 없음**, `[]`는 **아무것도 허용하지 않음**이다 — 다른 사실이다.
   */
  allowedProviders: string[] | null;
  /**
   * 키는 있는데 **정책이 막은** 공급자.
   *
   * "키가 없다"와 뭉개면 사용자는 없는 키를 찾아 헤매거나, 자기가 건 제한을 잊는다.
   */
  providersBlockedByPolicy: string[];
}

export interface ProviderStatus {
  providers: { providerId: string; envName: string; configured: boolean }[];
  source: string;
  isDevelopmentOnly: boolean;
  crossVerificationPossible: boolean;
  protocolVersion: string;
}

export interface RoutingInfo {
  complexityTier: "simple" | "standard";
  activeRoles: string[];
  assignments: { role: string; modelId: string; providerId: string; reason: string }[];
  appliedPolicies: string[];
  reviewerIndependent: boolean;
  estimatedCostUsd: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

/**
 * `revert_task_commit`의 결과 — Rust `TaskHost::revert_commit`이 돌려주는 것과 같은 모양이다.
 *
 * `conflicted`와 `cleanedUp`을 **따로 두는 이유**: "충돌했다"와 "그래서 저장소가 어떤 상태인가"는
 * 다른 사실이다. 충돌했지만 원상복구된 경우(사용자가 할 일 없음)와 충돌 후 원상복구까지 실패한
 * 경우(저장소가 revert 진행 중, 사용자가 지금 손대야 함)를 하나의 불리언으로 합치면 화면이
 * 후자를 전자처럼 말하게 된다.
 */
export interface RevertOutcome {
  reverted: boolean;
  sha?: string;
  paths?: string[];
  /** revert가 시작됐지만 충돌했는가. 시작조차 못 한 실패는 `false`다. */
  conflicted?: boolean;
  /** 저장소가 누르기 전 상태로 돌아왔는가. `false`면 revert 진행 중으로 남아 있다. */
  cleanedUp?: boolean;
  /** 충돌한 파일 — `git revert --abort` **전에** 읽은 것이라 abort 뒤에도 남는다. */
  conflicts?: string[];
  reason?: string;
}

/**
 * 강제 포기 버튼을 열 시점과 **그 값이 어디서 왔는지** (state-machine-and-protocol.md 16.3절).
 *
 * `source`가 값과 함께 오는 이유: 표본이 부족하면 `ms`는 여전히 추정치인데, 숫자만 받으면
 * 화면이 그것을 측정값으로 말하게 된다. 12절이 지적한 문제가 정확히 그것이었다.
 */
export interface ForceAbandonThreshold {
  ms: number;
  source: "measured" | "default_insufficient_samples";
  sampleCount: number;
  minSamples: number;
}

/**
 * "이 계획은 이 워크스페이스 기준으로 큰가"의 문턱 (19.6절).
 *
 * 파일 수로 재는 이유: 커밋 하나가 담는 것이 파일이고, 되돌리기가 전부-아니면-전무인 단위도
 * 그 커밋이다. 줄 수로 재면 한 파일의 큰 변경과 여러 파일의 작은 변경이 같아 보이는데,
 * 태스크를 쪼개는 문제에서 그 둘은 전혀 다르다.
 */
export interface LargeChangeThreshold {
  files: number;
  source: "measured" | "default_insufficient_samples";
  sampleCount: number;
  minSamples: number;
}

/**
 * 태스크당 예산 상한의 **제안값** (multi-engine-routing.md 10.6절).
 *
 * 제안은 승인이 아니다 — 화면은 이 값으로 입력란을 채우고, 실제로 강제되는 것은 사용자가
 * 확인한 값이다. `source`가 함께 오는 이유는 다른 문턱들과 같다: 표본이 부족하면 그 값은
 * 여전히 추정치인데, 숫자만 넘기면 화면이 그것을 측정값으로 말하게 된다.
 */
export interface TaskBudgetThreshold {
  usd: number;
  source: "measured" | "default_insufficient_samples";
  sampleCount: number;
  minSamples: number;
  /** 관측된 지출에 곱한 여유 배수. 예약은 최대 비용으로 열리고 확정은 실제 비용으로 되므로 필요하다. */
  headroomMultiplier: number;
}

/** `derived_thresholds`가 돌려주는 것. 문턱은 워크스페이스를 열 때 한 번만 읽는다. */
export interface DerivedThresholds {
  forceAbandon: ForceAbandonThreshold | null;
  largeChange: LargeChangeThreshold | null;
  taskBudget: TaskBudgetThreshold | null;
}

/**
 * 이 태스크가 공급자 호출에 실제로 쓴 돈 (multi-engine-routing.md 10.6절).
 *
 * `not_enforced`를 `ok`와 같게 그리지 않는 것이 이 타입의 요점이다 — "상한 안에서 끝났다"와
 * "상한이 없었다"는 정반대의 사실이다.
 */
export interface TaskBudgetOutcome {
  limitUsd: number | null;
  /** 가격을 아는 호출만 더한 값. `unpricedCalls > 0`이면 **하한이다.** */
  spentUsd: number;
  unresolvedUsd: number;
  unpricedCalls: number;
  state: "not_enforced" | "ok" | "limit_reached" | "blocked";
  detail?: string;
}

/**
 * 자유 텍스트에서 발견된 자격증명 **모양의 이름과 개수** (17.11절).
 *
 * 값 자체는 담기지 않는다 — UI는 이미 그 텍스트를 갖고 있고, 프로세스 경계를 넘는 곳마다
 * 자격증명 사본이 하나씩 늘어나는 것은 그 자체로 노출면이다.
 */
export interface SecretShapeHit {
  label: string;
  count: number;
}

/** 한 공급자에게 나간 것 (product-strategy.md 7절). */
export interface ProviderTransmission {
  providerId: string;
  calls: number;
  roles: string[];
  /** **요청한** 모델. 우리가 보낸 값이라 언제나 우리 기대와 같다. */
  models: string[];
  /** **공급자가 응답했다고 밝힌** 모델. 비어 있으면 "같았다"가 아니라 "모른다"다. */
  resolvedModels: string[];
  /** 요청한 모델과 응답한 모델이 다른 호출이 있었는가 — 조용한 대체(product-strategy 6절). */
  substituted: boolean;
  /** 공급자 쪽 요청 id. 감사에서 공급자 로그와 대조할 유일한 열쇠다. */
  providerRequestIds: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * 이 작업에서 무엇이 어느 공급자로 나갔는가.
 *
 * `sentFiles`와 `namedOnlyFiles`를 **따로 두는 이유**: 내용이 나간 것과 경로만 나간 것은 다른
 * 사실이다. 한 목록에 섞으면 둘 다 뜻을 잃고, 특히 후자가 "아무것도 안 나갔다"로 읽힌다.
 */
export interface Transmission {
  taskId: string;
  /** 컨텍스트를 모은 적이 있는가. false와 "빈 목록"은 다른 사실이다. */
  snapshotTaken: boolean;
  providers: ProviderTransmission[];
  sentFiles: { path: string; reason: string; truncated: boolean }[];
  namedOnlyFiles: { path: string; reason: string }[];
  /** **저장 기록에서** 가려진 자격증명 모양의 수. 보낸 것에서 가려진 수가 아니다(17.11절). */
  secretShapesMaskedInLog: number;
  freeTextAnswers: number;
}
