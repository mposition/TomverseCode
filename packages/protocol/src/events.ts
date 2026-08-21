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
  /**
   * 대조 완료 시 (17.3절). 불일치 0건이어도 기록한다 — 대조를 돌렸다는 사실 자체가 감사 대상이고,
   * "쟁점이 없었다"와 "대조하지 않았다"는 다른 사실이다.
   *
   * **아직 아무도 발행하지 않는다.** 대조 로직은 다음 작업이며, 이벤트 타입만 먼저 둔다 —
   * 이벤트 이름은 저장된 로그에 영구히 남는 값이라 나중에 바꾸는 비용이 크다.
   */
  | "DISAGREEMENT_DETECTED"
  /**
   * 사용자 답변 수신 시 (17.3절). `USER_MESSAGE_RECEIVED`가 길이만 남기던 자리를 대신한다 —
   * **판정자의 판정이 감사 로그에 없으면** Agent Trace가 "왜 이렇게 만들었나"에 답할 수 없다.
   */
  | "USER_DECISION_RECORDED"
  /**
   * PLANNING에서 계획이 확정된 기준과 충돌했을 때 (17.3절 규칙 1).
   *
   * 재요청하든 그대로 진행하든 **언제나 남긴다** — 예산이 모자라 그냥 진행한 경우가
   * 사후에 가장 알기 어려운 상태이기 때문이다.
   */
  | "CRITERIA_CONFLICT_DETECTED"
  /**
   * VERIFYING 직후의 기준별 판정 (17.3절 규칙 2).
   *
   * 판정은 매 검증마다 다시 계산되는 파생값이라 여러 번 나올 수 있다. 마지막 것이 최종 보고에
   * 쓰이며, 이전 것들은 "fix loop 도중에 무엇이 확인/반증됐는가"의 기록으로 남는다.
   */
  | "CRITERIA_EVALUATED"
  /**
   * 기준 충돌이 어떻게 끝났는지 (17.10절).
   *
   * `CRITERIA_CONFLICT_DETECTED`만 있으면 "충돌이 몇 번 났는가"밖에 셀 수 없다. 우리가 답해야
   * 하는 질문은 "그 충돌이 쓸모 있었는가"이므로 **결말을 따로 남긴다** — 감지와 결말을 한
   * 이벤트에 담을 수 없는 이유는 결말이 다음 라운드에야 정해지기 때문이다.
   */
  | "CRITERIA_CONFLICT_RESOLVED"
  /**
   * 검증 통과 후 커밋이 실제로 만들어졌을 때.
   *
   * **커밋 시도 사실이 아니라 성공 사실만 남긴다** — 시도와 거부는 `TOOL_REQUESTED`/
   * `POLICY_DECIDED`/`TOOL_COMPLETED`에 이미 다 있고, 이 이벤트는 "이 태스크가 저장소 이력을
   * 바꿨다"는 **되돌리기 어려운 사실**의 표식이다. 되돌리기는 파일만 복원하고 커밋은 남으므로,
   * 그 사실을 나중에 찾을 수 있어야 한다.
   */
  | "GIT_COMMIT_CREATED"
  | "ERROR"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_CANCELLED"
  | "TASK_REJECTED"
  | "ROLLBACK_STARTED"
  | "ROLLBACK_COMPLETED"
  /**
   * 되돌리기를 시작했는데 되돌리지 못했다 — 지금은 충돌한 `git revert`가 유일한 출처다(19.3절).
   *
   * `ROLLBACK_COMPLETED`의 반대이지 "아무 일도 없었다"가 아니다. payload의 `cleanedUp`이
   * **저장소가 지금 어떤 상태인가**를 말한다: `true`면 우리가 원래대로 돌려놓았고, `false`면
   * revert 진행 중으로 남아 있다. 후자는 사용자가 손대야 하는 상태이므로 이벤트로 남겨야
   * 나중에 "왜 이 저장소가 이 꼴인가"를 되짚을 수 있다.
   */
  | "ROLLBACK_FAILED";

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
