import type { AcceptanceCriterion, DraftProposal, VerificationDigest, WorkspaceSnapshot } from "@tomverse/protocol";

/**
 * 프롬프트 조립. 어댑터 두 개(OpenAI/Anthropic)가 공유한다 —
 * **두 모델은 동일한 기준 스냅샷을 받아야 한다**(context-engine.md 1절). 프롬프트 조립이
 * 어댑터별로 갈라지면 코드 상태 차이가 모델 간 불일치처럼 보이게 되고, 그건 이 제품이
 * 측정하려는 것을 오염시킨다.
 */

export function renderSnapshot(snapshot: WorkspaceSnapshot): string {
  const parts: string[] = [];

  parts.push(
    [
      "## Repository state",
      `branch: ${snapshot.gitBranch}`,
      `uncommitted changes: ${snapshot.gitDirty ? "yes" : "no"}`,
      snapshot.gitDiffSummary ? `diff summary:\n${snapshot.gitDiffSummary}` : "diff summary: (clean)",
    ].join("\n")
  );

  const meta = snapshot.projectMeta;
  const commands = [
    meta.buildCommand && `build: ${renderCommand(meta.buildCommand)}`,
    meta.testCommand && `test: ${renderCommand(meta.testCommand)}`,
    meta.typecheckCommand && `typecheck: ${renderCommand(meta.typecheckCommand)}`,
    meta.lintCommand && `lint: ${renderCommand(meta.lintCommand)}`,
  ].filter((v): v is string => Boolean(v));

  parts.push(
    [
      "## Project",
      `languages: ${meta.languages.join(", ") || "(unknown)"}`,
      commands.length > 0 ? `verification commands:\n${commands.map((c) => `  - ${c}`).join("\n")}` : "verification commands: (none detected)",
    ].join("\n")
  );

  if (meta.agentsMdContent) {
    parts.push(`## Project rules (${(meta.agentsMdSources ?? []).join(", ")})\n${meta.agentsMdContent}`);
  }

  parts.push("## Files");
  for (const file of snapshot.relevantFiles) {
    const header = `### ${file.path}\n(selected because: ${file.reasonDetail})${
      file.truncated ? "\n(NOTE: this file is TRUNCATED — do not assume the omitted part is absent)" : ""
    }`;
    parts.push(`${header}\n\`\`\`\n${file.content}\n\`\`\``);
  }

  if (snapshot.excludedNotes && snapshot.excludedNotes.length > 0) {
    parts.push(
      "## Files deliberately excluded from context\n" +
        snapshot.excludedNotes.map((n) => `- ${n.path}: ${n.reason}`).join("\n") +
        "\nDo not guess their contents. If you need one of them, ask instead."
    );
  }

  return parts.join("\n\n");
}

function renderCommand(cmd: { program: string; args: string[]; cwd: string }): string {
  return `${[cmd.program, ...cmd.args].join(" ")} (in ${cmd.cwd})`;
}

const PATCH_RULES = [
  "Return changes as a unified diff in the `patch` field.",
  "The diff MUST apply cleanly with exact context matching — no fuzzy matching is performed.",
  "Use hunk headers of the form `@@ -oldStart,oldCount +newStart,newCount @@`.",
  "Context lines start with a single space, removals with `-`, additions with `+`.",
  "Include at least one line of surrounding context per hunk when the file is non-empty.",
  "Hunks must appear in ascending order of original line number.",
  "Only modify files that appear in the Files section above.",
].join("\n");

/**
 * 확정된 기준 블록 — docs/design/state-machine-and-protocol.md 17.3절 규칙 1.
 *
 * **`user_decision`을 위에 따로 두고 "반박 불가"라고 적는다.** 모델 제안(`draft_proposal`)과
 * 한 목록에 섞으면 둘 다 참고 사항으로 읽히는데, 둘의 권위는 다르다 — 하나는 사용자가 정한
 * 요구이고 다른 하나는 이전 라운드의 모델이 제안한 후보다(product-strategy.md 16.1절).
 */
