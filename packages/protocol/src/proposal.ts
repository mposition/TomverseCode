import type { ISODateTime, ReviewMode, Verdict } from "./common.js";

/**
 * 모델이 서술하는 계획의 한 단계 — **사용자에게 보여주기 위한 것이다.**
 *
 * `toolHint`와 `targetPaths`는 **실행 근거가 아니다**(45.2절). 한때 `buildExecutionPlan`이
 * `toolHint === "delete_file"`인 단계를 실제 삭제 요청으로 바꿨는데, 그 분기는 호출부가
 * `plan: []`을 넘기고 있어 한 번도 돌지 않았다. 그 자리를 되살리는 대신 없앴다 — 서술을
 * 실행 근거로 쓰면 **모델이 말을 바꾸는 것이 곧 실행을 바꾸는 것**이 되고, 검수자의
 * `revisedPlan`은 서술을 고치라고 만든 자리인데 그것이 조용히 실행을 고치게 된다.
 *
 * 실행되는 것은 `patch`·`moves`·`deletions` 세 자리뿐이다.
 */
export interface PlanStep {
  stepId: string;
  description: string;
  toolHint?: "apply_patch" | "create_file" | "delete_file" | "run_command" | "run_tests";
  targetPaths?: string[];
}

/**
 * 초안이 요청하는 **파일 이동** 하나 (state-machine 44절).
 *
 * # 왜 `targetPaths`에 두 개를 넣지 않는가
 *
 * `["from", "to"]`로 두면 **순서가 곧 의미**가 되고, 뒤바뀐 요청은 조용히 반대로 실행된다.
 * 그 실수는 승인 화면에서도 정상으로 보인다("옮깁니다"는 어느 쪽이든 같은 문장이다).
 * 이름을 붙이면 뒤바뀔 수 없다.
 */
export interface FileMove {
  from: string;
  to: string;
}

/**
 * 초안이 요청하는 MCP 도구 호출 하나 (state-machine 31절).
 *
 * **이것은 요청이지 실행이 아니다.** 실행 여부는 Policy Gate가 정하고 매번 사용자 승인을
 * 지난다(23.3절). 모델이 이 배열을 채운다고 무엇이 실행되지는 않는다.
 */
export interface McpCallRequest {
  server: string;
  tool: string;
  /** MCP는 named arguments를 쓴다 — 배열이면 우리가 잘못 조립한 것이다(23.4절). */
  arguments: Record<string, unknown>;
  /** 왜 이 호출이 필요한가. 승인 화면이 사용자에게 보여줄 근거다. */
  reason?: string;
}

// OpenAI 산출물 (DRAFTING) — docs/design/state-machine-and-protocol.md 3절
export interface DraftProposal {
  taskId: string;
  proposalId: string;
  interpretation: string;
  relevantFiles: { path: string; reason: string }[];
  plan: PlanStep[];
  patch?: string;
  /**
   * 이 초안이 옮기려는 파일들 (state-machine 44절).
   *
   * **patch와 따로 둔다.** unified diff는 이동을 표현하지 못하고(내용이 같은 파일의 전체
   * 삭제 + 전체 추가로 나온다), 그렇게 표현하면 큰 파일의 이름을 바꾸는 데 그 파일을 두 번
   * 실어 보내게 된다.
   */
  moves?: FileMove[];
  /**
   * 이 초안이 지우려는 파일들 (state-machine 45절).
   *
   * **patch로 표현하지 않는다.** unified diff로 파일을 지우려면 전체를 `-`로 실어 보내야
   * 하고(`+++ /dev/null`), 그건 지우려는 파일을 한 번 더 읽어 보내는 일이다. 그리고 그렇게
   * 온 patch는 "파일을 비우는 것"과 "파일을 지우는 것"이 구별되지 않는다 — 둘은 되돌리기
   * 비용도, 승인 등급도 다르다.
   *
   * `plan[].toolHint`로 받지 않는 이유는 45.2절에 있다: `plan`은 사용자에게 보여줄 서술이고,
   * 서술을 실행 근거로 쓰면 **말을 바꾸는 것이 곧 실행을 바꾸는 것**이 된다.
   */
  deletions?: string[];
  risks: string[];
  requiredTests: string[];
  uncertainties: string[];
  doneCriteria: string[];
  /**
   * 이 초안을 내기 전에 필요한 MCP 도구 호출 (state-machine 31절).
   *
   * 비어 있는 것이 정상이다. 채워져 있으면 **이 초안의 patch는 쓰이지 않는다** — 도구를
   * 부른 뒤 DRAFTING을 다시 돈다(재질문 왕복과 같은 모양). 상한은 `limits.mcpRounds`.
   */
  mcpCalls?: McpCallRequest[];
  model: string;
  createdAt: ISODateTime;
}

