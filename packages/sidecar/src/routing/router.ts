import type {
  CliVendor,
  ComplexityTier,
  EngineRole,
  ModelEntry,
  RoleAssignment,
  RoutingDecision,
} from "@tomverse/protocol";
import { participantKey } from "@tomverse/protocol";
import type { ModelRegistry } from "./registry.js";

/**
 * v1 라우터 — docs/design/multi-engine-routing.md 4절, 8절.
 *
 * 8절 결정: **결정은 지금 정적으로, 기록은 지금부터 전부.** 평가 데이터가 없으므로
 * "지능형" 점수 계산을 넣지 않는다(그건 추측이 담긴 설정 파일일 뿐이다). 대신 모든
 * `RoutingDecision`을 이벤트 로그에 남겨 나중에 데이터 기반으로 전환할 근거를 쌓는다.
 */

export interface RouterOptions {
  /**
   * 역할별 **선호** 모델 (환경변수/설정에서 온다). 모델 ID를 코드에 고정하지 않기 위한 축.
   *
   * 쓸 수 없으면 조용히 다른 걸 쓰고 사유를 `reason`에 남긴다 — 기본값에는 그게 맞다.
   */
  preferred?: Partial<Record<EngineRole, string>>;
  /**
   * 역할별 **지정** 모델 (사용자가 이번 태스크에 대해 고른 값, 15절).
   *
   * `preferred`와 달리 **대체하지 않는다.** 쓸 수 없으면 `RoutingError`로 멈춘다 —
   * 대체하면 사용자는 자기가 고르지 않은 모델에 자기 돈이 나간 것을 나중에 안다.
   */
  pinned?: {
    planner?: string;
    executor?: string;
    reviewer?: string;
    planReviewer?: string;
    resultReviewer?: string;
  };
  /** 조직 인증이 필요한 모델도 후보에 넣을지 (사용자가 인증됐다고 알린 경우) */
  allowOrgVerified?: boolean;
  /**
   * 사용자가 **켠** CLI들 — state-machine 72.10.1절의 옵트인 단서.
   *
   * 기본값이 비어 있는 것이 핵심이다. 열어 두면 동점이 생기는 순간 라우터가 21.7절이
   * "기본 경로가 아니다"라고 못박은 경로를 사용자에게 묻지 않고 고른다. 그리고 그 경로가
   * 뽑힐수록 승인 카드의 금액이 "환산 불가" 쪽으로 넘어가는데, *"사용자가 비용을 보고
   * 승인한다"*가 13.0.2 뒤집기의 근거이므로 옵트인이 아니면 그 근거가 옅어진다.
   */
  enabledCliVendors?: readonly CliVendor[];
}

/**
 * 지정한 모델을 쓸 수 없는 이유를 **구별해서** 말한다.
 *
 * "쓸 수 없습니다"만 말하면 사용자는 무엇을 고쳐야 하는지 모른다 — 키를 넣어야 하는지,
 * 조직 인증을 받아야 하는지, 오타인지가 전부 다른 행동이다. gpt-5 사례가 정확히 이것이었다:
 * 모델 가용성은 전역 사실이 아니라 **자격증명별 사실**이다.
 */
function pinFailureReason(registry: ModelRegistry, modelId: string, availableProviders: readonly string[]): string {
  const known = registry.get(modelId);
  if (!known) {
    return `${modelId}는 모델 목록에 없습니다 (오타이거나 지원하지 않는 모델입니다)`;
  }
  if (!availableProviders.includes(known.providerId)) {
    return `${modelId}를 쓰려면 ${known.providerId}의 API 키가 필요한데 설정되어 있지 않습니다`;
  }
  if (known.availability.requiresOrgVerification) {
    return `${modelId}는 ${known.providerId} 조직 인증이 필요합니다 — 인증 전에는 호출이 실패합니다`;
  }
  if (known.availability.deprecatedAfter) {
    return `${modelId}는 ${known.availability.deprecatedAfter} 이후 지원되지 않습니다`;
  }
  return `${modelId}를 후보에서 찾을 수 없습니다`;
}

