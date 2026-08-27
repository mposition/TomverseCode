import { createHash } from "node:crypto";
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
    /**
     * `gpt-4.1`은 **별칭**이고 응답 envelope은 날짜 스냅샷 ID로 돌아온다.
     *
     * 실측(2026-08-27, `gate:g:probe-models`): `gpt-4.1`을 요청하고 `gpt-4.1-2025-04-14`를
     * 받았다. 조용한 대체가 아니라 OpenAI가 별칭을 그날의 스냅샷으로 푸는 정상 동작이며,
     * 그래서 **추측이 아니라 관측한 값 하나만** 적는다.
     *
     * prefix 비교로 뭉개지 않는 이유는 이 파일의 exact-model 검증 주석에 있다 —
     * `claude-sonnet-5`가 `claude-sonnet-5.5`의 prefix라 다른 모델을 통과시킨다.
     * 목록에 없는 ID가 오면 여전히 실패해야 한다. 그게 이 검증이 지키는 전부다.
     */
    acceptedProviderModelIds: ["gpt-4.1-2025-04-14"],
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
   * Google Gemini — M2 커버리지("멀티프로바이더 3사", product-strategy 8.2절).
   *
   * `structuredOutput`이 셋째 값 `response_schema`인 첫 항목이다. 그 축은 처음부터 있었고
   * (Insight 카탈로그에서 온 구분) 쓰는 어댑터가 없었을 뿐이다.
   *
   * **이 엔트리는 실측으로 확인되지 않았다** — 이 저장소의 개발 환경에는 Google 자격증명이
   * 없고 egress도 막혀 있다. 가격·컨텍스트 한도는 공개 문서 기준이며 `pricingAsOf`가 그
   * 시점을 말한다. 착지 기준은 multi-engine-routing.md 19절에 있다.
   */
  {
    modelId: "gemini-3-pro",
    providerId: "google",
    protocol: "native",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnvName: "GEMINI_API_KEY",
    capabilities: {
      toolCalling: "parallel",
      structuredOutput: "response_schema",
      imageInput: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 64_000,
    },
    economics: { inputPerMTok: 1.25, outputPerMTok: 10.0, pricingAsOf: PRICING_AS_OF },
    availability: { requiresOrgVerification: false },
  },
  {
    modelId: "gemini-3-flash",
    providerId: "google",
    protocol: "native",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnvName: "GEMINI_API_KEY",
    capabilities: {
      toolCalling: "parallel",
      structuredOutput: "response_schema",
      imageInput: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 64_000,
    },
    economics: { inputPerMTok: 0.3, outputPerMTok: 2.5, pricingAsOf: PRICING_AS_OF },
    availability: { requiresOrgVerification: false },
  },
  /**
   * API 키 없이 전체 루프를 돌리기 위한 결정론적 가짜 공급자 (작업 지침 4.6절 마지막 항목).
   *
   * 레지스트리에 넣은 이유: 라우터가 특별 취급하는 경로를 만들지 않기 위해서다. fake도
   * 그냥 하나의 공급자이므로 "검수자 독립성" 같은 불변식이 fake 조합에도 그대로 적용되고,
   * 그래서 그 불변식을 실제로 테스트할 수 있다.
   *
   * providerId가 세 개(fake-a/fake-b/fake-c)인 것도 그 때문이다 — 하나뿐이면 교차검증 경로를
   * 테스트할 수 없고, 둘뿐이면 **대조와 검수가 충돌하는 경우만** 테스트하게 된다
   * (multi-engine-routing.md 13.3절). 셋이면 "완전 독립 배정"과 "절충 배정"을 둘 다 실제로
   * 돌려볼 수 있다. 실제 배정은 `availableProviders`가 결정하므로, 세 번째가 있다고 해서
   * 자격증명이 둘뿐인 사용자의 경로가 바뀌지는 않는다.
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
  {
    // 세 번째 공급자 — 대조(executor ×2)와 독립 검수를 **동시에** 만족시킬 수 있는 경우를
    // 실제로 돌려보기 위한 것이다. 정적 우선순위에서 뒤로 가도록 컨텍스트를 작게 둔다:
    // 앞의 둘이 그대로 executor/co-executor로 뽑히고 이 항목이 reviewer가 되어야
    // 기존 테스트의 기대가 유지된다.
    modelId: "fake-third",
    providerId: "fake-c",
    protocol: "native",
    apiBaseUrl: "local://fake",
    apiKeyEnvName: "TOMVERSE_FAKE_KEY",
    capabilities: {
      toolCalling: "basic",
      structuredOutput: "forced_tool_use",
      imageInput: false,
      maxContextTokens: 64_000,
      maxOutputTokens: 8_192,
    },
    economics: { inputPerMTok: 0, outputPerMTok: 0, pricingAsOf: PRICING_AS_OF },
    availability: { requiresOrgVerification: false },
  },
];

/**
 * exact-model 검증 (§2).
 *
 * 비교는 **정확히 일치** 아니면 `acceptedProviderModelIds`에 명시된 값과의 일치뿐이다.
 * prefix 비교나 정규화를 하지 않는 이유: `claude-sonnet-5`는 `claude-sonnet-5.5`의 prefix이므로
 * prefix 규칙은 **다른 모델을 통과시킨다.** 느슨하게 열어 둔 축은 결국 아무것도 막지 않는다.
 *
 * `providerReportedModelId`가 없으면 검증 실패다 — 모르는 것을 통과시키지 않는다.
 */
