import type { ModelEntry, ModelId, ProviderId } from "@tomverse/protocol";

/**
 * Model Registry — docs/design/multi-engine-routing.md 3절, 9절 0단계.
 *
 * 카탈로그 출처: Tomverse Insight(`mposition/Tomverse`)의 `lib/modelRegistryShared.ts` 및
 * `lib/models.ts`. 11.2절 결정대로 **코드가 아니라 데이터로 복사**했다 —
 * `protocol: "native" | "openai-compatible"` 구분과 baseUrl/apiKeyEnvName 매핑이 그것이다.
 * 크레딧 과금 관련 축(MODEL_USAGE_CREDIT_WEIGHTS, ModelTier)은 BYOK에 무의미하므로 가져오지 않았다(11.1절).
 *
 * 가격은 spike/src/config.ts의 2026-07 스냅샷을 승계했다. `pricingAsOf`가 있는 이유가 이것이다 —
 * 가격은 빠르게 낡으므로 언제 기준인지 없이는 비용 표시를 신뢰할 수 없다.
 *
 * 모델 ID를 코드에 고정하지 않는다는 요구(작업 지침 4.6절)는 이렇게 만족된다: 어댑터는
 * `ModelEntry`를 인자로 받고, 어떤 엔트리를 쓸지는 Router가 이 레지스트리에서 고른다.
 * 환경변수(`TOMVERSE_EXECUTOR_MODEL` 등)로 override할 수 있다.
 */

const PRICING_AS_OF = "2026-07-01T00:00:00Z";

