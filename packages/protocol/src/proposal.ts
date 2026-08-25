import type { ISODateTime, ReviewMode, Verdict } from "./common.js";

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
  questionsForUser?: string[]; // verdict = NEED_USER_INPUT
  rejectionReason?: string; // verdict = REJECT
  /** 대조 경로의 `DraftProposal.mcpCalls`와 같은 자리 (state-machine 31절). */
  mcpCalls?: McpCallRequest[];
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
  model: string;
  createdAt: ISODateTime;
}