/** 대조를 드롭한 사유 — `appliedPolicies`에 남고 UI가 그대로 보여준다. */
const CONTRAST_DROPPED_NO_INDEPENDENT =
  "contrast_dropped:no_independent_provider — 같은 공급자로 두 번 부르지 않고 대조를 드롭했습니다. " +
  "같은 모델을 두 번 부른 \"불일치 없음\"은 정보가 아니라 착시입니다.";

/**
 * 공급자가 둘뿐이라 검수자가 대조 참가자 중 하나와 같은 공급자가 되는 경우 (13.3절).
 *
 * 이 문자열이 남았다는 것은 "검수자가 완전히 독립적이지 않다"는 뜻이고, 그럼에도 진행한 이유는
 * **대조가 검수보다 우선**하기 때문이다 — 대조는 사용자 판정을 위한 질문을 만들고 검수는 모델
 * 의견을 하나 더 얻는데, 사용자가 상위 권위이므로 포기할 것은 모델 의견 쪽이다.
 */
const REVIEWER_SHARES_PROVIDER =
  "reviewer_shares_provider_with_contrast_participant — 공급자가 둘뿐이라 검수자가 대조 참가자와 " +
  "같은 공급자입니다. 살아남은 초안의 저자가 아닌 쪽을 검수자로 쓰므로 \"자기 산출물 자기 승인\"은 " +
  "피하지만, 완전한 공급자 독립은 아닙니다.";

