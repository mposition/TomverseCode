import "dotenv/config";

/**
 * Pricing snapshot as of 2026-07 (per 1M tokens, USD). Verify against provider
 * pricing pages before relying on cost totals for anything beyond this spike —
 * these numbers go stale quickly and Anthropic's Sonnet 5 rate shown here is
 * introductory pricing that changes 2026-09-01.
 */
export const PRICING = {
  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-5.5": { input: 5.0, output: 30.0 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
} as const;

export type KnownModel = keyof typeof PRICING;

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

// gpt-5/gpt-5.5 are reasoning models gated behind OpenAI's Organization
// Verification (https://platform.openai.com/settings/organization/general).
// Defaulting to gpt-4.1 so the spike runs without waiting on that approval —
// override via OPENAI_MODEL once your org is verified, if you want to compare.
export const OPENAI_MODEL = (process.env.OPENAI_MODEL ?? "gpt-4.1") as KnownModel;
export const ANTHROPIC_MODEL = (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5") as KnownModel;

export function costUsd(model: KnownModel, usage: { inputTokens: number; outputTokens: number }): number {
  const rate = PRICING[model];
  if (!rate) {
    throw new Error(`No pricing entry for model "${model}" — add one to PRICING in src/config.ts`);
  }
  return (usage.inputTokens / 1_000_000) * rate.input + (usage.outputTokens / 1_000_000) * rate.output;
}

// anchoringProbe는 OpenAI를 호출하지 않으므로(합성 초안 사용) Anthropic 키만 요구한다.
export function requireAnthropicKey(): void {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "Missing required environment variable: ANTHROPIC_API_KEY. Copy .env.example to .env and fill it in."
    );
  }
}

export function requireApiKeys(): void {
  const missing: string[] = [];
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. Copy .env.example to .env and fill them in.`
    );
  }
}
