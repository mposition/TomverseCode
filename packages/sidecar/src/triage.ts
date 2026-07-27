import type { ComplexityTier, WorkspaceSnapshot } from "@tomverse/protocol";

// docs/design/state-machine-and-protocol.md 13.2절 — 규칙 기반(비-LLM) 분류.
//
// TRIAGE에 LLM을 쓰지 않는 이유: 분류 자체에 모델을 부르면 모든 태스크에 세 번째 호출이
// 추가되어 "쉬운 태스크의 비용 절감"이라는 목적과 모순된다. SNAPSHOTTING 완료 시점에 이미
// 있는 신호만으로 판정한다.
//
// 기본 임계값은 초안이며 튜닝이 필요하다고 문서에 명시되어 있다(12절 미해결 항목) —
// 스파이크의 5개 초소형 태스크만으로는 근거가 부족하다.
export interface TriagePolicy {
  maxRelevantFiles: number;
  riskKeywords: string[];
}

/**
 * 테스트 파일로 보이는 경로.
 *
 * TRIAGE의 작업 파일 개수에서 제외하는 이유: Context Engine은 `paginate.js`를 지목한 요청에서
 * `paginate.test.js`도 함께 고른다(파일명 키워드 일치). 테스트 파일은 **작업 범위가 아니라
 * 그 작업을 판정할 근거**이므로 복잡도 신호로 세면 안 된다 — 세면 실질적으로 모든 태스크가
 * standard가 되어 TRIAGE가 죽고, 스파이크가 측정한 비용 절감 효과도 사라진다.
 *
 * 오분류 위험은 감수한다: 테스트 파일 자체를 고치는 태스크가 simple로 떨어질 수 있지만,
 * 13.2절대로 잘못된 simple 분류의 대가는 FIX_LOOP 1회로 국한되고 최종 정확성은
 * tier 판정에 의존하지 않는다.
 */
const TEST_FILE_PATTERNS = [/\.(test|spec)\.[cm]?[jt]sx?$/i, /(^|\/)__tests__\//i, /(^|\/)tests?\//i, /_test\.(py|go|rs)$/i, /(^|\/)test_[^/]+\.py$/i];

function looksLikeTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
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
    "delete",
  ],
};

export function triageTask(
  snapshot: WorkspaceSnapshot,
  userMessage: string,
  policy: TriagePolicy = DEFAULT_TRIAGE_POLICY
): ComplexityTier {
  // `project-meta`(README/CLAUDE.md/package.json)는 4절 규칙에 따라 **항상** 포함되므로
  // 태스크의 복잡도 신호가 아니다. 이걸 세면 모든 태스크가 standard로 분류되어 TRIAGE가
  // 무의미해진다 — 13.2절이 말하는 "관련 파일 개수"는 실제 작업 대상 파일을 뜻한다.
  const workFileCount = snapshot.relevantFiles.filter(
    (f) => f.reason !== "project-meta" && !looksLikeTestFile(f.path)
  ).length;
  const tooManyFiles = workFileCount > policy.maxRelevantFiles;

  const hasUncommittedChanges = Boolean(snapshot.gitDiffSummary && snapshot.gitDiffSummary.trim().length > 0);
  const lowerMessage = userMessage.toLowerCase();
  const matchesRiskKeyword = policy.riskKeywords.some((kw) => lowerMessage.includes(kw.toLowerCase()));

  if (tooManyFiles || hasUncommittedChanges || matchesRiskKeyword) {
    return "standard";
  }
  return "simple";
}
