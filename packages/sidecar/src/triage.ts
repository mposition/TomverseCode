import type { ComplexityTier, WorkspaceSnapshot } from "@tomverse/protocol";

// docs/design/state-machine-and-protocol.md 13.2절 — 규칙 기반(비-LLM) 분류.
// 기본 임계값은 초안이며 튜닝이 필요하다고 문서에 명시되어 있다(12절 미해결 항목).
export interface TriagePolicy {
  maxRelevantFiles: number;
  riskKeywords: string[];
}

export const DEFAULT_TRIAGE_POLICY: TriagePolicy = {
  maxRelevantFiles: 1,
  riskKeywords: [
    "아키텍처",
    "리팩터",
    "리팩토링",
    "마이그레이션",
    "보안",
    "인증",
    "결제",
    "삭제",
    "architecture",
    "refactor",
    "migration",
    "security",
    "auth",
    "payment",
  ],
};

export function triageTask(
  snapshot: WorkspaceSnapshot,
  userMessage: string,
  policy: TriagePolicy = DEFAULT_TRIAGE_POLICY
): ComplexityTier {
  const tooManyFiles = snapshot.relevantFiles.length > policy.maxRelevantFiles;
  const hasUncommittedChanges = Boolean(snapshot.gitDiffSummary && snapshot.gitDiffSummary.trim().length > 0);
  const lowerMessage = userMessage.toLowerCase();
  const matchesRiskKeyword = policy.riskKeywords.some((kw) => lowerMessage.includes(kw.toLowerCase()));

  if (tooManyFiles || hasUncommittedChanges || matchesRiskKeyword) {
    return "standard";
  }
  return "simple";
}
