import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../config.js";
import type { DraftProposal, FixtureTask } from "../types.js";

// Constructed lazily (not at module scope) so that config.requireApiKeys()
// gets a chance to produce a friendly error before the SDK's own
// "Missing credentials" error fires.
let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
}

const DRAFT_SCHEMA = {
  type: "object" as const,
  properties: {
    interpretation: {
      type: "string",
      description: "Your understanding of the bug and the root cause, in one or two sentences.",
    },
    proposedFile: {
      type: "string",
      description: "The COMPLETE corrected file content, ready to overwrite the buggy file as-is.",
    },
  },
  required: ["interpretation", "proposedFile"],
  additionalProperties: false,
};

function buildPrompt(task: FixtureTask): string {
  return [
    "You are drafting a fix for a reported bug in a small Node.js module.",
    "Read the bug report, the current (buggy) file, and its test file, then propose a corrected version of the file.",
    "",
    `## Bug report\n${task.taskDescription}`,
    "",
    `## Current file: ${task.buggyFileName}\n\`\`\`js\n${task.buggyFileContent}\n\`\`\``,
    "",
    `## Test file: ${task.testFileName}\n\`\`\`js\n${task.testFileContent}\n\`\`\``,
    "",
    "Respond with your interpretation of the root cause and the complete corrected file content.",
  ].join("\n");
}

export async function draftFix(task: FixtureTask): Promise<DraftProposal> {
  const start = Date.now();
  const response = await getClient().responses.create({
    model: OPENAI_MODEL,
    input: [{ role: "user", content: buildPrompt(task) }],
    text: {
      format: {
        type: "json_schema",
        name: "draft_proposal",
        strict: true,
        schema: DRAFT_SCHEMA,
      },
    },
  });
  const latencyMs = Date.now() - start;

  const raw = extractOutputText(response);
  const parsed = JSON.parse(raw) as { interpretation: string; proposedFile: string };

  return {
    interpretation: parsed.interpretation,
    proposedFile: parsed.proposedFile,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    latencyMs,
  };
}

function extractOutputText(response: any): string {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  // Fallback: walk response.output[].content[].text for older/edge SDK shapes.
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  throw new Error("Could not extract structured output text from OpenAI response");
}
