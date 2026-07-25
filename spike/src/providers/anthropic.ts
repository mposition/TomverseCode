import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "../config.js";
import type {
  BaselineFix,
  DraftProposal,
  FixtureTask,
  ReviewDecision,
  ReviewMode,
  Verdict,
} from "../types.js";

// Constructed lazily (not at module scope) so that config.requireApiKeys()
// gets a chance to produce a friendly error before the SDK's own
// credential error fires.
let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return client;
}

// 도구 설명은 두 모드에서 동일해야 한다 — 여기에 "draft"/"author" 같은 단어가 남으면
// blind 모드에서도 "누군가의 초안을 평가한다"는 프레이밍이 새어 들어간다.
const REVIEW_TOOL = {
  name: "submit_review",
  description:
    "Submit your independent verdict on the proposed change. Judge it against the stated requirement and the test file — do not assume it is correct.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string" as const,
        enum: ["ACCEPT", "REVISE", "REJECT"],
        description:
          "ACCEPT if the proposed file correctly satisfies the requirement as-is. REVISE if the general approach is right but the file needs changes. REJECT if the approach is wrong or the requirement is unaddressable.",
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

/**
 * informed 모드 — 원래 스파이크 동작. 실행 모델의 자기설명(`interpretation`)을 함께 본다.
 * 편의를 위해서가 아니라 **비교군**으로 남긴다: blind와의 판정 차이가 anchoring 크기다.
 */
function buildInformedReviewPrompt(task: FixtureTask, draft: DraftProposal): string {
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

/**
 * blind 모드 — product-strategy.md 4절.
 *
 * 제공: 요구사항, 원본 코드, 테스트 파일, 변경된 코드 (전부 저장소 사실이거나 사용자 입력)
 * 숨김: 실행 모델의 이름·공급자, interpretation, 자기평가
 *
 * "누가 썼는지"를 언급하지 않는 중립적 프레이밍을 쓴다 — "다른 엔지니어의 초안"이라고만 해도
 * 평가자가 초안 작성자의 역량을 추정하기 시작하고, 그것 자체가 약한 anchoring이다.
 */
function buildBlindReviewPrompt(task: FixtureTask, candidateFile: string): string {
  return [
    // 첫 두 줄은 informed 프롬프트와 의미를 맞춘다. 두 모드가 "숨긴 정보" 외에
    // 지시 강도(판정만 할지, 직접 고칠지)까지 달라지면 비교가 교란된다.
    "You are independently reviewing a proposed code change (not necessarily correct).",
    "Re-derive the root cause yourself from the requirement and the test file, then judge whether the proposed file actually fixes it.",
    "",
    `## Requirement (as reported by the user)\n${task.taskDescription}`,
    "",
    `## Current file, before the change: ${task.buggyFileName}\n\`\`\`js\n${task.buggyFileContent}\n\`\`\``,
    "",
    `## Test file: ${task.testFileName}\n\`\`\`js\n${task.testFileContent}\n\`\`\``,
    "",
    `## Proposed file, after the change\n\`\`\`js\n${candidateFile}\n\`\`\``,
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

export async function reviewDraft(
  task: FixtureTask,
  draft: DraftProposal,
  mode: ReviewMode
): Promise<ReviewDecision> {
  const prompt =
    mode === "blind"
      ? buildBlindReviewPrompt(task, draft.proposedFile)
      : buildInformedReviewPrompt(task, draft);

  const start = Date.now();
  const message = await getClient().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "tool", name: "submit_review" },
    messages: [{ role: "user", content: prompt }],
  });
  const latencyMs = Date.now() - start;

  const input = findToolInput<{ verdict: Verdict; rationale: string; finalFile?: string }>(
    message,
    "submit_review"
  );

  return {
    mode,
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
