import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "../config.js";
import type { BaselineFix, DraftProposal, FixtureTask, ReviewDecision, Verdict } from "../types.js";

// Constructed lazily (not at module scope) so that config.requireApiKeys()
// gets a chance to produce a friendly error before the SDK's own
// credential error fires.
let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return client;
}

const REVIEW_TOOL = {
  name: "submit_review",
  description:
    "Submit your independent review verdict for the proposed fix. Judge it against the bug report and the test file — do not assume the draft is correct.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string" as const,
        enum: ["ACCEPT", "REVISE", "REJECT"],
        description:
          "ACCEPT if the proposed file correctly fixes the bug as-is. REVISE if the general approach is right but the file needs changes. REJECT if the draft is wrong or the bug report is unaddressable.",
      },
      rationale: { type: "string" as const },
      finalFile: {
        type: "string" as const,
        description: "Required for ACCEPT/REVISE: the complete file content to apply. Omit for REJECT.",
      },
    },
    required: ["verdict", "rationale"],
  },
};

const BASELINE_TOOL = {
  name: "submit_fix",
  description: "Submit your fix for the reported bug.",
  input_schema: {
    type: "object" as const,
    properties: {
      rationale: { type: "string" as const },
      finalFile: {
        type: "string" as const,
        description: "The COMPLETE corrected file content, ready to overwrite the buggy file as-is.",
      },
    },
    required: ["rationale", "finalFile"],
  },
};

function buildReviewPrompt(task: FixtureTask, draft: DraftProposal): string {
  return [
    "You are independently reviewing a proposed bug fix drafted by another engineer (not necessarily correct).",
    "Do not trust the draft's interpretation blindly — re-derive the root cause yourself from the bug report and test file, then judge whether the proposed file actually fixes it.",
    "",
    `## Bug report\n${task.taskDescription}`,
    "",
    `## Original (buggy) file: ${task.buggyFileName}\n\`\`\`js\n${task.buggyFileContent}\n\`\`\``,
    "",
    `## Test file: ${task.testFileName}\n\`\`\`js\n${task.testFileContent}\n\`\`\``,
    "",
    `## Draft author's interpretation\n${draft.interpretation}`,
    "",
    `## Draft author's proposed file\n\`\`\`js\n${draft.proposedFile}\n\`\`\``,
    "",
    "Submit your verdict via the submit_review tool.",
  ].join("\n");
}

function buildBaselinePrompt(task: FixtureTask): string {
  return [
    "You are fixing a reported bug in a small Node.js module, working alone with no second opinion.",
    "Read the bug report, the current (buggy) file, and its test file, then produce a corrected version of the file.",
    "",
    `## Bug report\n${task.taskDescription}`,
    "",
    `## Current file: ${task.buggyFileName}\n\`\`\`js\n${task.buggyFileContent}\n\`\`\``,
    "",
    `## Test file: ${task.testFileName}\n\`\`\`js\n${task.testFileContent}\n\`\`\``,
    "",
    "Submit your fix via the submit_fix tool.",
  ].join("\n");
}

function findToolInput<T>(message: Anthropic.Message, toolName: string): T {
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === toolName
  );
  if (!block) {
    throw new Error(`No ${toolName} tool_use block in Claude response`);
  }
  return block.input as T;
}

export async function reviewDraft(task: FixtureTask, draft: DraftProposal): Promise<ReviewDecision> {
  const start = Date.now();
  const message = await getClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "tool", name: "submit_review" },
    messages: [{ role: "user", content: buildReviewPrompt(task, draft) }],
  });
  const latencyMs = Date.now() - start;

  const input = findToolInput<{ verdict: Verdict; rationale: string; finalFile?: string }>(
    message,
    "submit_review"
  );

  return {
    verdict: input.verdict,
    rationale: input.rationale,
    finalFile: input.verdict === "REJECT" ? null : input.finalFile ?? draft.proposedFile,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    latencyMs,
  };
}

export async function baselineFix(task: FixtureTask): Promise<BaselineFix> {
  const start = Date.now();
  const message = await getClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    tools: [BASELINE_TOOL],
    tool_choice: { type: "tool", name: "submit_fix" },
    messages: [{ role: "user", content: buildBaselinePrompt(task) }],
  });
  const latencyMs = Date.now() - start;

  const input = findToolInput<{ rationale: string; finalFile: string }>(message, "submit_fix");

  return {
    finalFile: input.finalFile,
    rationale: input.rationale,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    latencyMs,
  };
}