export class Router {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly options: RouterOptions = {}
  ) {}

  /**
   * 역할 배정. `simple`이면 executor 하나, `standard`면 executor + reviewer.
   *
   * `planner`는 정의만 존재하고 켜지 않는다 (4절) — 표준 태스크당 LLM 호출이 3회가 되는데
   * 스파이크가 이미 "쉬운 태스크엔 2회도 과하다"고 판정한 방향의 반대다.
   */
  decide(input: {
    taskId: string;
    complexityTier: ComplexityTier;
    availableProviders: readonly string[];
    appliedPolicies?: string[];
    /**
     * 대조용 두 번째 executor를 배정할지 (multi-engine-routing.md 13절).
     *
     * **라우터가 스스로 정하지 않고 호출자가 넘긴다.** 켜면 LLM 호출이 3회가 되므로(13.4절)
     * 이건 비용에 관한 결정이고, 그 결정의 근거(tier, 실험 하네스 여부)는 라우터가 아니라
     * 오케스트레이터가 안다. 라우터는 배정 가능성만 판단한다.
     */
    contrast?: boolean;
  }): RoutingDecision {
    const appliedPolicies = [...(input.appliedPolicies ?? [])];
    const candidates = this.registry.available(input.availableProviders, {
      allowOrgVerified: this.options.allowOrgVerified,
      ...(this.options.enabledCliVendors ? { enabledCliVendors: this.options.enabledCliVendors } : {}),
    });

    if (candidates.length === 0) {
      throw new RoutingError(
        input.availableProviders.length === 0
          ? "사용 가능한 공급자가 없습니다. API 키를 설정하세요."
          : `자격증명이 있는 공급자(${input.availableProviders.join(", ")})에 사용 가능한 모델이 없습니다.`
      );
    }

    // **지정은 대체하지 않는다.** 쓸 수 없으면 여기서 멈추고 이유를 말한다 — 첫 유료 호출
    // 전이며, 사용자가 고르지 않은 모델에 돈이 나가지 않는다.
    // 지정한 자리를 **전부** 먼저 확인한다. 하나라도 빠뜨리면 그 자리만 배정 도중에
    // 실패하게 되고, 그때는 "무엇이 잘못됐나"에 답하기 위해 두 사실을 합쳐야 한다.
    for (const role of PINNABLE_ROLES) {
      this.assertPinAvailable(role, candidates, input.availableProviders);
    }

    const executor = this.pick("executor", candidates);
    const assignments: RoleAssignment[] = [executor];
    const activeRoles: EngineRole[] = ["executor"];
    let reviewerIndependent = false;

    if (input.complexityTier === "standard") {
      // ---- 13절 co-executor: 대조를 위한 두 번째 실행자 ----
      //
      //   불변식 2: executor 배정이 둘이면 executors[0].providerId ≠ executors[1].providerId
      //
      // 새 역할 이름을 만들지 않는다(13.1절) — 두 실행자가 하는 일이 완전히 같기 때문이다.
      // 역할이 다른 게 아니라 **표본이 둘**인 것이고, 이름을 나누면 프롬프트가 갈라질 여지가
      // 생겨 "모델 차이"와 "프롬프트 차이"가 섞인다.
      //
      // **순서가 의미를 갖는다.** 첫 번째가 primary이며, 하나만 필요한 단계(FIX_LOOP 등)와
      // 기존 `assignments.find(a => a.role === "executor")` 경로가 그대로 primary를 가리킨다.
      if (input.contrast) {
        // 공급자도 모델도 달라야 표본이 둘이다. 여기서 미리 걸러 두면, 뽑을 것이 없을 때
        // `pick`이 예외를 던져 **태스크가 죽는** 대신 대조만 드롭된다 — 대조는 질문을 만드는
        // 장치이지 진행 조건이 아니므로, 없다고 실패시키면 안 된다.
        const otherProvider = candidates.filter(
          (c) => c.providerId !== executor.providerId && c.modelId !== executor.modelId
        );
        if (otherProvider.length > 0) {
          assignments.push(this.pick("executor", otherProvider));
        } else {
          // 같은 공급자로 두 번 부르지 않는다 — 대조의 가치 전부가 두 표본의 독립성에서 온다.
          appliedPolicies.push(CONTRAST_DROPPED_NO_INDEPENDENT);
        }
      }

      // ---- 5절 검수자 독립성 불변식 ----
      //
      //   activeRoles가 executor와 reviewer를 모두 포함하면
      //   assignment(executor).providerId ≠ assignment(reviewer).providerId
      //
      // 이건 설정이 아니라 코드로 강제한다. 같은 공급자로 "검증한 척"하는 것보다
      // 검증하지 않았음을 드러내는 편이 안전하다.
      const executorProviders = new Set(
        assignments.filter((a) => a.role === "executor").map((a) => a.providerId)
      );
      /**
       * **비교 축은 `providerId` 하나다**(21.4절) — 그게 원칙 4가 재는 축이다.
       *
       * 21.4절이 "검수 자리에는 동일성 접기가 아직 없다"고 적어둔 자리가 여기인데, **이
       * 자리에서는 공급자 비교가 동일성 접기를 이미 포함한다**: 같은 참가자
       * (`(providerId, modelId)`)는 정의상 같은 `providerId`이므로 이 필터가 먼저 뺀다.
       *
       * 그래서 참가자 필터를 한 줄 더 얹지 않는다 — 얹으면 **어떤 테스트로도 실패시킬 수
       * 없는 코드**가 되고, 이 저장소는 "빠진 테스트는 실패하지 않으므로 빠진 사실이 드러나지
       * 않는다"를 이미 겪었다. 대신 **두 규칙이 함께 성립하는지를 검사가 확인한다**:
       * 비교가 `providerId`로 이루어지는가(이 필터)와 CLI 엔트리가 독립된 `providerId`를
       * 갖지 않는가(`registryAxes.test.ts`). 뒤가 깨지면 앞의 포함 관계가 무너진다.
       *
       * 동일성 접기가 **실제로 필요한 자리**는 후보 정렬이다 — 같은 참가자의 두 경로가
       * 후보에 함께 들면 "후보가 둘"로 보이는데 물어볼 모델은 하나다(`pick` 참조).
       */
      const independent = candidates.filter((c) => !executorProviders.has(c.providerId));

      // 사용자가 지정한 검수자가 **독립적이지 않은** 경우가 있다(실행자와 같은 공급자).
      // 이때 다른 모델로 바꿔 배정하면 "지정은 대체하지 않는다"가 깨지고, 그대로 쓰면
      // 원칙 4("같은 공급자로 검증한 척하지 않는다")가 깨진다. **원칙 4를 지킨다** —
      // 사용자 권위는 "무엇을 만들 것인가"에 대한 것이고, "우리가 무엇을 검증이라 부를
      // 것인가"는 우리가 파는 것이다(product-strategy 16절). 대신 드롭 사실을 표시한다.
      const reviewerPin = this.options.pinned?.reviewer;
      const pinnedReviewerIsIndependent = reviewerPin
        ? independent.some((c) => c.modelId === reviewerPin)
        : true;

      if (reviewerPin && !pinnedReviewerIsIndependent) {
        appliedPolicies.push(
          `reviewer_dropped:pinned_not_independent(${reviewerPin}) — 지정한 검수자가 실행자와 같은 ` +
            "공급자라 독립 검수가 성립하지 않습니다. 다른 모델로 바꾸지 않고 검수 역할을 드롭했습니다. " +
            "결정론적 검증(VERIFYING)은 그대로 수행됩니다."
        );
      } else if (independent.length > 0) {
        const reviewer = this.pick("reviewer", independent);
        assignments.push(reviewer);
        activeRoles.push("reviewer");
        reviewerIndependent = true;
      } else if (executorProviders.size >= 2) {
        // 13.3절: 공급자가 둘뿐이라 불변식 1과 2를 동시에 만족시킬 수 없다.
        // **대조가 검수보다 우선한다** — 대조는 사용자 판정을 위한 질문을 만들고 검수는 모델
        // 의견을 하나 더 얻는데, 권위의 계층상 포기할 것은 모델 의견 쪽이다(16.1절).
        //
        // 검수를 통째로 버리지는 않는다. 실제 검수자는 **살아남은 초안의 저자가 아닌 쪽**이며,
        // 그건 REVIEWING 시점에야 알 수 있으므로 여기서는 non-primary를 잠정 배정하고
        // 오케스트레이터가 확정한다. reviewerIndependent는 false로 남긴다 — 절충의 대가를
        // 숨기지 않는다.
        const provisional = assignments.filter((a) => a.role === "executor")[1]!;
        assignments.push({
          role: "reviewer",
          modelId: provisional.modelId,
          providerId: provisional.providerId,
          reason:
            "공급자가 둘뿐이라 대조 참가자 중 하나를 검수자로 재사용한다. " +
            "실제 검수자는 살아남은 초안의 저자가 아닌 쪽이며 REVIEWING 시점에 확정된다(13.3절).",
        });
        activeRoles.push("reviewer");
        appliedPolicies.push(REVIEWER_SHARES_PROVIDER);
      } else {
        // reviewer 역할을 드롭하고 사유를 기록한다. tier는 사실상 simple로 격하된다.
        appliedPolicies.push(
          `reviewer_dropped:no_independent_provider(executor=${executor.providerId}) — 교차검증 없이 진행됨. ` +
            "결정론적 검증(VERIFYING)은 그대로 수행된다."
        );
      }
    }

    // 실제 토큰 수를 모르므로 대표값으로 추정한다. UI에 "예상"으로 표시되며 실측 usage가
    // 도착하면 대체된다 — 추정값을 실측처럼 보여주지 않는 것이 중요하다.
    //
    // **합계가 하나가 아니다**(state-machine 72.4절). 환산되지 않는 배정을 0으로 더하면
    // 카드가 "이만큼만 듭니다"라고 거짓을 말한다 — 구독 용량에는 쿼터가 있고 소진되면
    // 어떻게 되는지 그 CLI가 정하지 우리가 모른다.
    let estimatedCostUsd = 0;
    const unpricedAssignments: string[] = [];
    for (const a of assignments) {
      const cost = this.registry.costOf(a.modelId, { inputTokens: 8_000, outputTokens: 2_000 });
      if (cost.kind === "usd") estimatedCostUsd += cost.usd;
      else unpricedAssignments.push(`${a.role}: ${cost.reason}`);
    }

    return {
      taskId: input.taskId,
      complexityTier: input.complexityTier,
      activeRoles,
      assignments,
      appliedPolicies,
      reviewerIndependent,
      /**
       * **72절 흐름은 아직 이 라우터를 지나지 않는다.**
       *
       * B·C 자리는 `standard` 경로가 72절 흐름으로 바뀔 때(오케스트레이터 단계) 배정된다.
       * 그 전까지 `not_applicable`인 것은 "독립적이지 않다"가 아니라 **"그 자리가 아직
       * 없다"**이고, 둘을 뭉개면 화면이 없는 검토를 드롭된 검토로 표시한다.
       */
      planReviewIndependence: "not_applicable",
      resultReviewIndependence: "not_applicable",
      estimatedCostUsd,
      unpricedAssignments,
      decidedAt: new Date().toISOString(),
    };
  }

  /**
   * 지정한 모델이 후보에 있는지 **배정을 시작하기 전에** 확인한다.
   *
   * 배정 도중에 확인하면 executor를 뽑은 뒤 reviewer 지정이 틀린 것을 알게 되고, 그때는
   * 이미 "무엇이 잘못됐나"에 답하기 위해 두 개의 사실을 합쳐야 한다.
   */
  private assertPinAvailable(
    role: PinnableRole,
    candidates: ModelEntry[],
    availableProviders: readonly string[]
  ): void {
    const pinned = this.options.pinned?.[role];
    if (!pinned) return;
    if (candidates.some((c) => c.modelId === pinned)) return;
    throw new RoutingError(
      `${role} 역할로 지정한 ${pinFailureReason(this.registry, pinned, availableProviders)}. ` +
        "지정한 모델은 다른 모델로 대체하지 않습니다 — 고르지 않은 모델에 비용이 나가지 않도록 여기서 멈춥니다."
    );
  }

  private pick(role: EngineRole, candidates: ModelEntry[]): RoleAssignment {
    const pool = candidates;
    const pinnedId = isPinnableRole(role) ? this.options.pinned?.[role] : undefined;
    if (pinnedId) {
      const match = pool.find((c) => c.modelId === pinnedId);
      if (match) {
        return {
          role,
          modelId: match.modelId,
          providerId: match.providerId,
          reason: `사용자가 이 태스크의 ${role} 역할로 ${pinnedId}를 지정함`,
        };
      }
      // 여기 오는 것은 **불변식이 후보를 좁힌 경우**다(예: 검수자 독립성 때문에 executor의
      // 공급자가 빠진 뒤). 지정 자체는 `assertPinAvailable`이 이미 확인했으므로, 이 자리에서
      // 대체하지 않고 호출자가 역할을 드롭하도록 둔다 — 아래 주석 참조.
    }
    const preferredId = this.options.preferred?.[role];
    if (preferredId) {
      const match = pool.find((c) => c.modelId === preferredId);
      if (match) {
        return {
          role,
          modelId: match.modelId,
          providerId: match.providerId,
          reason: `설정에서 ${role} 역할에 ${preferredId}를 지정함`,
        };
      }
      // 지정한 모델을 쓸 수 없으면 조용히 다른 걸 쓰지 않고 그 사실을 reason에 남긴다.
    }

    // 정적 우선순위: 구조화 출력을 강하게 지원하는 것 → 컨텍스트가 큰 것 → 저렴한 것.
    // 근거 데이터가 없으므로 "능력 필터 + 결정론적 정렬"까지만 한다(8절).
    const sorted = [...pool].sort((a, b) => {
      const structured = structuredOutputRank(b) - structuredOutputRank(a);
      if (structured !== 0) return structured;
      const context = b.capabilities.maxContextTokens - a.capabilities.maxContextTokens;
      if (context !== 0) return context;
      const price = a.economics.outputPerMTok - b.economics.outputPerMTok;
      if (price !== 0) return price;
      // **여기서부터가 경로를 고르는 자리다.** 위까지는 전부 참가자의 성질이라 같은 참가자의
      // 두 경로는 전부 동점이 된다 — 그 동점을 72.10.1절 규칙이 가른다: 같은 등급 안에서
      // 포함된 용량이 계량 과금보다 앞선다. 옵트인 단서는 `available()`이 이미 걸었으므로
      // 여기 후보에 남은 CLI는 사용자가 켠 것뿐이다.
      //
      // **순서를 뒤집지 않는 것이 핵심이다.** 뒤집으면 "포함되어 있다"가 "쓸 만하다"로
      // 번지고, 그건 가격에 대한 사실을 품질에 대한 사실로 읽는 것이다.
      return accountingRank(b) - accountingRank(a);
    });

    /**
     * **같은 참가자의 두 경로는 한 후보다**(21.4절 동일성 키).
     *
     * 접지 않으면 `(anthropic, claude-sonnet-5)`의 HTTP 경로와 CLI 경로가 후보 둘로 보인다 —
     * 물어볼 모델은 하나인데 후보 수를 세는 자리가 둘로 읽는다. 위 정렬이 이미 경로를
     * 갈라 놓았으므로, 참가자별로 **첫 경로만** 남기면 그게 그 참가자의 대표 경로다.
     */
    const seen = new Set<string>();
    const folded = sorted.filter((c) => {
      const key = participantKey(c);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const chosen = folded[0];
    if (!chosen) throw new RoutingError(`${role} 역할에 배정할 모델이 없습니다.`);

    const reason = preferredId
      ? `설정의 ${preferredId}를 쓸 수 없어(자격증명 없음 또는 조직 인증 필요) ${chosen.modelId}로 대체함`
      : `정적 우선순위(구조화 출력 > 컨텍스트 크기 > 비용)로 ${chosen.modelId} 선택`;

    return { role, modelId: chosen.modelId, providerId: chosen.providerId, reason };
  }
}

/**
 * 비용 출처의 동점 규칙 — state-machine 72.10.1절. 높을수록 먼저 고른다.
 *
 * **등급을 바꾸지 않는다.** 1순위는 `PerformanceProfile`이 clamp한 등급이고 이 축은 그
 * 안에서만 작동한다. 단서(`transport: "cli"`는 켠 경우에만 후보)는 `available()`이 건다 —
 * 막으려는 것은 "구독"이 아니라 **약관 리스크를 사용자에게 지우는 경로**이기 때문이다.
 */
function accountingRank(entry: ModelEntry): number {
  return entry.accounting === "subscription" ? 1 : 0;
}

function structuredOutputRank(entry: ModelEntry): number {
  switch (entry.capabilities.structuredOutput) {
    case "strict_schema":
    case "forced_tool_use":
      return 3;
    case "response_schema":
      return 2;
    case "json_mode":
      return 1;
    case "none":
      return 0;
  }
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * 사용자가 **지정할 수 있는** 자리. co-planner(대조용 두 번째 계획자)는 여기 없다 —
 * 고르게 하면 primary와 같게 만들 수 있고, 그 순간 "불일치 없음"이 착시가 된다(15.3절).
 */
const PINNABLE_ROLES = ["planner", "executor", "reviewer", "planReviewer", "resultReviewer"] as const;
type PinnableRole = (typeof PINNABLE_ROLES)[number];

function isPinnableRole(role: EngineRole): role is PinnableRole {
  return (PINNABLE_ROLES as readonly string[]).includes(role);
}

/** 환경변수에서 역할별 모델 override를 읽는다. 모델 ID를 코드에 고정하지 않기 위한 통로. */
export function routerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RouterOptions {
  const preferred: Partial<Record<EngineRole, string>> = {};
  if (env.TOMVERSE_EXECUTOR_MODEL) preferred.executor = env.TOMVERSE_EXECUTOR_MODEL;
  if (env.TOMVERSE_REVIEWER_MODEL) preferred.reviewer = env.TOMVERSE_REVIEWER_MODEL;
  return {
    preferred,
    allowOrgVerified: env.TOMVERSE_ALLOW_ORG_VERIFIED === "1",
  };
}
