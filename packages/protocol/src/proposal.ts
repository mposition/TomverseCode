import type { ISODateTime, Verdict } from "./common.js";

export interface PlanStep {
  stepId: string;
  description: string;
  toolHint?: "apply_patch" | "create_file" | "delete_file" | "run_command" | "run_tests";
  targetPaths?: string[];
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
  model: string;
  createdAt: ISODateTime;
}

// Claude 산출물 (REVIEWING) — DraftProposal을 검토한 결과
export interface ReviewDecision {
  taskId: string;
  proposalId: string;
  verdict: Verdict;
  rationale: string;
  revisedPlan?: PlanStep[];
  revisedPatch?: string;
  questionsForUser?: string[]; // verdict = NEED_USER_INPUT
  rejectionReason?: string; // verdict = REJECT
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
  model: string;
  createdAt: ISODateTime;
}
