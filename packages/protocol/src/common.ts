export type ISODateTime = string;

export type Verdict = "ACCEPT" | "REVISE" | "REJECT" | "NEED_USER_INPUT";

export type RiskTier = "auto" | "conditional" | "user_approval" | "blocked";

export type ComplexityTier = "simple" | "standard";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
