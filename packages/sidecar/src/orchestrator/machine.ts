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
  // **질문은 TRIAGE로 가지 않는다**(51절). TRIAGE가 정하는 것은 "교차검증을 할 것인가"이고,
  // 질문에는 검증할 산출물이 없으므로 그 판정에 답이 없다.
  SNAPSHOTTING: ["TRIAGE", "ANSWERING", "OUTLINING", "CANCELLING", "CANCELLED", "FAILED"],
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
  /**
   * **자기 자신으로의 전이가 있다** — MCP 도구 라운드(31절).
   *
   * 초안이 도구를 요청하면 그 초안을 버리고 도구를 실행한 뒤 다시 그린다. 그 사이에 다른
   * 단계로 간 적이 없으므로 정직한 표현은 `DRAFTING → DRAFTING`이다. 승인은 phase가 아니라
   * 승인 이벤트로 표현되므로(모달은 phase를 보지 않는다) `AWAITING_APPROVAL`을 빌리지 않는다 —
   * 빌리면 "실행 승인을 기다리는 중"과 "초안이 도구를 요청했다"가 화면에서 같아진다.
   *
   * **자기 전이는 이 표의 종료 논증을 약화시킨다.** 그래서 그 상한은 표가 아니라 counter가
   * 진다: `mcpRounds`(기본 1)와 "상한을 알린 뒤에는 요청을 무시한다"는 규칙 둘이 함께
   * 유한성을 보장한다(원칙 5). 새로 자기 전이를 추가하려면 같은 논증을 함께 만들 것.
   */
  /**
   * `DRAFTING → PLANNING`은 **검수자를 배정하지 못한 경우**다.
   *
   * 원칙 4는 검수자를 구할 수 없으면 "같은 공급자로 검증한 척하지 말고 **검수 역할을 드롭한
   * 뒤 그 사실을 표시**하라"고 말한다. 역할이 빠진 것이지 태스크의 성격이 바뀐 것이 아니므로,
   * 초안까지는 그대로 만들고 REVIEWING만 건너뛴다. 예전에는 이 경우 파이프라인 전체가
   * `SINGLE_MODEL_FIX`로 갈아타서 **초안 프롬프트도 `DraftProposal`도 없어졌다** — 사용자가
   * 키를 하나만 넣었다는 이유로 받는 결과의 종류가 통째로 달라지는 동작이었다.
   *
   * 비어 있는 REVIEWING을 지나가게 하지 않는다. 화면에 "검수 중"이 떴다가 아무 일도 없이
   * 지나가면 검수를 거친 실행과 구별되지 않고, 그게 이 원칙이 막으려는 바로 그 착시다.
   * 건너뛴 사실은 `PHASE_CHANGED_NOTE`로 남는다.
   *
   * 종료 논증은 그대로다 — 새 자기 전이가 아니라 앞으로만 가는 간선이다.
   */
  DRAFTING: ["DRAFTING", "REVIEWING", "PLANNING", "AWAITING_USER_INPUT", "CANCELLING", "CANCELLED", "FAILED"],
  // SINGLE_MODEL_FIX의 verdict: ACCEPT → PLANNING, NEED_USER_INPUT → AWAITING_USER_INPUT,
  // REJECT → REJECTED (문서 14.1절). 자기 전이의 이유는 DRAFTING과 같다(31절).
  SINGLE_MODEL_FIX: [
    "SINGLE_MODEL_FIX",
    "PLANNING",
    "AWAITING_USER_INPUT",
    "REJECTED",
    "CANCELLING",
    "CANCELLED",
    "FAILED",
  ],
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
  // PLANNING → DRAFTING / SINGLE_MODEL_FIX는 **기준 게이트**의 되돌림이다
  // (state-machine-and-protocol.md 17.3절 규칙 1).
  //
  // 왜 FIX_LOOP를 쓰지 않는가: FIX_LOOP의 전제는 "적용된 변경을 검증 결과를 근거로 고친다"인데,
  // 이 시점에는 **아직 아무것도 적용되지 않았다.** 실행 후 예산(fixLoopRounds)을 실행 전
  // 문제에 쓰면 정작 검증이 실패했을 때 쓸 예산이 줄어든다. 그래서 실행 전 합의 실패의 예산인
  // `reviseRounds`를 쓰고 초안 단계로 되돌아간다 — 상한은 그대로이므로 새 무한 루프는 없다.
  //
  // 되돌아가는 대상이 둘인 이유는 경로가 둘이기 때문이다(교차검증 / 단일 모델).
  PLANNING: [
    "AWAITING_APPROVAL",
    "EXECUTING",
    "FIX_LOOP",
    "DRAFTING",
    "SINGLE_MODEL_FIX",
    "CANCELLING",
    "CANCELLED",
    "FAILED",
  ],
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
  /**
   * 질문에 답하는 중 (51절).
   *
   * **`COMPLETED`가 여기 없다.** 답변은 완료가 아니고, 그 구별이 `canReachCompletedWithoutVerifying`
   * 불변식을 지킨다 — 답변 경로가 `COMPLETED`에 닿을 수 있으면 검증 없이 완료에 도달하는 길이
   * 생긴다. `EXECUTING`도 없다: 질문은 파일을 바꾸지 않는다.
   */
  ANSWERING: ["ANSWERED", "CANCELLING", "CANCELLED", "FAILED"],
  /**
   * 계획 경로 — `ANSWERING`과 같은 모양이다(53절). `EXECUTING`도 `PLANNING`도 없다:
   * 계획 모드는 patch를 만들지 않으므로 쪼갤 것도 적용할 것도 없다.
   */
  OUTLINING: ["OUTLINED", "CANCELLING", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  REJECTED: [],
  // Node는 이 상태로 전이하지 않는다 — 호스트가 앱 시작 시 확정한다(store.rs).
  INTERRUPTED: [],
  ANSWERED: [],
  OUTLINED: [],
};