export function providerModelIdAccepted(
  entry: ModelEntry,
  providerReportedModelId: string | undefined
): { ok: true; matchedBy: "exact" | "accepted_list" } | { ok: false; reason: string } {
  if (providerReportedModelId === undefined || providerReportedModelId.length === 0) {
    return {
      ok: false,
      reason: `${entry.modelId}: 응답 envelope에 모델 ID가 없습니다 — 요청 ID로 대체하지 않습니다`,
    };
  }
  if (providerReportedModelId === entry.modelId) return { ok: true, matchedBy: "exact" };
  const accepted = entry.acceptedProviderModelIds ?? [];
  if (accepted.includes(providerReportedModelId)) return { ok: true, matchedBy: "accepted_list" };
  return {
    ok: false,
    reason:
      `${entry.modelId}: 응답 모델 ID가 ${providerReportedModelId}입니다. ` +
      (accepted.length === 0
        ? `허용 목록(acceptedProviderModelIds)이 비어 있으므로 정확히 일치만 통과합니다.`
        : `허용 목록 [${accepted.join(", ")}]에도 없습니다.`),
  };
}

/**
 * 레지스트리 스냅샷 해시 — evidence가 "어떤 카탈로그 기준이었는가"를 남긴다.
 *
 * 해시에 넣는 것은 **비용·능력·가용성처럼 판정에 쓰이는 필드**다. `evaluation`처럼 실행이
 * 쌓으면서 바뀌는 필드는 넣지 않는다 — 그걸 넣으면 실행할수록 evidence가 무효가 된다.
 */
export function registrySnapshotHash(entries: readonly ModelEntry[]): string {
  const canonical = [...entries]
    .map((e) => ({
      modelId: e.modelId,
      providerId: e.providerId,
      protocol: e.protocol,
      apiBaseUrl: e.apiBaseUrl,
      apiKeyEnvName: e.apiKeyEnvName,
      capabilities: e.capabilities,
      economics: e.economics,
      availability: e.availability,
      acceptedProviderModelIds: e.acceptedProviderModelIds ?? [],
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/**
 * 이 항목이 **실제 공급자인가.**
 *
 * 예산 정산이 이걸 필요로 한다: 실제 호출이 입력·출력 토큰 0을 보고하면 그건 측정 실패이지만,
 * fake는 0이 정상이다. 두 경우를 구별하지 못하면 "0달러 썼다"가 언제나 통과한다.
 *
 * **판단 근거를 주소 스킴에 둔다.** `local://`는 이 레지스트리에서 하네스용 fake에만 쓰는
 * 구조적 표시이고, providerId 문자열의 `fake-` 접두사처럼 이름 규칙에 기대는 것보다 낫다 —
 * 이름은 바뀌지만 "네트워크로 나가지 않는다"는 성질은 주소가 말한다.
 */
export function providerKindOf(entry: ModelEntry): "real" | "fake" {
  return entry.apiBaseUrl.startsWith("local://") ? "fake" : "real";
}

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

  /**
   * 이 레지스트리 스냅샷의 해시.
   *
   * probe evidence에 박아 두면 "그 확인이 어떤 카탈로그 기준이었는가"가 남는다. 단가나 능력
   * 선언이 바뀐 뒤에도 예전 evidence를 그대로 쓰는 것을 막기 위한 것이다 — 비용 추정이
   * 달라지면 그 evidence로 승인한 예산의 의미도 달라진다.
   */
  snapshotHash(): string {
    return registrySnapshotHash(this.entries);
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
