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
  overall: "pass" | "fail" | "not_verified";
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
}

export interface WorkspaceInfo {
  rootPath: string;
  name: string;
  workspaceId: string;
  sessionId: string;
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
