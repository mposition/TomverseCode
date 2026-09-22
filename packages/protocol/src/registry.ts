import type {
  ComplexityTier,
  EffortLevel,
  EngineRole,
  ISODateTime,
  ReviewerIndependence,
  ModelId,
  ProviderId,
} from "./common.js";

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

/**
 * 이 모델의 **능력** 등급 — multi-engine-routing.md 21.4절.
 *
 * `PerformanceProfile`이 고를 대상이며, **추측이 아니라 우리 측정으로 붙는다.** 초기값은
 * 전부 `unmeasured`이고 게이트 fixture 세트로 재고 나서 바뀐다.
 *
 * **`unmeasured`를 `economy`로 접지 않는다.** 싸다는 것은 가격에 대한 사실이지 품질에 대한
 * 사실이 아니고, 둘을 뭉개면 "싼 모델은 약하다"는 추측이 등급이라는 이름으로 들어온다.
 *
 * 값이 둘(+미측정)로 충분한 이유는 `PerformanceProfile`이 등급을 직접 고르지 않고 **clamp로
 * 작동**하기 때문이다(state-machine 72.10절): `balanced`는 계획 모델의 판정을 그대로 쓰고,
 * 나머지 둘이 그 판정을 양 끝으로 가둔다. 셋째가 필요해지는 조건은 하나다 —
 * fixture 통과율 분포가 두 덩어리로 갈리지 않을 때(21.9절).
 */
export type ModelGrade = "economy" | "frontier" | "unmeasured";

/**
 * **비용 출처** — 능력 축(`grade`)과 다른 축이다(state-machine 72.10.1절).
 *
 * "싸다"가 두 가지 뜻이 되기 때문에 나눈다: `metered`는 **토큰 단가가 낮다**(= `economy`가
 * 뜻하는 것)이고, `subscription`은 **내가 이미 내고 있는 구독에 포함된다**로 단가와 무관하다.
 * frontier 모델이 포함된 용량으로 올 수도 있다.
 *
 * 라우팅에서는 **같은 등급 안의 동점을 가르는 축**이지 등급을 바꾸지 않는다. 순서를 뒤집으면
 * "포함되어 있다"가 "쓸 만하다"로 번진다 — 가격에 대한 사실을 품질에 대한 사실로 읽는 것.
 *
 * **`transport`의 파생값이 아니다**(21.4절). "CLI면 구독 정액"은 오늘 아는 CLI들에 대한
 * 관측이지 법칙이 아니고, 파생으로 두면 사용량 과금 CLI가 나오는 순간 그 사실을 **적을 수가
 * 없게** 된다.
 */
export type ModelAccounting = "metered" | "subscription";

/**
 * **누가 어떻게 부르는가** — multi-engine-routing.md 21.4·21.7절.
 *
 * `http`는 Node의 어댑터가 직접 부르고, `cli`는 **Rust가 spawn한다**(원칙 2: Node에는 자식
 * 프로세스 생성 경로가 없다). `providerId`는 이 축과 **무관하게** 실제 공급자를 가리킨다 —
 * 나누면 독립성 불변식이 `"anthropic ≠ claude-code-cli"`를 참으로 읽고, 같은 모델에게 초안과
 * 검수를 맡기고 "독립 검증"이라고 기록한다.
 */
export type ModelTransport = "http" | "cli";

/**
 * 어느 CLI를 지나는가 — `providerId`가 **아니다.**
 *
 * 독립성 계산에 들어가지 않고 자격증명 출처·argv·약관 리스크를 가리킬 뿐이다. `transport`
 * 하나로는 부족한 이유는 CLI 경로가 둘 이상일 수 있기 때문이다 — Cursor로도 Claude Code로도
 * Anthropic 모델에 닿는다(21.7절).
 *
 * **이 목록의 값은 아직 실측으로 확인되지 않았다**(21.7절이 스스로 선언했다). 실행 파일
 * 이름도, "Cursor가 여러 공급자를 중개한다"도 저장소 안에 근거가 없다. 그래서 이 저장소의
 * `BUILTIN_MODELS`에는 **`transport: "cli"` 엔트리가 아직 하나도 없다** — 축만 있고 행은
 * 확인 뒤에 들어온다(21.3절: 기억이나 인상으로 채우지 않는다 + 확인 날짜).
 */
