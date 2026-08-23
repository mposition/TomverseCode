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
  /**
   * **경로**에서 읽는 위험 신호 — product-strategy 5절의 세 항목 중 둘.
   *
   * `riskKeywords`가 보는 것은 사용자가 **뭐라고 썼는가**다. 그래서 같은 작업이라도 "결제 로직
   * 고쳐줘"는 `standard`가 되고 "이 함수 좀 봐줘"는 `simple`이 된다 — 위험은 표현이 아니라
   * 코드에 있는데 판정은 표현에 달려 있었다. 경로는 사용자가 고르는 값이 아니므로 그 의존이 없다.
   *
   * 경로 **구분자 사이의 조각**과 파일명 앞부분에만 맞춘다. 단순 포함으로 보면 `auth`가
   * `author.ts`에 걸리고, 그러면 이 신호는 잡음이 된다.
   */
  riskPathSegments: string[];
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
  // 인증·결제·암호화 경로와 DB migration. **"public API 변경"은 넣지 않았다** — 그건 심볼
  // 분석이 있어야 판정할 수 있고(Tree-sitter는 아직 없다, context-engine 9절), 경로 이름으로
  // 흉내 내면 맞을 때보다 틀릴 때가 많다. 없는 신호를 있는 척하지 않는다.
  riskPathSegments: [
    "auth",
    "login",
    "session",
    "credential",
    "credentials",
    "token",
    "password",
    "payment",
    "payments",
    "billing",
    "checkout",
    "invoice",
    "crypto",
    "cipher",
    "signature",
    "migration",
    "migrations",
    "migrate",
  ],
};

/**
 * 이 경로가 위험 구역인가.
 *
 * **경계를 지킨다.** 디렉터리 조각이 정확히 같거나, 파일명이 그 조각으로 시작하고 뒤에
 * 이름 문자가 아닌 것이 오는 경우만 인정한다 — 단순 포함이면 `auth`가 `author.ts`에,
 * `token`이 `tokenizer.ts`에 걸린다. 잡음이 섞이면 이 신호는 "전부 standard"로 수렴하고,
 * 그건 TRIAGE를 죽이는 것과 같다.
 */
function riskSegmentsIn(path: string, segments: readonly string[]): string[] {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter((p) => p.length > 0);
  const dirs = new Set(parts.slice(0, -1));
  const base = parts[parts.length - 1] ?? "";
  // 파일명은 `.`/`-`/`_`로 잘라 조각으로 본다: `auth.ts`, `auth-helper.ts`, `reset_password.py`.
  const baseTokens = new Set(base.split(/[.\-_]/).filter((p) => p.length > 0));
  return segments.filter((seg) => dirs.has(seg.toLowerCase()) || baseTokens.has(seg.toLowerCase()));
}

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
  /**
   * 관련 파일의 **경로**가 위험 구역을 가리켰는가.
   *
   * `riskKeywordMatched`와 뭉치지 않는 이유: 둘은 서로 다른 것에 의존한다. 하나는 사용자의
   * 표현, 다른 하나는 코드의 위치다. 한 값으로 합치면 "이 태스크가 왜 standard였나"에
   * 답할 수 없고, 무엇보다 **어느 신호가 실제로 일하는지 잴 수 없다.**
   */
  riskPathMatched: boolean;
  /** 어떤 경로의 어떤 조각이 걸렸는가. 개수가 아니라 값이어야 판정을 사후에 검증할 수 있다. */
  riskPaths: { path: string; segments: string[] }[];
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

  // **테스트 파일도 본다.** 복잡도 **개수**에서는 빼지만 위험 구역 판정에서는 빼지 않는다 —
  // `auth/login.test.ts`가 있다는 것은 그 태스크가 인증 근처라는 뜻이고, 그 사실은 그 파일을
  // 세는지와 무관하다. 두 규칙이 같은 목록을 본다고 해서 같은 것을 묻는 것은 아니다.
  const riskPaths = notProjectMeta
    .map((f) => ({ path: f.path, segments: riskSegmentsIn(f.path, policy.riskPathSegments) }))
    .filter((hit) => hit.segments.length > 0);

  // 근거를 먼저 모으고 판정은 `tierAtThreshold` 한 곳에서 한다. 여기에 판정식을 한 번 더
  // 적으면 임계값을 바꿔 다시 계산할 때 **두 식이 갈라진 채로 통과**할 수 있다.
  const evidence = {
    workFileCount,
    excludedTestFiles,
    riskKeywordMatched: matchesRiskKeyword,
    riskPathMatched: riskPaths.length > 0,
    riskPaths,
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
 * 경로 위험 신호를 **판정에 쓸 것인가**의 기본값.
 *
 * `true`인 근거는 라벨 붙은 29개 세트의 실측이다(state-machine 13.4.1절). 같은 임계값에서
 * 어려운 태스크를 `simple`로 보낸 것이 **20/24 → 19/24**로 줄었고, 쉬운 태스크를 `standard`로
 * 보낸 것은 **1/5로 그대로**다. 한쪽을 개선하고 다른 쪽을 악화시키지 않으므로 **교환비를
 * 정하지 않고도** 답이 된다 — 스윕 표가 쓰는 지배 관계 그대로다.
 *
 * **이득이 크다는 뜻은 아니다.** 24건 중 1건이고, 대가가 0인 것은 이 세트의 쉬운 태스크에
 * 위험 경로가 없기 때문이기도 하다. 실사용에서 `auth/` 아래의 쉬운 태스크는 `standard`로 갈
 * 것이고 그 대가는 여기서 관측되지 않는다.
 */
export const DEFAULT_USE_RISK_PATHS = true;

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
    "workFileCount" | "excludedTestFiles" | "riskKeywordMatched" | "riskPathMatched" | "uncommittedChanges"
  >,
  maxRelevantFiles: number,
  countTestFiles = false,
  useRiskPaths = DEFAULT_USE_RISK_PATHS
): ComplexityTier {
  const files = countTestFiles
    ? evidence.workFileCount + evidence.excludedTestFiles.length
    : evidence.workFileCount;
  if (evidence.riskKeywordMatched || evidence.uncommittedChanges) return "standard";
  if (useRiskPaths && evidence.riskPathMatched) return "standard";
  return files > maxRelevantFiles ? "standard" : "simple";
}