// Claude 산출물 (REVIEWING) — DraftProposal을 검토한 결과
export interface ReviewDecision {
  taskId: string;
  proposalId: string;
  // 어떤 정보를 보고 내린 판정인지. Agent Trace(product-strategy.md 6절)의
  // "제공된 컨텍스트" 기록이자, blind/informed 판정 불일치율 지표(14절)의 근거.
  reviewMode: ReviewMode;
  verdict: Verdict;
  rationale: string;
  revisedPlan?: PlanStep[];
  revisedPatch?: string;
  /**
   * 검수자가 고친 **초안의 이동** (state-machine 46절).
   *
   * **생략과 빈 배열이 다르다.** `undefined`는 "말하지 않았다"이고 초안의 이동이 그대로
   * 실린다. `[]`는 "전부 하지 마라"다. 하나로 뭉개면 아무 말도 하지 않은 검수자가 초안의
   * 이동을 취소한 것이 되고, 그 반대도 마찬가지다.
   *
   * `moves`라는 이름을 쓰지 않는 이유: 그건 "검수자가 새 이동을 제안한다"로 읽히는데,
   * 검수자가 하는 일은 **초안의 조작을 고치는 것**이다.
   */
  revisedMoves?: FileMove[];
  /** 검수자가 고친 **초안의 삭제** (state-machine 46절). 생략과 빈 배열의 뜻은 위와 같다. */
  revisedDeletions?: string[];
  questionsForUser?: string[]; // verdict = NEED_USER_INPUT
  rejectionReason?: string; // verdict = REJECT
  //
  // **`mcpCalls`가 여기 있었다.** 검증기가 채우지 않고 소비하는 쪽도 없어 **언제나
  // undefined**였다 — 즉 "검수자도 도구를 요청할 수 있다"는 타입의 주장이 거짓이었다(46.5절).
  // 45.5절에서 `SingleModelFixResult.moves`가 같은 상태였고 거기서는 배선을 이었지만,
  // 여기는 이을 소비처 자체가 없으므로 **필드를 없애는 것이 정직한 쪽**이다.
  //
  model: string;
  createdAt: ISODateTime;
}

// Claude 산출물 (SINGLE_MODEL_FIX, TRIAGE에서 complexityTier = simple로 진입) —
// ReviewDecision과 구조는 비슷하지만 검토 대상 DraftProposal이 없으므로 REVISE는 쓰지 않는다.
export interface SingleModelFixResult {
  taskId: string;
  verdict: Exclude<Verdict, "REVISE">;
  rationale: string;
  plan?: PlanStep[]; // verdict = ACCEPT
  patch?: string; // verdict = ACCEPT
  questionsForUser?: string[]; // verdict = NEED_USER_INPUT
  rejectionReason?: string; // verdict = REJECT
  /** 대조 경로의 `DraftProposal.mcpCalls`와 같은 자리 (state-machine 31절). */
  mcpCalls?: McpCallRequest[];
  /** 대조 경로의 `DraftProposal.moves`와 같은 자리 (state-machine 44절). */
  moves?: FileMove[];
  /** 대조 경로의 `DraftProposal.deletions`와 같은 자리 (state-machine 45절). */
  deletions?: string[];
  model: string;
  createdAt: ISODateTime;
}

