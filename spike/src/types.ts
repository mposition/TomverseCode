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

// docs/design/product-strategy.md 4절 참조.
//   informed — 실행 모델의 interpretation을 함께 본다 (원래 스파이크 동작)
//   blind    — 요구사항·원본 코드·테스트 파일·변경된 코드만 본다
export type ReviewMode = "informed" | "blind";

export interface ReviewDecision {
  mode: ReviewMode;
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
  reviewMode?: ReviewMode; // dual_verification only
  steps: Array<{ role: string; usage: TokenUsage; latencyMs: number; costUsd: number }>;
}

/**
 * blind와 informed 검수의 판정이 갈리는 빈도는 anchoring 크기의 직접 측정치다
 * (product-strategy.md 14절 지표). 두 arm은 **같은 초안 하나를 공유**한다 —
 * 초안을 두 번 생성하면 초안 자체의 변동이 교란 변수가 되어 비교가 무의미해진다.
 */
export interface AnchoringProbe {
  blindVerdict: Verdict;
  informedVerdict: Verdict;
  verdictsDiverged: boolean;
  blindTestPassed: boolean;
  informedTestPassed: boolean;
  /** 판정 차이가 실제 결과 차이로 이어졌는가 — anchoring이 유해했는지의 진짜 신호 */
  testOutcomesDiverged: boolean;
}

export interface TaskRunReport {
  taskId: string;
  /** 파이프라인의 실제 산출물. blind가 `verified` tier의 기본값이므로 blind arm이다. */
  dual: PipelineResult;
  /** 측정 전용 arm — 프로덕션에는 존재하지 않는 추가 호출이다. */
  dualInformed: PipelineResult;
  baseline: PipelineResult;
  anchoring: AnchoringProbe;
}