export type CliVendor = "codex" | "claude-code" | "cursor";

/**
 * 이 모델이 `EffortLevel`을 **어느 파라미터로 받는가** — 21.4절의 `none | 매핑표`.
 *
 * 사용자에게 보이는 값은 닫힌 enum 셋인데 손잡이는 공급자마다 다르다. 어떤 곳은 enum이고
 * 어떤 곳은 토큰 예산 숫자이며, **아예 없는 모델도 있다.**
 *
 * `kind: "none"`이 기본값이고 **확인 전에는 그대로 둔다**(21.9절). 추측한 파라미터 이름은
 * 런타임 400으로 드러나지만 **조용히 무시되는 파라미터는 드러나지 않는다** — 그게 더 나쁜
 * 쪽이고 적합성 스위트(14절)가 잡아야 하는 것이다.
 */
export type EffortSupport =
  | { kind: "none" }
  | {
      kind: "mapped";
      /** 공급자 API에서의 파라미터 이름. */
      parameterName: string;
      /** 사용자 축 → 그 공급자의 실제 값. 이름도 단위도 공급자마다 다르다. */
      values: Record<EffortLevel, string | number>;
      /** `pricingAsOf`와 같은 취급 — 언제 확인한 값인지 없이는 신뢰할 수 없다. */
      verifiedAsOf: ISODateTime;
    };

/**
 * 레지스트리의 **키** — multi-engine-routing.md 21.4·21.7절.
 *
 * 키가 `modelId`가 아니게 된 이유는 같은 모델에 접근 경로가 둘 이상 생기기 때문이다:
 * Grok을 xAI API 키로도 Cursor 구독으로도 부른다. 두 줄은 같은 모델에 대한 서로 다른 접근
 * 수단이고, 다른 것은 단가·자격증명·검증 가능성이다.
 *
 * **그렇다고 독립성 비교의 축이 바뀌는 것은 아니다.** 원칙 4의 비교는 여전히 `providerId`
 * 하나로 하고(`participantKey`가 아니다), `(providerId, modelId)`는 **동일 참가자를 두 번
 * 세지 않기 위한 동일성 키**다. 두 규칙은 **함께** 성립해야 한다 — 비교를 동일성 키로 하면
 * `openai/gpt-5`와 `openai/gpt-4.1`이 "서로 다른 키라서 독립"으로 읽힌다.
 */
export interface ModelPathKey {
  providerId: ProviderId;
  modelId: ModelId;
  transport: ModelTransport;
  cliVendor?: CliVendor;
}

/**
 * 구분자로 리터럴 NUL을 쓰지 않는다 — 소스에 박으면 grep·ripgrep이 그 파일을 **바이너리로
 * 분류해 결과에서 빼기** 때문에 파일을 찾는 사람에게는 없는 것과 같다(CLAUDE.md 함정 기록).
 * `\u0000` 이스케이프는 의미가 같고 소스는 ASCII로 남는다.
 */
const KEY_SEP = "\u0000";

/** 경로 키의 정규 문자열. 같은 경로면 같은 문자열이고, 다른 경로면 다르다. */
export function modelPathKey(entry: ModelPathKey): string {
  return [entry.providerId, entry.modelId, entry.transport, entry.cliVendor ?? ""].join(KEY_SEP);
}

/**
 * **동일 참가자 키** — `(providerId, modelId)`.
 *
 * 같은 모델에 경로가 둘이면 두 엔트리는 **한 참가자로 접힌다.** A를 xAI API의 Grok으로,
 * B를 Cursor의 Grok으로 두면 `transport`가 다르니 "다르다"로 읽힐 여지가 생기는데, 그건
 * **같은 모델에게 두 번 묻는 것**이다(21.7절).
 *
 * 이것은 **비교 키가 아니다.** 비교는 `providerId`로 한다.
 */
export function participantKey(entry: { providerId: ProviderId; modelId: ModelId }): string {
  return [entry.providerId, entry.modelId].join(KEY_SEP);
}

/**
 * 레지스트리의 한 줄 — **모델이 아니라 경로**다(`ModelPathKey`).
 *
 * 같은 `(providerId, modelId)`가 `transport`만 달리해 두 줄로 있을 수 있고, 그때 다른 것은
 * 단가·자격증명·검증 가능성이다(multi-engine-routing 21.7절).
 */
