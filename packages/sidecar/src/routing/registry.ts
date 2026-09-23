import { createHash } from "node:crypto";
import type { CliVendor, ModelEntry, ModelId, ModelPathKey, ProviderId } from "@tomverse/protocol";
import { modelPathKey } from "@tomverse/protocol";

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
    transport: "http",
    endpointRegion: "international",
    providerJurisdiction: ["미국 (OpenAI, L.L.C.)"],
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    grade: "unmeasured",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
  },
  {
    modelId: "gpt-4.1",
    providerId: "openai",
    protocol: "native",
    transport: "http",
    endpointRegion: "international",
    providerJurisdiction: ["미국 (OpenAI, L.L.C.)"],
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    grade: "unmeasured",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
  },
  {
    modelId: "claude-sonnet-5",
    providerId: "anthropic",
    protocol: "native",
    transport: "http",
    endpointRegion: "international",
    providerJurisdiction: ["미국 (Anthropic PBC)"],
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    grade: "unmeasured",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
  },
  {
    modelId: "claude-opus-4-8",
    providerId: "anthropic",
    protocol: "native",
    transport: "http",
    endpointRegion: "international",
    providerJurisdiction: ["미국 (Anthropic PBC)"],
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    grade: "unmeasured",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
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
    transport: "http",
    endpointRegion: "international",
    providerJurisdiction: ["미국 (Google LLC)"],
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    grade: "unmeasured",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
  },
  {
    modelId: "gemini-3-flash",
    providerId: "google",
    protocol: "native",
    transport: "http",
    endpointRegion: "international",
    providerJurisdiction: ["미국 (Google LLC)"],
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    grade: "unmeasured",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
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
   *
   * # 이 셋에는 `grade`가 붙어 있다 — **측정값이 아니다**
   *
   * 21.4절은 "등급은 측정으로만 붙는다"고 정했고 그 규칙은 **실제 공급자**에 대한 것이다.
   * fake는 모델이 아니라 하네스이므로 잴 능력이 없고, 그래서 여기 적힌 값은 능력에 대한
   * 주장이 아니라 **고정된 fixture 값**이다.
   *
   * 비워 두지 않는 이유는 위 문단이 적은 것 그대로다: fake를 둔 목적이 "불변식을 실제로
   * 테스트할 수 있게" 하는 것인데, 21.6절이 `unmeasured`를 A·B·C 기본 배정에서 막으므로
   * 전부 `unmeasured`로 두면 **계획 검토·결과 검토 경로를 아무도 태워볼 수 없다.**
   * 라우터가 fake를 특별 취급하게 만드는 것(그쪽이 더 나쁘다)을 피하는 유일한 길이다.
   *
   * 실제 공급자가 측정 없이 등급을 얻는 것은 `registryAxes.test.ts`가 막는다.
   */
  {
    modelId: "fake-executor",
    providerId: "fake-a",
    protocol: "native",
    transport: "http",
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    // 하네스 fixture의 등급 — 아래 머리말 참조. 측정값이 아니다.
    grade: "economy",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
  },
  {
    modelId: "fake-reviewer",
    providerId: "fake-b",
    protocol: "native",
    transport: "http",
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    // 하네스 fixture의 등급 — 아래 머리말 참조. 측정값이 아니다.
    grade: "frontier",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
  },
  {
    // 세 번째 공급자 — 대조(executor ×2)와 독립 검수를 **동시에** 만족시킬 수 있는 경우를
    // 실제로 돌려보기 위한 것이다. 정적 우선순위에서 뒤로 가도록 컨텍스트를 작게 둔다:
    // 앞의 둘이 그대로 executor/co-executor로 뽑히고 이 항목이 reviewer가 되어야
    // 기존 테스트의 기대가 유지된다.
    modelId: "fake-third",
    providerId: "fake-c",
    protocol: "native",
    transport: "http",
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
    // 21.4절: 등급 초기값은 전부 `unmeasured`다 — 측정으로만 붙는다.
    // 하네스 fixture의 등급 — 아래 머리말 참조. 측정값이 아니다.
    grade: "frontier",
    accounting: "metered",
    // 21.9절: 공급자별 파라미터 이름·단위·허용값을 아직 확인하지 않았다.
    effort: { kind: "none" },
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
      // **정렬도 비교도 경로 키로 한다**(21.4절) — 같은 modelId가 두 줄일 수 있으므로
      // modelId로 정렬하면 순서가 결정되지 않고, 그러면 같은 카탈로그가 다른 해시를 낸다.
      pathKey: modelPathKey(e),
      modelId: e.modelId,
      providerId: e.providerId,
      protocol: e.protocol,
      transport: e.transport,
      cliVendor: e.cliVendor ?? null,
      apiBaseUrl: e.apiBaseUrl ?? null,
      apiKeyEnvName: e.apiKeyEnvName,
      capabilities: e.capabilities,
      economics: e.economics,
      availability: e.availability,
      // 판정에 쓰이는 축은 전부 들어간다 — 등급이나 과금 방식이 바뀌면 비용 추정과 배정
      // 가능성이 함께 바뀌므로, 예전 evidence를 그대로 쓰면 승인한 예산의 의미가 달라진다.
      grade: e.grade,
      gradeInheritedFrom: e.gradeInheritedFrom ?? null,
      accounting: e.accounting,
      endpointRegion: e.endpointRegion ?? null,
      providerJurisdiction: e.providerJurisdiction ?? null,
      effort: e.effort,
      acceptedProviderModelIds: e.acceptedProviderModelIds ?? [],
    }))
    .sort((a, b) => a.pathKey.localeCompare(b.pathKey));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/**
 * 공급자 호출의 **성질** — 예산 정산과 가설 게이트 집계가 이 셋을 다르게 다룬다.
 *
 * `real` 실제 HTTP 호출 — 토큰 0은 측정 실패다
 * `fake` 하네스용 결정론적 공급자 — 토큰 0이 정상이고 비용도 0이 맞다
 * `cli`  Rust가 spawn하는 CLI 경로 — 나가기는 하지만 응답 envelope이 없다(21.7절)
 */
