import type { ISODateTime } from "./common.js";
import type { TaskPhase } from "./task.js";

/**
 * docs/design/state-machine-and-protocol.md 7절 — task_events.event_type.
 * CLAUDE.md 원칙 7: 이건 append-only 진실의 원천이고 tasks.phase는 파생 캐시다.
 */
export type TaskEventType =
  | "TASK_CREATED"
  | "PHASE_CHANGED"
  | "SNAPSHOT_CREATED"
  | "ROUTING_DECIDED"
  | "DRAFT_RECEIVED"
  | "REVIEW_RECEIVED"
  | "PLAN_CREATED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_DENIED"
  | "TOOL_REQUESTED"
  | "TOOL_COMPLETED"
  | "POLICY_DECIDED"
  | "FILE_MUTATED"
  | "VERIFICATION_COMPLETED"
  | "FIX_LOOP_STARTED"
  | "PROVIDER_USAGE"
  | "PROVIDER_RETRY"
  | "TOOL_RETRY"
  | "USER_MESSAGE_RECEIVED"
  | "ERROR"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_CANCELLED"
  | "TASK_REJECTED"
  | "ROLLBACK_STARTED"
  | "ROLLBACK_COMPLETED";

export interface TaskEvent<TPayload = unknown> {
  /** SQLite AUTOINCREMENT — 삽입 전에는 없다. */
  eventId?: number;
  taskId: string;
  /** task 내 순번. (taskId, seq)가 unique다. */
  seq: number;
  type: TaskEventType;
  payload: TPayload;
  createdAt: ISODateTime;
}

/** PHASE_CHANGED payload — 파생 캐시(tasks.phase) 갱신의 근거가 되는 이벤트. */
export interface PhaseChangedPayload {
  from: TaskPhase | null;
  to: TaskPhase;
  reason?: string;
}

/**
 * 8KB를 넘는 페이로드는 인라인하지 않고 artifact로 밀어낸 뒤 이 형태로 참조만 남긴다
 * (state-machine-and-protocol.md 7절 — SQLite WAL 비대화 방지).
 */
export interface ArtifactRef {
  artifactRef: string;
  sha256: string;
  sizeBytes: number;
  /** 원본을 열지 않고도 무엇인지 알 수 있도록 앞부분만 남긴다. */
  preview?: string;
}