/**
 * 계획 — state-machine 53절.
 *
 * **`ExecutionPlan`이 아니다.** 그쪽은 patch를 도구 호출로 쪼갠 결과이고, 이건 patch를 만들기
 * **전에** 나오는 서술이다. 둘을 한 타입으로 합치면 "실행할 수 있는 것"과 "아직 아무것도
 * 만들지 않은 것"이 같은 모양이 되고, 그러면 실행 경로가 이것을 받아 도는 길이 열린다.
 *
 * **그리고 `patch` 자리가 없다.** 없앤 것이 아니라 처음부터 두지 않았다 — 있으면 모델이 채우고,
 * 채워진 것은 언젠가 누군가 쓴다. 계획 모드가 아끼려는 것이 바로 그 토큰이다.
 */
export interface PlanOutline {
  taskId: string;
  /** 한 줄 요약 — 목록 화면이 쓴다. */
  summary: string;
  /**
   * 무엇을 어떤 순서로 할 것인가.
   *
   * `PlanStep`을 쓰지 않는다. 그쪽은 초안에 딸린 서술이고 `toolHint`를 갖는데(45절에서
   * 실행 근거가 아니라고 못박았다), 여기서는 그 필드가 있다는 사실만으로 "이대로 실행하면
   * 된다"고 읽힌다.
   */
  steps: PlanOutlineStep[];
  /**
   * 이 계획이 건드릴 것으로 **보이는** 파일들.
   *
   * 확정이 아니다 — 모델은 예산이 고른 부분집합만 봤고(context-engine 8·15절), 창 밖에
   * 관련 지점이 남아 있을 수 있다. 화면이 이것을 "바뀔 파일"로 그리면 안 되는 이유다.
   */
  filesToChange: string[];
  /**
   * 이 계획이 틀릴 수 있는 자리.
   *
   * **산문이 아니라 값으로 받는다** — `QuestionAnswer.missingContext`와 같은 이유다.
   * 이 경로에도 결정론적 판정자가 없으므로(만든 것이 없다) 이 목록이 사용자가 가진 방어다.
   */
  risks: string[];
  /**
   * 계획을 확정하려면 사용자에게 물어야 하는 것.
   *
   * `AWAITING_USER_INPUT`으로 가지 않고 **값으로 실어 끝낸다**(53.3절). 계획 모드에서
   * 되묻기 루프를 도는 것은 이 모드가 아끼려는 토큰을 도로 쓰는 일이다.
   */
  openQuestions: string[];
  /**
   * 계획을 세우려면 **더 봐야 하는 파일들** (state-machine 57절).
   *
   * `risks`·`openQuestions`와 자리가 다르다. 그 둘은 **사용자에게** 하는 말이고 이건
   * **우리에게** 하는 말이다 — 뭉치면 화면이 "위험"이라며 파일 경로를 늘어놓고, 우리는
   * 사용자에게 할 말에서 요청을 골라내야 한다.
   */
  needsContext?: string[];
  model: string;
  createdAt: ISODateTime;
}

export interface PlanOutlineStep {
  /** 무엇을 하는가. */
  intent: string;
  /** 그 단계가 건드릴 것으로 보이는 파일들. 비어 있을 수 있다(조사 단계 등). */
  files: string[];
}

/**
 * 질문에 대한 답 — state-machine 51절.
 *
 * **`DraftProposal`과 나란히 두지만 다른 타입이다.** 초안은 "이렇게 바꾸자"는 제안이고 이건
 * "이렇다"는 서술이다. 한 타입으로 합치면 patch가 비어 있는 초안과 답변이 같은 모양이 되고,
 * 그러면 화면과 감사 기록이 둘을 구별하지 못한다.
 */
export interface QuestionAnswer {
  taskId: string;
  answer: string;
  /** 답이 기댄 파일들. 비어 있으면 파일에 기대지 않았다는 뜻이다. */
  citedFiles: string[];
  /**
   * 더 확신하려면 무엇을 봐야 하는가.
   *
   * **산문이 아니라 값으로 받는다.** 답변 안에 섞여 있으면 화면이 읽을 수 없고, 사용자는
   * 확신에 찬 문단과 조심스러운 문단을 같은 무게로 읽는다. 이 경로에는 결정론적 판정자가
   * 없으므로(검증할 결과가 없다) 그 구별이 사용자가 가진 유일한 방어다.
   */
  missingContext: string[];
  model: string;
  createdAt: ISODateTime;
}
