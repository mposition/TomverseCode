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
  /**
   * 태스크 시작 시점의 워크스페이스 지문 — product-strategy 6절 "Agent Trace 완성".
   *
   * **Rust가 계산하고 Rust가 append한다.** Node는 "지금 찍어라"만 말할 수 있다 —
   * 감사 기록이 Node의 정직함에 의존하면 그건 감사가 아니다(원칙 2).
   *
   * `git_head`만으로는 부족하다: 같은 HEAD에서도 워킹 트리가 다르면 다른 실행이다.
   * 지문이 놓치는 것(추적되지 않는 파일의 **내용**)은 payload의 `untrackedFiles`가
   * "이번 실행에 그 한계가 적용되는가"로 답한다.
   */
  | "WORKSPACE_FINGERPRINT"
  /**
   * 인덱스 캐시 계측 (context-engine.md 2절, process-architecture.md 11.4절).
   *
   * **캐시가 이득인지는 아직 측정된 적이 없다.** 11.4절은 "전환을 싸게 만든다"고 적었을 뿐이고,
   * 인덱스 구축이 실제로 얼마나 걸리는지 잰 기록이 없다. 두 이벤트가 그 답의 재료다 —
   * 적중률(HIT 대 BUILT의 비)과 회피된 시간(`savedBuildMs`).
   */
  | "WORKSPACE_INDEX_BUILT"
  | "WORKSPACE_INDEX_CACHE_HIT"
  /**
   * 도구가 파일을 바꾼 뒤 스냅샷을 다시 읽지 못했다 (context-engine.md 6.1절).
   *
   * **`ERROR`로 묻으면 안 되는 사실이다.** 이 이벤트가 있다는 것은 그 뒤의 모델 호출이
   * **낡은 파일 내용**을 받았다는 뜻이고, 그 호출이 낸 패치가 왜 어긋났는지는 나중에
   * 이것 없이는 설명되지 않는다. 성공은 새 `SNAPSHOT_CREATED`가 말하므로 따로 남기지 않는다.
   */
  | "SNAPSHOT_REFRESH_FAILED"
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