export type ProviderKind = "real" | "fake" | "cli";

/**
 * 이 항목이 **실제 공급자인가.**
 *
 * 예산 정산이 이걸 필요로 한다: 실제 호출이 입력·출력 토큰 0을 보고하면 그건 측정 실패이지만,
 * fake는 0이 정상이다. 두 경우를 구별하지 못하면 "0달러 썼다"가 언제나 통과한다.
 *
 * **판단 근거를 주소 스킴에 둔다.** `local://`는 이 레지스트리에서 하네스용 fake에만 쓰는
 * 구조적 표시이고, providerId 문자열의 `fake-` 접두사처럼 이름 규칙에 기대는 것보다 낫다 —
 * 이름은 바뀌지만 "네트워크로 나가지 않는다"는 성질은 주소가 말한다.
 *
 * # 값이 셋인 이유 (21.7절)
 *
 * CLI 경로는 `real`도 `fake`도 아니다. 실제로 네트워크로 나가지만(→ `fake`가 아니다),
 * 응답 envelope이 없어 토큰 사용량이 보고되지 않을 수 있고 `accounting: "subscription"`이면
 * 토큰 단가 자체가 없다(→ `real`의 "0 토큰 = 측정 실패" 규칙이 걸리면 언제나 실패로 읽힌다).
 * **둘 중 하나로 접는 쪽을 고르면 대가가 양쪽 다 있으므로 접지 않는다.**
 */
export function providerKindOf(entry: ModelEntry): ProviderKind {
  // **`transport`를 먼저 본다.** CLI를 `real | fake` 둘 중 하나로 접으면 대가가 양쪽 다
  // 있다(21.7절·72.15절): `real`이면 모든 CLI 호출이 "0 토큰 = 측정 실패"로 보이고
  // (아래 주석이 예산 정산을 거기 걸어 두었다), `fake`면 가설 게이트 집계가 오염된다.
  if (entry.transport === "cli") return "cli";
  return entry.apiBaseUrl?.startsWith("local://") ? "fake" : "real";
}

/**
 * HTTP 어댑터가 쓸 baseURL — **없으면 예외다.**
 *
 * `apiBaseUrl`이 선택 필드가 된 뒤로(21.4절) HTTP 어댑터에 `undefined`를 넘기면 SDK가
 * **자기 기본 엔드포인트로 조용히 대체한다.** 그 순간 21.5절의 "모든 엔드포인트는
 * 국제용이다"가 카탈로그를 거치지 않고 우회되고, 증상은 아무것도 없다 — 요청이 성공하기
 * 때문이다. 없는 것은 없는 모양이어야 하고, **없는 것을 기본값으로 메우는 자리도
 * 만들지 않는다.**
 */
export function httpBaseUrlOf(entry: ModelEntry): string {
  if (entry.transport !== "http" || entry.apiBaseUrl === undefined) {
    throw new Error(
      `${entry.providerId}/${entry.modelId}: HTTP 어댑터인데 apiBaseUrl이 없습니다 ` +
        `(transport=${entry.transport}) — SDK 기본 엔드포인트로 대체하지 않습니다(21.5절)`
    );
  }
  return entry.apiBaseUrl;
}

export class ModelRegistry {
  private readonly entries: ModelEntry[];

  constructor(entries: ModelEntry[] = BUILTIN_MODELS) {
    this.entries = entries;
  }

  all(): ModelEntry[] {
    return [...this.entries];
  }

