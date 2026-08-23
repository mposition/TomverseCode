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

/**
 * 분류와 **그 근거**. 테스트 파일 제외 규칙이 실제로 판정을 바꿨는지까지 담는다.
 *
 * # 왜 반사실을 함께 내는가
 *
 * context-engine.md 11.1절이 남긴 미해결 항목은 "테스트 파일 자체를 고치는 태스크가 `simple`로
 * 오분류될 수 있고, 그 **빈도를 측정해야 한다**"였다. 그런데 `tier` 하나만 기록하면 그 측정이
 * 불가능하다 — 어떤 태스크에서 이 규칙이 **작동하기라도 했는지** 알 수 없기 때문이다.
 * 제외된 테스트 파일이 있어도 다른 이유(위험 키워드, 미커밋 변경)로 이미 `standard`였다면
 * 그 태스크는 이 규칙에 대해 아무것도 말해주지 않는다.
 *
 * 그래서 **테스트 파일을 세었더라면 어떤 tier였을지**를 함께 남긴다. 둘이 다른 태스크만이
 * 이 규칙이 실제로 판정을 바꾼 경우이고, 그중 나중에 그 테스트 파일을 고친 태스크가
 * **오분류**다. 값 자체는 실사용이 쌓여야 나오지만, 이제 답이 나올 수 있는 형태다.
 */
export interface TriageResult {
  tier: ComplexityTier;
  /** 복잡도로 센 파일 수 (project-meta·테스트 파일 제외). */
  workFileCount: number;
  /** 테스트로 보여 제외한 경로. **개수가 아니라 경로**를 남긴다 — 나중에 그 파일이 실제로
   * 고쳐졌는지 대조해야 오분류를 셀 수 있다. */
  excludedTestFiles: string[];
  /** 테스트 파일을 세었더라면 나왔을 tier. 같으면 이 규칙은 이 태스크에서 무의미했다. */
  tierIfTestsCounted: ComplexityTier;
  /**
   * 파일 개수 말고 **다른 이유로** 이미 standard였는가.
   *
   * 이 둘이 없으면 기록만 보고 **임계값이 판정에 관여했는지조차 알 수 없다.** `tier`가
   * standard인 태스크가 파일 수 때문이었는지 위험 키워드 때문이었는지 구별되지 않으므로,
   * "`maxRelevantFiles`를 2로 올리면 무엇이 달라지는가"를 되물을 수 없다 — 12절이
   * 튜닝 대상이라고 적어둔 바로 그 상수인데도 그렇다.
   *
   * 값으로 남기면 **저장된 근거만으로 다른 임계값을 다시 계산할 수 있다.** 그게
   * `sweepThreshold`가 유료 호출 없이 성립하는 이유다.
   */
  riskKeywordMatched: boolean;
  uncommittedChanges: boolean;
}

/** 분류만 필요할 때. 근거가 필요하면 `triage`를 쓴다 — **판정 로직은 한 곳뿐이다.** */
export function triageTask(
  snapshot: WorkspaceSnapshot,
  userMessage: string,
  policy: TriagePolicy = DEFAULT_TRIAGE_POLICY
): ComplexityTier {
  return triage(snapshot, userMessage, policy).tier;
}

export function triage(
  snapshot: WorkspaceSnapshot,
  userMessage: string,
  policy: TriagePolicy = DEFAULT_TRIAGE_POLICY
): TriageResult {
  // `project-meta`(README/CLAUDE.md/package.json)는 4절 규칙에 따라 **항상** 포함되므로
  // 태스크의 복잡도 신호가 아니다. 이걸 세면 모든 태스크가 standard로 분류되어 TRIAGE가
  // 무의미해진다 — 13.2절이 말하는 "관련 파일 개수"는 실제 작업 대상 파일을 뜻한다.
  const notProjectMeta = snapshot.relevantFiles.filter((f) => f.reason !== "project-meta");
  const excludedTestFiles = notProjectMeta.filter((f) => looksLikeTestFile(f.path)).map((f) => f.path);
  const workFileCount = notProjectMeta.length - excludedTestFiles.length;

  const hasUncommittedChanges = Boolean(snapshot.gitDiffSummary && snapshot.gitDiffSummary.trim().length > 0);
  const lowerMessage = userMessage.toLowerCase();
  const matchesRiskKeyword = policy.riskKeywords.some((kw) => lowerMessage.includes(kw.toLowerCase()));

  // 근거를 먼저 모으고 판정은 `tierAtThreshold` 한 곳에서 한다. 여기에 판정식을 한 번 더
  // 적으면 임계값을 바꿔 다시 계산할 때 **두 식이 갈라진 채로 통과**할 수 있다.
  const evidence = {
    workFileCount,
    excludedTestFiles,
    riskKeywordMatched: matchesRiskKeyword,
    uncommittedChanges: hasUncommittedChanges,
  };

  return {
    ...evidence,
    tier: tierAtThreshold(evidence, policy.maxRelevantFiles),
    // 파일 수 말고 다른 이유로 이미 standard이면, 테스트 제외 규칙은 이 태스크에서 아무것도
    // 하지 않은 것이다 — 반사실도 같은 값이 되어 집계에서 저절로 빠진다.
    tierIfTestsCounted: tierAtThreshold(evidence, policy.maxRelevantFiles, true),
  };
}

/**
 * 기록된 근거만으로 **다른 임계값이었다면 어떤 tier였을지**를 다시 계산한다.
 *
 * # 왜 이게 가능한가 — 그리고 왜 중요한가
 *
 * 12절은 임계값 튜닝을 "어려운 태스크 세트로 스파이크를 재실행해야 한다"고 적었다. 그런데
 * TRIAGE는 **모델을 부르지 않는다**(이 파일 첫 주석). 규칙의 입력은 스냅샷과 사용자 메시지뿐이고,
 * 그 둘에서 나온 값이 위 `TriageResult`에 전부 남는다. 그러므로 임계값을 바꿔 다시 묻는 일은
 * **이미 기록된 근거에 대한 순수 계산**이며 유료 호출이 필요 없다.
 *
 * 필요한 것은 태스크를 다시 돌리는 것이 아니라 **난이도 라벨**이다 — 그건
 * `evals/hypothesis-gate`의 fixture 세트가 이미 사전 등록해 두었다.
 *
 * `countTestFiles`를 함께 받는 이유: 테스트 파일 제외 규칙도 튜닝 대상이고
 * (context-engine.md 11.1절), 둘을 따로 스윕하면 상호작용이 보이지 않는다.
 */
export function tierAtThreshold(
  evidence: Pick<
    TriageResult,
    "workFileCount" | "excludedTestFiles" | "riskKeywordMatched" | "uncommittedChanges"
  >,
  maxRelevantFiles: number,
  countTestFiles = false
): ComplexityTier {
  const files = countTestFiles
    ? evidence.workFileCount + evidence.excludedTestFiles.length
    : evidence.workFileCount;
  if (evidence.riskKeywordMatched || evidence.uncommittedChanges) return "standard";
  return files > maxRelevantFiles ? "standard" : "simple";
}
