import type { ComplexityTier, EngineRole, ISODateTime, ModelId, ProviderId } from "./common.js";

// docs/design/multi-engine-routing.md 3절 — Model Registry.
// 카탈로그 데이터의 출처는 Tomverse Insight의 lib/modelRegistryShared.ts이며(11절),
// 코드가 아니라 데이터로 복사한다. 크레딧 과금 관련 축은 가져오지 않는다(BYOK).

export type StructuredOutputMode =
  | "none"
  | "json_mode" // JSON 강제만, 스키마 미준수 가능
  | "strict_schema" // OpenAI Responses API text.format json_schema strict
  | "forced_tool_use" // Anthropic tool_choice: { type: "tool" }
  | "response_schema"; // Gemini responseSchema 계열

// Insight의 실증된 구분 — 어댑터를 모델별로 두지 않고 "공급자 전용 SDK가 필요한가"로 나눈다.
export type WireProtocol = "native" | "openai-compatible";

export interface ModelCapabilities {
  toolCalling: "none" | "basic" | "parallel";
  structuredOutput: StructuredOutputMode;
  imageInput: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface ModelEconomics {
  inputPerMTok: number;
  outputPerMTok: number;
  pricingAsOf: ISODateTime; // 가격은 빠르게 낡는다 — 언제 기준인지 반드시 기록
}

export interface ModelAvailability {
  // gpt-5 사건에서 배운 축: BYOK에서 모델 가용성은 전역 사실이 아니라 자격증명별 사실이다.
  requiresOrgVerification: boolean;
  dataRegion?: string;
  deprecatedAfter?: ISODateTime;
}

/**
 * 이 모델에 대해 관측된 것 — multi-engine-routing.md 8절/12절.
 *
 * # 모든 관측이 모델 비교인 것은 아니다
 *
 * 12절은 "표본 몇 개부터 라우팅에 반영할 것인가"를 물었다. 그런데 임계를 정하기 전에 물어야
 * 하는 것이 있다: **어떤 관측이 애초에 모델 간 비교가 되는가.** 대부분은 되지 않는다.
 *
 * 종전 정의는 `verificationPassRate` 하나를 최상위에 두고 있었다. 그런데 **어떤 모델이 어떤
 * 태스크를 받았는지는 라우터가 정한다.** 그 비율은 라우터가 만든 분포 위에서 재는 값이고,
 * 모델의 능력과 "그 모델에게 배정된 태스크가 쉬웠는지"를 함께 담는다. 표본이 쌓여도 이
 * 편향은 줄지 않고, 신뢰구간만 좁아져 더 그럴듯해진다 — 8절 부트스트랩 순환의 잔여물이다.
 *
 * 그래서 타입을 둘로 가른다. **가르지 않으면 언젠가 누군가 `verificationPassRate`로 라우팅을
 * 바꾸고, 그 결정이 왜 틀렸는지는 코드 어디에도 남아 있지 않다.**
 */
export interface ModelEvaluation {
  /** **라우팅에 반영해도 되는 신호.** 대조 실행의 정면 비교뿐이다. */
  paired: PairedEvaluation;
  /** 관측되지만 모델 **간** 비교에 쓰면 안 되는 값들. */
  unpaired: UnpairedObservations;
  lastUpdatedAt: ISODateTime;
}

/**
 * 대조 실행(13절 co-executor)에서의 정면 비교.
 *
 * 두 모델이 **같은 태스크·같은 스냅샷**에 대해 안을 냈고 사용자가 골랐다. 태스크 난이도가
 * 양쪽에 똑같이 걸리므로 승패가 모델의 차이를 말한다.
 *
 * **태스크가 표본 단위다.** 한 태스크의 쟁점들은 같은 두 초안에서 나오므로 독립이 아니고,
 * 쟁점으로 세면 쟁점 4개짜리 태스크 하나가 표본 4가 되어 유의성이 부풀려진다.
 *
 * 판정자가 사용자인 것은 대리 지표라서가 아니다 — 요구에 대한 최종 권위가 사용자이므로
 * (product-strategy.md 16절) 이건 **재려던 것 그 자체**다.
 */
export interface PairedEvaluation {
  /** 상대 모델 ID → 그 모델과의 전적. 승/무 모두 **태스크 수**다. */
  headToHead: Record<ModelId, { wins: number; losses: number; ties: number }>;
  /**
   * 이 데이터로 라우팅을 바꿔도 되는가.
   *
   * 최소 표본은 상수가 아니라 **검정에서 유도된다**: 한쪽이 n번 모두 이길 확률이 유의수준보다
   * 크면 그 표본으로는 무엇을 관측하든 갈릴 수 없다. 집계는 `tomverse-host metrics`의
   * `modelEvaluation`이 한다.
   */
  verdict: "too_few_to_separate" | "no_difference" | "separated";
}

/**
 * 절대 지표. **모델끼리 비교하지 않는다.**
 *
 * 쓸모가 없다는 뜻이 아니다: 같은 모델의 시간에 따른 변화, 공급자 장애, 비용 예측에 쓴다.
 * 쓸 수 없는 것은 "A가 B보다 낫다"는 문장 하나뿐이고, 그게 정확히 라우팅이 필요로 하는
 * 문장이라 따로 이름을 붙여 둔다.
 */
export interface UnpairedObservations {
  /** 이 모델이 executor였던 태스크 수. */
  taskCount: number;
  /** VERIFYING을 통과한 비율. 결정론적이지만 **분포는 라우터가 만든 것**이다. */
  verificationPassRate: number;
  medianLatencyMs: number;
  medianCostUsd: number;
}

export interface ModelEntry {
  modelId: ModelId;
  providerId: ProviderId;
  protocol: WireProtocol;
  apiBaseUrl: string;
  /** 이 공급자의 키를 담는 환경변수 이름. 값이 아니라 이름만 레지스트리에 둔다. */
  apiKeyEnvName: string;
  capabilities: ModelCapabilities;
  economics: ModelEconomics;
  availability: ModelAvailability;
  /**
   * 이 엔트리로 요청했을 때 **응답 envelope이 실어 올 수 있는 모델 ID의 명시적 목록.**
   *
   * # 왜 필요한가
   *
   * 공급자는 alias(`claude-sonnet-5`)로 요청해도 dated ID(`claude-sonnet-5-20250929`)로
   * 응답할 수 있다. 그때 `providerReportedModelId === requestedModelId`는 거짓이 되고,
   * 실험은 정당한 응답을 조용한 대체로 오판한다.
   *
   * 그렇다고 prefix 비교나 정규화로 풀지 않는다 — `claude-sonnet-5`가 `claude-sonnet-5.5`의
   * prefix이기도 하므로, prefix 규칙은 **다른 모델을 통과시킨다.** 정규화 규칙은 공급자의
   * 명명 관례가 바뀌면 조용히 틀리기도 한다.
   *
   * 그래서 허용 목록을 사람이 명시한다. 비어 있거나 없으면 **정확히 일치만** 허용한다 —
   * 기본값이 느슨한 쪽이면 이 축이 있으나 마나다.
   *
   * 실험에서는 alias보다 **pinned(dated) 모델 ID를 우선**한다. 그러면 이 목록이 필요 없고,
   * "무엇을 측정했는가"가 시간이 지나도 그대로 남는다.
   */
  acceptedProviderModelIds?: ModelId[];
  // 8절 부트스트랩 — 초기엔 비어있고 실제 실행 데이터가 쌓이면 채워진다.
  evaluation?: ModelEvaluation;
}

export interface RoleAssignment {
  role: EngineRole;
  modelId: ModelId;
  providerId: ProviderId;
  reason: string; // 왜 이 모델이 선택됐는지 — 감사 로그 및 UI 표시용
}

export interface RoutingDecision {
  taskId: string;
  complexityTier: ComplexityTier;
  activeRoles: EngineRole[]; // simple이면 ["executor"] 하나뿐
  assignments: RoleAssignment[];
  appliedPolicies: string[]; // forceComplexityTier, reviewer 드롭 사유 등 override 흔적
  /**
   * 5절 불변식: executor와 reviewer가 모두 활성이면 두 역할의 providerId가 달라야 한다.
   * 서로 다른 공급자를 찾지 못해 reviewer를 드롭했으면 false이며, UI가 이 값을 보고
   * "교차검증 없이 진행됨"을 표시한다. 조용히 같은 공급자로 검증한 척하지 않는다.
   */
  reviewerIndependent: boolean;
  estimatedCostUsd: number;
  decidedAt: ISODateTime;
}