function renderCriteria(criteria: readonly AcceptanceCriterion[] | undefined): string | null {
  if (!criteria || criteria.length === 0) return null;
  const decided = criteria.filter((c) => c.source === "user_decision");
  const proposed = criteria.filter((c) => c.source !== "user_decision");
  const parts = ["## Acceptance criteria"];

  if (decided.length > 0) {
    parts.push(
      "These were decided by the USER and are not negotiable. A patch that does not satisfy them is wrong,",
      "no matter how reasonable it looks:",
      ...decided.map((c) => `- ${c.text}`)
    );
  }
  if (proposed.length > 0) {
    parts.push(
      "",
      "Proposed by an earlier draft (candidates — the user may overrule them):",
      ...proposed.map((c) => `- ${c.text}`)
    );
  }
  return parts.join("\n");
}

export function buildDraftPrompt(input: {
  userMessage: string;
  snapshot: WorkspaceSnapshot;
  userAnswers?: { question: string; answer: string }[];
  acceptanceCriteria?: AcceptanceCriterion[];
  criteriaFeedback?: string[];
}): string {
  const parts = [
    "You are the executor in a verification-first coding agent. Your patch will be applied to a real repository and then judged by the project's build/test/lint commands — not by your own confidence.",
    "",
    `## Task\n${input.userMessage}`,
  ];

  if (input.userAnswers && input.userAnswers.length > 0) {
    parts.push(
      "## Clarifications already provided by the user\n" +
        input.userAnswers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n")
    );
  }

  const criteria = renderCriteria(input.acceptanceCriteria);
  if (criteria) parts.push(criteria);

  if (input.criteriaFeedback && input.criteriaFeedback.length > 0) {
    // **이건 검증 실패가 아니다.** 아직 아무것도 적용되지 않았고, 직전 초안이 사용자가 고정한
    // 기준과 어긋나 다시 요청하는 것이다. FIX_LOOP 문구와 섞이면 모델이 "이미 적용된 변경을
    // 고치는" 모드로 읽는다.
    parts.push(
      "## Your previous draft was rejected before it was applied\n" +
        input.criteriaFeedback.map((f) => `- ${f}`).join("\n") +
        "\nNothing has been applied to the repository. Produce a patch that satisfies the criteria above."
    );
  }

  parts.push(renderSnapshot(input.snapshot));
  parts.push(`## Output rules\n${PATCH_RULES}`);
  return parts.join("\n\n");
}

