import { ANTHROPIC_MODEL, OPENAI_MODEL, costUsd } from "./config.js";
import { baselineFix, reviewDraft } from "./providers/anthropic.js";
import { draftFix } from "./providers/openai.js";
import { runTestAgainstCandidate } from "./testRunner.js";
import type {
  AnchoringProbe,
  DraftProposal,
  FixtureTask,
  PipelineResult,
  ReviewMode,
  TaskRunReport,
} from "./types.js";

/**
 * 하나의 초안에 대해 지정된 검수 모드로 검수 → 적용 → 테스트까지 수행한다.
 * 초안 비용/지연은 인자로 받아 각 arm의 합계에 포함시킨다.
 */
async function runReviewArm(
  task: FixtureTask,
  draft: DraftProposal,
  mode: ReviewMode,
  draftCostUsd: number
): Promise<PipelineResult> {
  const review = await reviewDraft(task, draft, mode);
  const reviewCost = costUsd(ANTHROPIC_MODEL, review.usage);

  const candidateFile = review.finalFile ?? task.buggyFileContent;
  const test = await runTestAgainstCandidate(task, candidateFile);

  return {
    pipeline: "dual_verification",
    taskId: task.id,
    test,
    verdict: review.verdict,
    reviewMode: mode,
    costUsd: draftCostUsd + reviewCost,
    latencyMs: draft.latencyMs + review.latencyMs,
    steps: [
      { role: "openai_draft", usage: draft.usage, latencyMs: draft.latencyMs, costUsd: draftCostUsd },
      {
        role: `claude_review_${mode}`,
        usage: review.usage,
        latencyMs: review.latencyMs,
        costUsd: reviewCost,
      },
    ],
  };
}

async function runBaseline(task: FixtureTask): Promise<PipelineResult> {
  const fix = await baselineFix(task);
  const fixCost = costUsd(ANTHROPIC_MODEL, fix.usage);

  const test = await runTestAgainstCandidate(task, fix.finalFile);

  return {
    pipeline: "baseline_single_model",
    taskId: task.id,
    test,
    costUsd: fixCost,
    latencyMs: fix.latencyMs,
    steps: [{ role: "claude_baseline", usage: fix.usage, latencyMs: fix.latencyMs, costUsd: fixCost }],
  };
}

export async function runTask(task: FixtureTask): Promise<TaskRunReport> {
  // 초안은 **한 번만** 생성하고 두 검수 arm이 공유한다. 초안을 arm마다 새로 만들면
  // 초안 자체의 변동이 교란 변수가 되어 blind/informed 비교가 무의미해진다.
  const draft = await draftFix(task);
  const draftCost = costUsd(OPENAI_MODEL, draft.usage);

  // blind가 파이프라인의 실제 산출물(`verified` tier 기본값),
  // informed는 anchoring 측정을 위한 비교군 — 프로덕션에는 없는 추가 호출이다.
  const dual = await runReviewArm(task, draft, "blind", draftCost);
  const dualInformed = await runReviewArm(task, draft, "informed", draftCost);
  const baseline = await runBaseline(task);

  const anchoring: AnchoringProbe = {
    blindVerdict: dual.verdict!,
    informedVerdict: dualInformed.verdict!,
    verdictsDiverged: dual.verdict !== dualInformed.verdict,
    blindTestPassed: dual.test.passed,
    informedTestPassed: dualInformed.test.passed,
    testOutcomesDiverged: dual.test.passed !== dualInformed.test.passed,
  };

  return { taskId: task.id, dual, dualInformed, baseline, anchoring };
}