/**
 * 파일을 건드릴 수 있는 phase들. `canReachThroughMutation`이 이 목록을 쓴다.
 *
 * **`VERIFYING`이 들어 있는 이유**: 검증은 워크스페이스에서 명령을 돌리고, 그 명령이 파일을
 * 남길 수 있다. "읽기만 하는 경로"라는 주장은 그것까지 포함해야 참이다.
 */
export const MUTATING_PHASES: readonly TaskPhase[] = [
  "EXECUTING",
  "PLANNING",
  "AWAITING_APPROVAL",
  "FIX_LOOP",
  "VERIFYING",
];

/**
 * 아무것도 바꾸지 않고 끝나는 종착지들 (51·53절).
 *
 * **손으로 적은 목록이고, 그래서 낡을 수 있다.** 새 종착지를 더하면서 여기 빠뜨리면 그
 * 경로에 대해 아래 불변식이 **아무 말도 하지 않는다** — 그리고 검사는 통과한다. 그래서
 * `machine.test.ts`가 `TERMINAL_PHASES` 전체를 이 목록과 `CHANGE_TERMINALS`로 나눠 덮는지
 * 확인한다: 새 종착지를 만들면 **분류하기 전까지 실패한다.**
 */
export const READ_ONLY_TERMINALS: readonly TaskPhase[] = ["ANSWERED", "OUTLINED"];

/** 변경 경로의 종착지들. 위 목록과 합쳐 `TERMINAL_PHASES` 전체가 되어야 한다. */
export const CHANGE_TERMINALS: readonly TaskPhase[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "INTERRUPTED",
];

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
/**
 * **읽기 전용 경로는 파일을 바꾸지 않는다**는 불변식의 명시적 표현 (51·53절).
 *
 * `canReachCompletedWithoutVerifying`의 거울이다. 저쪽은 "검증 없이 완료할 수 없다"를 지키고
 * 이쪽은 "답변/계획한다면서 실행하지 않는다"를 지킨다 — 둘 다 전이 표에서 유도하므로, 나중에
 * 표를 고치다 우회로가 생기면 테스트가 실패한다.
 *
 * 도구 허용목록(26절)이 Rust 쪽에서 같은 것을 한 겹 더 막는다. 여기는 **경로**의 보장이고
 * 그쪽은 **권한**의 보장이다 — 뭉치면 한쪽이 뚫렸을 때 다른 쪽도 없는 것으로 여기게 된다.
 */
export function canReachThroughMutation(target: TaskPhase): boolean {
  const visited = new Set<string>();
  const stack: { phase: TaskPhase; touched: boolean }[] = [{ phase: "CREATED", touched: false }];
  while (stack.length > 0) {
    const { phase, touched } = stack.pop()!;
    const key = `${phase}:${touched}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (phase === target && touched) return true;
    const nextTouched = touched || MUTATING_PHASES.includes(phase);
    for (const next of TRANSITIONS[phase]) stack.push({ phase: next, touched: nextTouched });
  }
  return false;
}

/**
 * 종전 이름 — `ANSWERED` 하나만 보던 시절의 것이다(51절).
 *
 * **일반화한 이유**: 53절이 두 번째 읽기 전용 종착지를 만들면서, 같은 불변식을 손으로 한 번
 * 더 적을 뻔했다. 두 벌이 되면 나중에 한쪽만 고쳐진다.
 */
export function canReachAnsweredThroughMutation(): boolean {
  return canReachThroughMutation("ANSWERED");
}

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
