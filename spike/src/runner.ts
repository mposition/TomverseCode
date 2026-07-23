import { ANTHROPIC_MODEL, OPENAI_MODEL, costUsd } from "./config.js";
import { baselineFix, reviewDraft } from "./providers/anthropic.js";
import { draftFix } from "./providers/openai.js";
import { runTestAgainstCandidate } from "./testRunner.js";
import type { FixtureTask, PipelineResult, TaskRunReport } from "./types.js";

async function runDualVerification(task: FixtureTask): Promise<PipelineResult> {
  const draft = await draftFix(task);
  const draftCost = costUsd(OPENAI_MODEL, draft.usage);

  const review = await reviewDraft(task, draft);
  const reviewCost = costUsd(ANTHROPIC_MODEL, review.usage);

  const candidateFile = review.finalFile ?? task.buggyFileContent;
  const test = await runTestAgainstCandidate(task, candidateFile);

  return {
    pipeline: "dual_verification",
    taskId: task.id,
    test,
    verdict: review.verdict,
    costUsd: draftCost + reviewCost,
    latencyMs: draft.latencyMs + review.latencyMs,
    steps: [
      { role: "openai_draft", usage: draft.usage, latencyMs: draft.latencyMs, costUsd: draftCost },
      { role: "claude_review", usage: review.usage, latencyMs: review.latencyMs, costUsd: reviewCost },
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
  const dual = await runDualVerification(task);
  const baseline = await runBaseline(task);
  return { taskId: task.id, dual, baseline };
}