export const BUILTIN_MODELS: ModelEntry[] = [
  {
    modelId: "gpt-5.1",
    providerId: "openai",
    protocol: "native",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKeyEnvName: "OPENAI_API_KEY",
    capabilities: {
      toolCalling: "parallel",
      structuredOutput: "strict_schema",
      imageInput: true,
      maxContextTokens: 400_000,
      maxOutputTokens: 128_000,
    },
    economics: { inputPerMTok: 1.25, outputPerMTok: 10.0, pricingAsOf: PRICING_AS_OF },
    // gpt-5 계열은 Organization Verification을 요구한다 — 스파이크에서 실제로 막혔던 축이다
    // (state-machine-and-protocol.md 13.3절).
    availability: { requiresOrgVerification: true },
  },
  {
    modelId: "gpt-4.1",
    providerId: "openai",
    protocol: "native",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKeyEnvName: "OPENAI_API_KEY",
    capabilities: {
      toolCalling: "parallel",
      structuredOutput: "strict_schema",
      imageInput: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 32_768,
    },
    economics: { inputPerMTok: 2.0, outputPerMTok: 8.0, pricingAsOf: PRICING_AS_OF },
    // 조직 인증이 없어도 쓸 수 있는 폴백. 스파이크가 실제로 이 모델로 돌았다.
    availability: { requiresOrgVerification: false },
  },
  {
    modelId: "claude-sonnet-5",
    providerId: "anthropic",
    protocol: "native",
    apiBaseUrl: "https://api.anthropic.com",
    apiKeyEnvName: "ANTHROPIC_API_KEY",
    capabilities: {
      toolCalling: "parallel",
      structuredOutput: "forced_tool_use",
      imageInput: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    economics: { inputPerMTok: 2.0, outputPerMTok: 10.0, pricingAsOf: PRICING_AS_OF },
    availability: { requiresOrgVerification: false },
  },
  {
    modelId: "claude-opus-4-8",
    providerId: "anthropic",
    protocol: "native",
    apiBaseUrl: "https://api.anthropic.com",
    apiKeyEnvName: "ANTHROPIC_API_KEY",
    capabilities: {
      toolCalling: "parallel",
      structuredOutput: "forced_tool_use",
      imageInput: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 32_000,
    },
    economics: { inputPerMTok: 5.0, outputPerMTok: 25.0, pricingAsOf: PRICING_AS_OF },
    availability: { requiresOrgVerification: false },
  },
  /**
   * API 키 없이 전체 루프를 돌리기 위한 결정론적 가짜 공급자 (작업 지침 4.6절 마지막 항목).
   *
   * 레지스트리에 넣은 이유: 라우터가 특별 취급하는 경로를 만들지 않기 위해서다. fake도
   * 그냥 하나의 공급자이므로 "검수자 독립성" 같은 불변식이 fake 조합에도 그대로 적용되고,
   * 그래서 그 불변식을 실제로 테스트할 수 있다.
   *
   * providerId가 두 개(fake-a/fake-b)인 것도 그 때문이다 — 하나뿐이면 교차검증 경로를
   * 테스트할 수 없다.
   */
  {
    modelId: "fake-executor",
    providerId: "fake-a",
    protocol: "native",
    apiBaseUrl: "local://fake",
    apiKeyEnvName: "TOMVERSE_FAKE_KEY",
    capabilities: {
      toolCalling: "basic",
      structuredOutput: "strict_schema",
      imageInput: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    economics: { inputPerMTok: 0, outputPerMTok: 0, pricingAsOf: PRICING_AS_OF },
    availability: { requiresOrgVerification: false },
  },
  {
    modelId: "fake-reviewer",
    providerId: "fake-b",
    protocol: "native",
    apiBaseUrl: "local://fake",
    apiKeyEnvName: "TOMVERSE_FAKE_KEY",
    capabilities: {
      toolCalling: "basic",
      structuredOutput: "forced_tool_use",
      imageInput: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    economics: { inputPerMTok: 0, outputPerMTok: 0, pricingAsOf: PRICING_AS_OF },
    availability: { requiresOrgVerification: false },
  },
];

export class ModelRegistry {
  private readonly entries: ModelEntry[];

  constructor(entries: ModelEntry[] = BUILTIN_MODELS) {
    this.entries = entries;
  }

  all(): ModelEntry[] {
    return [...this.entries];
  }

  get(modelId: ModelId): ModelEntry | undefined {
    return this.entries.find((e) => e.modelId === modelId);
  }

  /**
   * **레지스트리는 사용자별로 해석된다** (3절 마지막 문단).
   *
   * BYOK에서 모델 가용성은 전역 사실이 아니라 자격증명별 사실이다. 그래서 이 함수는
   * "어떤 공급자의 키가 실제로 있는가"(Rust가 알려준 `availableProviders`)를 반드시 받는다.
   *
   * `requiresOrgVerification`인 모델은 키가 있어도 후보에서 제외한다 — 확인되기 전까지
   * "사용 가능"으로 취급하지 않는 것이 gpt-5 사건의 교훈이다. 실제 호출에서 `model_not_found`가
   * 나오면 태스크가 실패하는데, 그건 사용자에게 "왜 실패했는지 모르겠는 실패"로 보인다.
   */
  available(availableProviders: readonly string[], options: { allowOrgVerified?: boolean } = {}): ModelEntry[] {
    const providers = new Set(availableProviders);
    return this.entries.filter((entry) => {
      if (!providers.has(entry.providerId)) return false;
      if (entry.availability.requiresOrgVerification && !options.allowOrgVerified) return false;
      if (entry.availability.deprecatedAfter && entry.availability.deprecatedAfter < new Date().toISOString()) {
        return false;
      }
      return true;
    });
  }

  providersOf(entries: ModelEntry[]): ProviderId[] {
    return [...new Set(entries.map((e) => e.providerId))];
  }

  /** 레지스트리의 가격 정보로 비용을 계산한다. 가격이 0인 fake는 0을, 없는 모델은 undefined를 준다. */
  costUsd(modelId: ModelId, usage: { inputTokens: number; outputTokens: number }): number | undefined {
    const entry = this.get(modelId);
    if (!entry) return undefined;
    return (
      (usage.inputTokens / 1_000_000) * entry.economics.inputPerMTok +
      (usage.outputTokens / 1_000_000) * entry.economics.outputPerMTok
    );
  }
}
