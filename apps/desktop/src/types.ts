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
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "REJECTED";

/** ui-wireframes.md 2절 — 내부 14 phase를 사용자에게 보이는 단계로 압축한다. */
export type UserStage = "준비 중" | "분석" | "검수" | "확인 필요" | "승인 대기" | "실행" | "검증" | "완료";

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

export interface FinalResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "rejected";
  failureReason?: string;
  summary: string;
  finalDiff?: string;
  verificationReport?: VerificationReport;
  mutatedPaths?: string[];
  diffs?: [string, string][];
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
