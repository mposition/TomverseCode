export interface FixtureTask {
  id: string;
  dir: string;
  taskDescription: string;
  buggyFileName: string;
  buggyFileContent: string;
  testFileName: string;
  testFileContent: string;
}

export type Verdict = "ACCEPT" | "REVISE" | "REJECT";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DraftProposal {
  interpretation: string;
  proposedFile: string;
  usage: TokenUsage;
  latencyMs: number;
}

export interface ReviewDecision {
  verdict: Verdict;
  rationale: string;
  finalFile: string | null; // null when verdict = REJECT
  usage: TokenUsage;
  latencyMs: number;
}

export interface BaselineFix {
  finalFile: string;
  rationale: string;
  usage: TokenUsage;
  latencyMs: number;
}

export interface TestOutcome {
  passed: boolean;
  exitCode: number;
  output: string;
}

export interface PipelineResult {
  pipeline: "dual_verification" | "baseline_single_model";
  taskId: string;
  test: TestOutcome;
  costUsd: number;
  latencyMs: number;
  verdict?: Verdict; // dual_verification only
  steps: Array<{ role: string; usage: TokenUsage; latencyMs: number; costUsd: number }>;
}

export interface TaskRunReport {
  taskId: string;
  dual: PipelineResult;
  baseline: PipelineResult;
}
