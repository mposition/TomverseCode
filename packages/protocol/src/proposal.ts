import type { ISODateTime, ReviewMode, Verdict } from "./common.js";

export interface PlanStep {
  stepId: string;
  description: string;
  toolHint?: "apply_patch" | "create_file" | "delete_file" | "run_command" | "run_tests";
  targetPaths?: string[];
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
  model: string;
  createdAt: ISODateTime;
}
