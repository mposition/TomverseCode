export type ISODateTime = string;

export type Verdict = "ACCEPT" | "REVISE" | "REJECT" | "NEED_USER_INPUT";

export type RiskTier = "auto" | "conditional" | "user_approval" | "blocked";

export type ComplexityTier = "simple" | "standard";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// docs/design/multi-engine-routing.md 3절 — provider/model은 열린 집합이다.
// 유니온 타입으로 고정하면 엔진 추가가 스키마 마이그레이션이 되므로 런타임 값으로 둔다.
export type ProviderId = string;
export type ModelId = string;

// docs/design/multi-engine-routing.md 4절 — phase가 어느 모델을 부르는지는 역할로 표현한다.
export type EngineRole = "planner" | "executor" | "reviewer";
