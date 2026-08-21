import type { ComplexityTier, ISODateTime } from "./common.js";
import type { AcceptanceCriterion } from "./decision.js";
import type { RoutingDecision } from "./registry.js";
import type { CommandPolicy } from "./tools.js";
import type { VerificationReport } from "./verification.js";

export interface TaskRequest {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  userMessage: string;
  attachments?: { path: string; note?: string }[];
  createdAt: ISODateTime;
}

/**
 * docs/design/state-machine-and-protocol.md 2.2절 — 모든 루프 상한은 여기서 읽는다.
 * CLAUDE.md 원칙 5: 상한을 하드코딩하지 않고, 상한 없는 루프를 만들지 않는다.
 */
export interface TaskLoopLimits {
  clarificationRounds: number; // 기본 2
  reviseRounds: number; // 기본 2
  fixLoopRounds: number; // 기본 3
  toolRetries: number; // 기본 2
  providerRetries: number; // 기본 3
}

export const DEFAULT_LOOP_LIMITS: TaskLoopLimits = {
  clarificationRounds: 2,
  reviseRounds: 2,
  fixLoopRounds: 3,
  toolRetries: 2,
  providerRetries: 3,
};

/**
 * 사용자가 UI에서 고르는 실행 정책 (ui-wireframes.md / 작업 지침 4.9절).
 * - fast: TRIAGE가 simple로 분류하면 단일 모델 경로를 그대로 쓴다.
 * - verified: TRIAGE 결과와 무관하게 항상 standard(교차검증) 경로 — forceComplexityTier와 같다.
 *
 * 둘 중 어느 쪽이든 VERIFYING은 생략되지 않는다(CLAUDE.md 원칙 1).
 */
export type ExecutionMode = "fast" | "verified";

export interface TaskPolicy {
  limits: TaskLoopLimits;
  /** state-machine-and-protocol.md 13.2절 — 워크스페이스별 tier 강제 */
  forceComplexityTier: ComplexityTier | null;
  /** run_command allowlist/denylist. 비어 있으면 Rust의 기본 정책이 쓰인다. */
  commandPolicy?: CommandPolicy;
  /** 파일 생성·수정을 승인 없이 허용할지. 삭제는 이 값과 무관하게 항상 승인이다. */
  autoApproveWorkspaceWrites: boolean;
  /** git commit 자동 생성 허용 여부. 기본 false — 사용자가 명시적으로 승인해야 한다. */
  allowGitCommit: boolean;
  /** 단일 명령 실행 상한 (ms) */
  commandTimeoutMs: number;
  executionMode: ExecutionMode;
}

export const DEFAULT_TASK_POLICY: TaskPolicy = {
  limits: DEFAULT_LOOP_LIMITS,
  forceComplexityTier: null,
  autoApproveWorkspaceWrites: false,
  allowGitCommit: false,
  commandTimeoutMs: 120_000,
  executionMode: "verified",
};

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
  /**
   * 취소 요청을 받고 정리 중. M0.1에서 추가됐다.
   *
   * 왜 별도 phase가 필요한가: 취소는 즉시 일어나지 않는다 — 실행 중인 자식 프로세스를 죽이고
   * 진행 중인 모델 호출을 끊는 데 시간이 걸린다. 그 사이 UI가 "실행 중"으로 보이면 사용자는
   * 취소 버튼이 동작하지 않았다고 생각하고 다시 누른다.
   */
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "REJECTED"
  /**
   * 앱이 비정상 종료되어 중단됨. **Node 상태 머신은 이 상태로 전이하지 않는다** —
   * 호스트(Rust)가 앱 시작 시 터미널이 아닌 태스크를 발견해 확정한다.
   * 완료도 실패도 취소도 아니고, 사용자가 되돌릴지 재실행할지 결정해야 하는 상태다.
   */
  | "INTERRUPTED";

export const TERMINAL_PHASES: readonly TaskPhase[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "INTERRUPTED",
];

export function isTerminalPhase(phase: TaskPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export interface TaskCounters {
  clarificationRounds: number;
  reviseRounds: number;
  fixLoopRounds: number;
  toolRetries: Record<string, number>;
  providerRetries: Record<string, number>;
}

export interface TaskState {
  taskId: string;
  phase: TaskPhase;
  complexityTier: ComplexityTier | null;
  /** docs/design/multi-engine-routing.md 7절 — 라우팅 결과를 태스크 상태에 보존 */
  routing: RoutingDecision | null;
  counters: TaskCounters;
}

export type FailureReason =
  | "clarification_exhausted"
  | "revise_exhausted"
  | "fix_loop_exhausted"
  | "tool_retry_exhausted"
  | "provider_retry_exhausted"
  | "provider_config_error"
  | "app_restart_interrupted"
  /** Policy Gate가 계획의 필수 도구를 거부해 계획 자체를 실행할 수 없는 경우 */
  | "policy_denied"
  /** 내부 불변식 위반 (잘못된 상태 전이 등) — 조용히 넘기지 않고 실패로 드러낸다 */
  | "internal_invariant_violated";

export interface FinalResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "rejected";
  failureReason?: FailureReason;
  summary: string;
  finalDiff?: string;
  verificationReport?: VerificationReport;
  auditTrailEventIds: string[];
  /** 이 태스크가 변경한 파일 목록 (롤백 UX가 쓴다 — state-machine-and-protocol.md 10절) */
  mutatedPaths?: string[];
  /**
   * 이 태스크에서 확정된 기준. 최종 보고가 이걸 체크리스트로 제시한다(17.3절).
   *
   * **충족 여부를 담는 필드가 없는 것은 누락이 아니라 설계다.** 기준↔테스트 자동 연결 방법이
   * 아직 없으므로 현재 확인된 기준은 0개이고, 그 사실은 "확인됨 필드가 비어 있음"이 아니라
   * "확인 여부를 말하는 필드 자체가 없음"으로 표현된다. 모델에게 판정을 맡기면
   * product-strategy.md 9절의 순환 의존이 그대로 재현된다.
   */
  acceptanceCriteria?: AcceptanceCriterion[];
  /**
   * 사용자에게 묻지 못한 채 남은 blocking 불일치 — 있으면 보고에 반드시 표시한다.
   * "물어볼 수 없었다"와 "쟁점이 없었다"는 다른 사실이다(17.4절).
   */
  unresolvedDisagreements?: string[];
  completedAt: ISODateTime;
}
