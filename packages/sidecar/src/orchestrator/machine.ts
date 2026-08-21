import type { TaskPhase } from "@tomverse/protocol";
import { isTerminalPhase } from "@tomverse/protocol";

/**
 * 상태 머신 전이 표 — docs/design/state-machine-and-protocol.md 2절 다이어그램의 실체.
 *
 * 왜 명시적인 표로 두는가: 전이가 코드 흐름에 흩어져 있으면 "이 전이가 허용되는가"를
 * 검증할 수 없고, 잘못된 전이가 조용히 일어난다. 표로 두면 (a) 문서와 1:1 대조가 가능하고
 * (b) 전이마다 유효성을 확인할 수 있고 (c) 잘못된 전이를 실패로 드러낼 수 있다.
 */
/**
 * M0.1: 취소는 `CANCELLING`을 거쳐 `CANCELLED`에 도달한다.
 *
 * 왜 직행하지 않는가: 취소 요청 시점과 실제 중단 완료 시점 사이에 (a) 실행 중인 자식 프로세스
 * 종료 (b) 진행 중인 모델 호출 abort가 일어난다. 그 구간을 상태로 표현하지 않으면 UI가
 * "취소 중"을 보여줄 수 없고, 이벤트 로그에도 "언제 요청했고 언제 끝났는지"가 남지 않는다.
 */