export function buildReviewPrompt(input: {
  userMessage: string;
  snapshot: WorkspaceSnapshot;
  draft: DraftProposal;
  blind?: boolean;
  acceptanceCriteria?: AcceptanceCriterion[];
}): string {
  const parts = [
    "You are an independent reviewer. The draft below was written by a different model, which may be wrong.",
    "Re-derive the root cause yourself from the task and the files, then judge whether the proposed patch actually fixes it.",
    "",
    `## Task\n${input.userMessage}`,
  ];

  // 17.1절: 검수자의 역할이 "초안이 옳은지"에서 **"사용자가 고정한 기준이 반영됐는지"**로
  // 좁아졌다. 스냅샷보다 앞에 둔다 — 무엇을 확인해야 하는지를 먼저 읽어야 한다.
  const criteria = renderCriteria(input.acceptanceCriteria);
  if (criteria) {
    parts.push(
      criteria +
        "\n\nYour first job is to check whether the patch satisfies the USER-decided criteria above." +
        "\nIf it does not, that alone is grounds for REVISE or REJECT — regardless of whether the patch looks correct otherwise."
    );
  }

  parts.push(renderSnapshot(input.snapshot));

  if (input.blind) {
    // product-strategy.md 4절 Blind Review — 초안 작성자의 자기설명을 숨겨 anchoring을 줄인다.
    //
    // **기본값이 되지 않는다.** 한때 여기 "M1이 켤 자리"라고 적혀 있었는데, 4.1절 실측이
    // 그 계획을 뒤집었다: anchoring은 관측되지 않았고(informed 검수가 확신에 찬 거짓 주장을
    // 명시적으로 반박했다) 정보를 숨긴 대가는 실재했다(blind 0/3, informed 2/3). 4.2절이
    // "blind를 기본값으로"를 **철회**했으므로, 이 주석을 읽고 기본값을 뒤집으면 측정으로 내린
    // 결정을 되돌리는 것이 된다. 실험 플래그로 남겨 계속 잰다.
    parts.push(
      "## Proposed patch (author's own explanation withheld deliberately)\n```diff\n" + (input.draft.patch ?? "(no patch)") + "\n```"
    );
  } else {
    parts.push(
      [
        "## Draft author's interpretation",
        input.draft.interpretation,
        "",
        "## Draft author's stated risks",
        input.draft.risks.length > 0 ? input.draft.risks.map((r) => `- ${r}`).join("\n") : "(none stated)",
        "",
        "## Proposed patch",
        "```diff",
        input.draft.patch ?? "(no patch)",
        "```",
      ].join("\n")
    );
  }

  parts.push(
    [
      "## Verdict rules",
      "ACCEPT — the patch is correct as-is. Leave `revisedPatch` empty.",
      "REVISE — the approach is right but the patch needs changes. Provide a complete corrected `revisedPatch`.",
      "REJECT — the patch is wrong or the request cannot be safely addressed. Give `rejectionReason`.",
      "NEED_USER_INPUT — the request is genuinely ambiguous. Give `questionsForUser`.",
      "",
      PATCH_RULES,
    ].join("\n")
  );
  return parts.join("\n\n");
}

export function buildSingleModelFixPrompt(input: {
  userMessage: string;
  snapshot: WorkspaceSnapshot;
  userAnswers?: { question: string; answer: string }[];
  acceptanceCriteria?: AcceptanceCriterion[];
  criteriaFeedback?: string[];
}): string {
  const parts = [
    "You are fixing a bug alone — this task was classified as low-complexity, so no second model will review your patch before it is applied.",
    "The project's build/test/lint commands WILL run afterwards and are the final judge.",
    "If the request is genuinely ambiguous, say so (NEED_USER_INPUT) instead of guessing.",
    "",
    `## Task\n${input.userMessage}`,
  ];
  if (input.userAnswers && input.userAnswers.length > 0) {
    parts.push(
      "## Clarifications already provided by the user\n" +
        input.userAnswers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n")
    );
  }
  const fixCriteria = renderCriteria(input.acceptanceCriteria);
  if (fixCriteria) parts.push(fixCriteria);
  if (input.criteriaFeedback && input.criteriaFeedback.length > 0) {
    parts.push(
      "## Your previous draft was rejected before it was applied\n" +
        input.criteriaFeedback.map((f) => `- ${f}`).join("\n") +
        "\nNothing has been applied to the repository."
    );
  }
  parts.push(renderSnapshot(input.snapshot));
  parts.push(
    [
      "## Verdict rules",
      "ACCEPT — you have a fix. Provide `patch`.",
      "NEED_USER_INPUT — the request is ambiguous. Provide `questionsForUser`.",
      "REJECT — the request is impossible or unsafe. Provide `rejectionReason`.",
      "",
      PATCH_RULES,
    ].join("\n")
  );
  return parts.join("\n\n");
}

/**
 * FIX_LOOP 프롬프트 — 문서 6절의 재전달 페이로드.
 * 전체 로그가 아니라 digest + 적용된 delta만 보낸다(토큰 누적 팽창 방지).
 */
