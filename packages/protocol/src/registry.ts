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

export interface ModelEvaluation {
  sampleCount: number;
  verificationPassRate: number; // VERIFYING을 통과한 비율 — 결정론적 정답
  medianLatencyMs: number;
  medianCostUsd: number;
  lastUpdatedAt: ISODateTime;
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