export const TRANSITIONS: Record<TaskPhase, readonly TaskPhase[]> = {
  CREATED: ["SNAPSHOTTING", "CANCELLING", "CANCELLED", "FAILED"],
  SNAPSHOTTING: ["TRIAGE", "CANCELLING", "CANCELLED", "FAILED"],
  // TRIAGE는 complexityTier에 따라 갈린다.
  TRIAGE: ["DRAFTING", "SINGLE_MODEL_FIX", "CANCELLING", "CANCELLED", "FAILED"],
  /**
   * `AWAITING_USER_INPUT`이 추가된 이유 — state-machine-and-protocol.md 17.1절.
   *
   * 구조적 대조에서 blocking 불일치가 나오면 **검수 전에** 사용자에게 묻는다. 검수까지 간 뒤에
   * 묻지 않는 이유: 검수자의 역할이 "사용자가 고정한 기준이 반영됐는지 확인"으로 바뀌었으므로,
   * 기준이 아직 없는 상태에서 검수를 돌리면 확인할 대상이 없다.
   *
   * **새 상태를 만들지 않았다.** 대조는 LLM 호출이 아니라 필드 비교 연산이라 사용자에게 노출할
   * 단계가 아니고, 상태를 늘리면 2절 다이어그램과 UI 매핑만 복잡해진다.
   */
  DRAFTING: ["REVIEWING", "AWAITING_USER_INPUT", "CANCELLING", "CANCELLED", "FAILED"],
  // SINGLE_MODEL_FIX의 verdict: ACCEPT → PLANNING, NEED_USER_INPUT → AWAITING_USER_INPUT,
  // REJECT → REJECTED (문서 14.1절)
  SINGLE_MODEL_FIX: ["PLANNING", "AWAITING_USER_INPUT", "REJECTED", "CANCELLING", "CANCELLED", "FAILED"],
  // REVIEWING의 4갈래: ACCEPT/REVISE → PLANNING, REJECT → REJECTED, NEED_USER_INPUT → AWAITING_USER_INPUT
  REVIEWING: ["PLANNING", "REJECTED", "AWAITING_USER_INPUT", "CANCELLING", "CANCELLED", "FAILED"],
  // 14.1절 tier 승격 규칙: 사용자 응답 후에는 **항상** DRAFTING(standard 경로)으로 간다.
  // TRIAGE로 되돌아가는 전이가 없는 것이 그 규칙의 구조적 강제다.
  AWAITING_USER_INPUT: ["DRAFTING", "CANCELLING", "CANCELLED", "FAILED"],
  // PLANNING → FIX_LOOP는 설계 문서 2절 다이어그램에 **없던** 전이다.
  //
  // 필요해진 이유: 문서는 "patch가 적용 계획으로 변환되지 않는 경우"를 다루지 않는다. 그런데
  // 파일 헤더 없는 diff는 LLM의 흔한 실패 모드이고, 이걸 즉시 FAILED로 만들면 한 번의 재요청으로
  // 회복 가능한 오류에 태스크 전체를 버리게 된다.
  //
  // FIX_LOOP를 재사용하는 것이 타당한 이유: FIX_LOOP의 전제는 "결정론적 증거를 근거로 다시
  // 요청한다"이고, patch 파싱 실패는 모델 의견이 아니라 결정론적 사실이다. 프로토콜의
  // `VerificationKind`에 이미 `diff_review`가 있어 이 실패를 리포트로 표현할 수 있다.
  // 상한도 `fixLoopRounds`를 그대로 공유하므로 새 무한 루프가 생기지 않는다.
  PLANNING: ["AWAITING_APPROVAL", "EXECUTING", "FIX_LOOP", "CANCELLING", "CANCELLED", "FAILED"],
  AWAITING_APPROVAL: ["EXECUTING", "CANCELLING", "CANCELLED", "FAILED"],
  // EXECUTING → EXECUTING은 "다음 ToolRequest"를 뜻한다.
  EXECUTING: ["EXECUTING", "VERIFYING", "CANCELLING", "CANCELLED", "FAILED"],
  // VERIFYING → COMPLETED(pass) 또는 FIX_LOOP(fail). CLAUDE.md 원칙 1에 따라
  // VERIFYING을 건너뛰고 COMPLETED로 가는 전이는 어디에도 없다.
  VERIFYING: ["COMPLETED", "FIX_LOOP", "CANCELLING", "CANCELLED", "FAILED"],
  FIX_LOOP: ["PLANNING", "FAILED", "CANCELLING", "CANCELLED", "REJECTED"],
  // 정리만 하고 CANCELLED로 간다. 여기서 COMPLETED로 갈 수 없다 —
  // 취소를 요청한 뒤 성공으로 끝나면 사용자는 취소가 무시됐다고 느낀다.
  CANCELLING: ["CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  REJECTED: [],
  // Node는 이 상태로 전이하지 않는다 — 호스트가 앱 시작 시 확정한다(store.rs).
  INTERRUPTED: [],
};

export function isValidTransition(from: TaskPhase, to: TaskPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(readonly from: TaskPhase, readonly to: TaskPhase) {
    super(`잘못된 상태 전이: ${from} → ${to} (허용: ${TRANSITIONS[from].join(", ") || "없음 — 터미널 상태"})`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * COMPLETED에 도달하기 위해 반드시 VERIFYING을 지나야 한다는 불변식의 명시적 표현.
 * 테스트가 이걸 직접 검증한다 — 나중에 전이 표를 고칠 때 실수로 우회로가 생기면 실패한다.
 */
export function canReachCompletedWithoutVerifying(): boolean {
  const visited = new Set<TaskPhase>();
  const stack: TaskPhase[] = ["CREATED"];
  while (stack.length > 0) {
    const phase = stack.pop() as TaskPhase;
    if (visited.has(phase)) continue;
    visited.add(phase);
    for (const next of TRANSITIONS[phase]) {
      // VERIFYING을 지나는 경로는 탐색하지 않는다 — 그 경로를 뺀 그래프에서
      // COMPLETED에 도달할 수 있는가를 묻는 것이다.
      if (next === "VERIFYING") continue;
      if (next === "COMPLETED") return true;
      stack.push(next);
    }
  }
  return false;
}

/** 터미널 상태 판정은 프로토콜의 것을 그대로 쓴다 (중복 정의하지 않는다). */
export { isTerminalPhase };