export function buildFixPrompt(input: {
  userMessage: string;
  snapshot: WorkspaceSnapshot;
  appliedChanges: string;
  digest: VerificationDigest;
}): string {
  const failing = input.digest.failingChecks
    .map((check) =>
      [
        `### ${check.kind}${check.command ? ` — ${check.command}` : ""}${
          check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""
        }`,
        "```",
        check.excerpt,
        "```",
        check.fileReferences.length > 0
          ? `referenced: ${check.fileReferences.map((f) => (f.line ? `${f.path}:${f.line}` : f.path)).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  const parts = [
    "Your previous patch was applied and then failed deterministic verification. Fix it.",
    "Base your fix on the verification output below — it is ground truth, not an opinion.",
    "",
    `## Task\n${input.userMessage}`,
    `## Attempt number\n${input.digest.attemptNumber}`,
    // **```diff 블록이 아니다.** 우리는 diff를 갖고 있지 않다 — 여기 실리는 것은 경로와
    // 크기뿐이고, 변경 내용 자체는 위 스냅샷이 이미 적용된 상태로 보여준다(6.1절).
    // 제목과 fence가 diff라고 말하면 모델은 없는 diff를 찾다가 크기 한 줄을 diff로 읽는다.
    `## Files your previous attempt changed\n${input.appliedChanges || "(none recorded)"}\n\n` +
      "Their current contents are already shown in the workspace snapshot above — that snapshot " +
      "reflects your change. This section is an index, not a diff.",
    `## Failing checks\n${failing || "(no failing check detail available)"}`,
    `## Checks that passed\n${input.digest.passingChecksSummary || "(none)"}`,
  ];

  if (input.digest.preexistingFailuresSummary) {
    // 원래 깨져 있던 것을 고치려 시도하면 범위가 번지고 검증도 통과하지 못한다.
    parts.push(
      `## Already failing before your change — DO NOT try to fix these\n${input.digest.preexistingFailuresSummary}`
    );
  }

  parts.push(renderSnapshot(input.snapshot));
  parts.push(
    [
      "## Output rules",
      "The files shown above were re-read from disk AFTER your previous change was applied — they are the current state.",
      "Your patch must apply to them as shown. Do not re-apply changes that are already there.",
      "ACCEPT with a `patch` if you can fix it. REJECT with `rejectionReason` if the failure is not caused by your change.",
      "",
      PATCH_RULES,
    ].join("\n")
  );
  return parts.join("\n\n");
}

// ---- 구조화 출력 스키마 (두 어댑터가 공유) ----

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    interpretation: { type: "string", description: "Your understanding of the root cause, 1-3 sentences." },
    patch: { type: "string", description: "Unified diff to apply. Empty string if no change is needed." },
    plan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepId: { type: "string" },
          description: { type: "string" },
          targetPaths: { type: "array", items: { type: "string" } },
        },
        required: ["stepId", "description", "targetPaths"],
        additionalProperties: false,
      },
    },
    risks: { type: "array", items: { type: "string" } },
    requiredTests: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    doneCriteria: { type: "array", items: { type: "string" } },
  },
  required: ["interpretation", "patch", "plan", "risks", "requiredTests", "uncertainties", "doneCriteria"],
  additionalProperties: false,
} as const;

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REVISE", "REJECT", "NEED_USER_INPUT"] },
    rationale: { type: "string" },
    revisedPatch: { type: "string", description: "Required for REVISE: the corrected unified diff." },
    questionsForUser: { type: "array", items: { type: "string" } },
    rejectionReason: { type: "string" },
  },
  // verdict에 따라 필요한 필드가 달라지므로 required는 최소로 둔다 —
  // strict schema에서 전부 required로 만들면 모델이 REJECT일 때 빈 patch를 억지로 채운다
  // (스파이크에서 실제로 겪은 문제, state-machine-and-protocol.md 13.3절).
  required: ["verdict", "rationale"],
} as const;

export const SINGLE_FIX_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ACCEPT", "REJECT", "NEED_USER_INPUT"] },
    rationale: { type: "string" },
    patch: { type: "string", description: "Required for ACCEPT: unified diff to apply." },
    questionsForUser: { type: "array", items: { type: "string" } },
    rejectionReason: { type: "string" },
  },
  required: ["verdict", "rationale"],
} as const;
