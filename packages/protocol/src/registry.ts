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