  /**
   * 이 모델의 **정본 경로** — 21.4절대로 키는 경로이지만 호출자 대부분은 모델 하나를 가리킨다.
   *
   * 경로가 둘 이상이면 **HTTP 경로를 준다.** 등급·단가·exact-model 검증이 전부 그 경로에서
   * 나오기 때문이다(21.7절: CLI 경로는 4·5단계를 자기 힘으로 통과할 수 없고 같은
   * `(providerId, modelId)`의 등급을 물려받는다). 특정 경로가 필요하면 `getPath`를 쓴다.
   *
   * **아무거나 먼저 나온 것을 주지 않는다** — 그러면 카탈로그에 CLI 줄을 추가하는 것만으로
   * 단가 계산과 검증 기준이 조용히 바뀐다.
   */
  get(modelId: ModelId): ModelEntry | undefined {
    const paths = this.entries.filter((e) => e.modelId === modelId);
    return paths.find((e) => e.transport === "http") ?? paths[0];
  }

  /** 경로를 정확히 지정해 조회한다. 키는 `(providerId, modelId, transport, cliVendor?)`. */
  getPath(key: ModelPathKey): ModelEntry | undefined {
    const wanted = modelPathKey(key);
    return this.entries.find((e) => modelPathKey(e) === wanted);
  }

  /** 이 모델에 대한 **모든 경로**. 전송 화면과 승인 카드가 "몇 가지로 부를 수 있는가"를 묻는다. */
  pathsOf(modelId: ModelId): ModelEntry[] {
    return this.entries.filter((e) => e.modelId === modelId);
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
  available(
    availableProviders: readonly string[],
    options: { allowOrgVerified?: boolean; enabledCliVendors?: readonly CliVendor[] } = {}
  ): ModelEntry[] {
    const providers = new Set(availableProviders);
    // **CLI 경로는 옵트인이다**(state-machine 72.10.1절). 막으려는 것은 "구독"이 아니라
    // **약관 리스크를 사용자에게 지우는 경로**이고, 그 성질은 `accounting`이 아니라
    // `transport: "cli"`에 붙어 있다 — 조건을 관측(`accounting`)에 걸면 사용량 과금 CLI가
    // 나오는 날 단서가 조용히 빠진다.
    //
    // 기본값이 "아무 CLI도 켜지 않음"인 것이 핵심이다. 열어 두면 동점이 생기는 순간 라우터가
    // 21.7절이 "기본 경로가 아니다"라고 못박은 경로를 사용자에게 묻지 않고 고르게 된다.
    const enabledCli = new Set(options.enabledCliVendors ?? []);
    return this.entries.filter((entry) => {
      if (!providers.has(entry.providerId)) return false;
      if (entry.transport === "cli" && !(entry.cliVendor && enabledCli.has(entry.cliVendor))) return false;
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

  /**
   * 이 사용량의 비용 — **금액으로 말할 수 없는 경우를 금액으로 말하지 않는다.**
   *
   * `accounting: "subscription"`인 경로에는 토큰 단가가 존재하지 않는다(21.7절). 그 호출의
   * 비용을 `0`으로 적으면 예산 화면이 **"안 썼다"고 거짓말한다** — 구독 용량에는 쿼터가 있고
   * 소진되면 어떻게 되는지 그 CLI가 정하지 우리가 모른다. `product-strategy` 6.1절이
   * `resolved_model_id`가 NULL일 때 "대체 없음"으로 접지 않은 것과 같은 규칙이다.
   *
   * **키가 `transport`가 아니라 `accounting`인 것이 중요하다**(21.4·21.7절). 막으려는 것은
   * "셀 수 없는 비용을 0으로 적는 것"이고 그 성질은 과금 방식에 붙어 있다 — 사용량으로
   * 과금하는 CLI가 나오면 그 엔트리의 비용은 셀 수 있고, 이 규칙이 그 사실을 덮어서는 안 된다.
   */
  costOf(
    modelId: ModelId,
    usage: { inputTokens: number; outputTokens: number }
  ): { kind: "usd"; usd: number } | { kind: "unknown"; reason: string } {
    const entry = this.get(modelId);
    if (!entry) return { kind: "unknown", reason: `${modelId}는 레지스트리에 없습니다` };
    if (entry.accounting === "subscription") {
      return {
        kind: "unknown",
        reason: `${modelId}는 구독에 포함되어 금액으로 환산되지 않습니다 (토큰 단가가 존재하지 않습니다)`,
      };
    }
    return {
      kind: "usd",
      usd:
        (usage.inputTokens / 1_000_000) * entry.economics.inputPerMTok +
        (usage.outputTokens / 1_000_000) * entry.economics.outputPerMTok,
    };
  }

  /**
   * `costOf`의 금액만 꺼내는 편의 함수. **`undefined`를 0으로 읽지 말 것** — 그 값은
   * "안 썼다"가 아니라 "금액으로 말할 수 없다"이고, 둘을 뭉개는 것이 `costOf`가 막는 것이다.
   * 합산하는 자리는 `costOf`를 써서 계량분과 환산 불가분을 **나눠 적어야 한다**(72.4절).
   */
  costUsd(modelId: ModelId, usage: { inputTokens: number; outputTokens: number }): number | undefined {
    const cost = this.costOf(modelId, usage);
    return cost.kind === "usd" ? cost.usd : undefined;
  }
}