export interface ModelEntry {
  modelId: ModelId;
  providerId: ProviderId;
  protocol: WireProtocol;
  /** 경로 키의 일부(21.4절). `http`면 `apiBaseUrl`이 있고 `cli`면 `cliVendor`가 있다. */
  transport: ModelTransport;
  /** `transport: "cli"`일 때만. 어느 CLI를 지나는가 — `providerId`가 아니다. */
  cliVendor?: CliVendor;
  /**
   * `transport: "http"`일 때만 있다.
   *
   * **`""`로 채우지 않는다**(21.4절) — 빈 문자열은 `providerKindOf`의 `local://` 판정과
   * 21.5절 호스트 검사 양쪽에서 "URL이 있는데 아무것도 아니다"로 읽힌다. 없는 것은 없는
   * 모양이어야 한다.
   */
  apiBaseUrl?: string;
  /** 이 공급자의 키를 담는 환경변수 이름. 값이 아니라 이름만 레지스트리에 둔다. */
  apiKeyEnvName: string;
  capabilities: ModelCapabilities;
  economics: ModelEconomics;
  availability: ModelAvailability;
  /** 능력 등급 — 측정으로만 붙는다. 초기값은 `unmeasured`(21.4절). */
  grade: ModelGrade;
  /**
   * 이 경로의 `grade`가 **다른 경로에서 물려받은 것**이면 그 경로의 키.
   *
   * CLI 경로는 등급을 자기 힘으로 잴 수 없다(21.7절: 응답 envelope이 없어 "응답자가 그
   * 모델"이라는 보장이 없다). 그래서 등급은 HTTP 경로에서 재고 CLI 경로는 같은
   * `(providerId, modelId)`의 등급을 물려받는데, **물려받은 등급은 가정 위에 선다** —
   * 중개자가 실제로 그 모델로 라우팅할 때만 맞는 숫자다.
   *
   * 다르면 우리는 알 수 없고, **알 수 없다는 사실이 화면에 있어야 한다.** 그 사실을 실을
   * 필드가 이것이고, 적어두지 않으면 나중에 CLI 실행 기록이 측정에 섞인다.
   */
  gradeInheritedFrom?: string;
  /** 비용 출처. `transport`의 파생값이 **아니다**(21.4절). */
  accounting: ModelAccounting;
  /**
   * 우리가 고른 접속점 — 값은 `"international"` 하나뿐이다(21.5절).
   *
   * **필수 필드가 아니다.** 축을 갖지 않는 엔트리가 둘 있고 이유가 서로 다르다:
   * `transport: "cli"`는 **접속점을 우리가 고르지 못해서**(그 CLI가 정한다), `local://fake`는
   * **네트워크로 나가지 않아서**다. 둘 다 `"international"`을 달면 그 값이 "확인된 국제
   * 엔드포인트"를 뜻하지 않게 된다 — 한쪽은 확인할 것이 없어서, 다른 쪽은 확인하지 못해서인데
   * **결과는 같다: 값이 뜻을 잃는다.**
   *
   * 타입이 가르는 것은 `cli` 쪽 절반뿐이다. `local://fake`는 `transport`가 `http`이고 fake를
   * 가리는 것은 주소 스킴이라 런타임 값이므로, 나머지 절반은 소스 검사가 맡는다(21.5절 ②).
   */
  endpointRegion?: "international";
  /**
   * 경로상의 관할 **목록** — 우리가 못 고르는 사실이고 표시만 한다(21.5절).
   *
   * HTTP 경로는 원소 하나, CLI 경로는 `[중개자, 공급자]`다(21.7절: 중개자는 관할을 하나 더
   * 만든다). **마지막 한 칸만 적으면 코드가 지나간 곳이 실제보다 짧아 보인다.**
   * `local://fake`에는 없다 — 네트워크로 나가지 않으므로 관할이 없다.
   */
  providerJurisdiction?: string[];
  /** 이 모델이 `EffortLevel`을 어느 파라미터로 받는가. 확인 전에는 `{ kind: "none" }`. */
  effort: EffortSupport;
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
  /**
   * 켜진 자리들. `simple`이면 `["executor"]` 하나뿐이다.
   *
   * **드롭은 이 배열에서 빠지는 것으로 표현된다.** 어느 자리가 왜 빠졌는지는
   * `planReviewIndependence`/`resultReviewIndependence`와 `appliedPolicies`가 말한다.
   */
  activeRoles: EngineRole[];
  assignments: RoleAssignment[];
  appliedPolicies: string[]; // forceComplexityTier, reviewer 드롭 사유 등 override 흔적
  /**
   * 5절 불변식: executor와 reviewer가 모두 활성이면 두 역할의 providerId가 달라야 한다.
   * 서로 다른 공급자를 찾지 못해 reviewer를 드롭했으면 false이며, UI가 이 값을 보고
   * "교차검증 없이 진행됨"을 표시한다. 조용히 같은 공급자로 검증한 척하지 않는다.
   *
   * **지우지 않는다**(21.6절). 과거 기록이 이 값을 쓰고 있고, `simple` 경로와 72절 이전
   * 태스크에 대해서는 지금도 정확하다. 72절 흐름의 검토자 둘은 아래 두 필드가 말한다 —
   * 검토자가 둘이 되면 `boolean` 하나로는 **어느 쪽이 빠졌는지 표현할 수 없기** 때문이다.
   */
  reviewerIndependent: boolean;
  /**
   * B(계획 검토) 자리가 어떻게 채워졌는가 — 21.6절.
   *
   * `shares_provider`는 **B = A′**인 경우다: 대조가 켜지면 계획이 둘이고 살아남지 않은
   * 쪽의 계획자를 B로 쓰면 자기 계획을 자기가 검토하는 일은 생기지 않는다. 그래도
   * 완전 독립은 아니다 — 같은 스냅샷을 같은 시점에 본 당사자이기 때문이다.
   */
  planReviewIndependence: ReviewerIndependence;
  /**
   * C(결과 검토) 자리가 어떻게 채워졌는가 — 21.6절.
   *
   * `shares_provider`는 **C = B**인 경우다. 그것이 유일한 허용 예외이며, 이유는 **B가
   * 코드를 쓰지 않았기 때문**이다 — 자기 산출물을 자기가 승인하는 경우가 아니다.
   */
  resultReviewIndependence: ReviewerIndependence;
  /**
   * 라우터가 **잠정 배정한** 계획 검토자와 오케스트레이터가 **확정한** 계획 검토자.
   *
   * 둘 다 남기는 이유는 13.5절이 검수자에 대해 정한 것과 같다: 실제 B는 "살아남은 계획의
   * 저자가 아닌 쪽"이라 계획 단계가 끝나야 정해지는데, **잠정 배정만 남기면 기록이
   * 실제로 누가 검토했는지를 말하지 못하고**, 확정만 남기면 라우터의 판단을 검증할 수 없다.
   */
  assignedPlanReviewer?: RoleAssignment | null;
  actualPlanReviewer?: RoleAssignment | null;
  assignedResultReviewer?: RoleAssignment | null;
  actualResultReviewer?: RoleAssignment | null;
  /**
   * **계량 과금분만의** 예상 금액 — state-machine 72.4절.
   *
   * 대표 토큰 수(8k/2k)로 계산한 값이며 UI에 "예상"으로 표시되고 실측 usage가 도착하면
   * 대체된다. **추정값을 실측처럼 보여주지 않는 것이 중요하다.**
   *
   * **`accounting: "subscription"`인 배정은 여기 들어가지 않는다.** 그 경로에는 토큰 단가가
   * 없으므로 0으로 합산하면 카드가 "이만큼만 듭니다"라고 거짓을 말한다. 환산되지 않은
   * 배정은 `unpricedAssignments`가 따로 적는다 — 하나로 합치면 둘 중 어느 것도 정확히
   * 말하지 못한다.
   */
  estimatedCostUsd: number;
  /**
   * 금액으로 환산되지 않은 배정 — 사람이 읽는 사유 문자열.
   *
   * 구독에 포함된 경로이거나 단가를 모르는 모델이다. 비어 있으면 `estimatedCostUsd`가
   * 전부를 말한다. 비어 있지 않으면 **카드가 둘을 나눠 적어야 한다**(72.4절: "금액과
   * '구독에 포함되어 금액으로 환산되지 않음'을 나눠 적는다").
   */
  unpricedAssignments: string[];
  decidedAt: ISODateTime;
}
