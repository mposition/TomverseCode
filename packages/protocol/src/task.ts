import type { ComplexityTier, ISODateTime } from "./common.js";
import type { VerificationReport } from "./verification.js";

export interface TaskRequest {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  userMessage: string;
  attachments?: { path: string; note?: string }[];
  createdAt: ISODateTime;
}

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

export interface TaskState {
  taskId: string;
  phase: TaskPhase;
  complexityTier: ComplexityTier | null;
  counters: {
    clarificationRounds: number;
    reviseRounds: number;
    fixLoopRounds: number;
    toolRetries: Record<string, number>;
    providerRetries: Record<string, number>;
  };
}

export type FailureReason =
  | "clarification_exhausted"
  | "revise_exhausted"
  | "fix_loop_exhausted"
  | "tool_retry_exhausted"
  | "provider_retry_exhausted"
  | "provider_config_error"
  | "app_restart_interrupted";

export interface FinalResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "rejected";
  failureReason?: FailureReason;
  summary: string;
  finalDiff?: string;
  verificationReport?: VerificationReport;
  auditTrailEventIds: string[];
  completedAt: ISODateTime;
}
