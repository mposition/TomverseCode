import type { ComplexityTier, EngineRole, ModelEntry, RoleAssignment, RoutingDecision } from "@tomverse/protocol";
import type { ModelRegistry } from "./registry.js";

/**
 * v1 라우터 — docs/design/multi-engine-routing.md 4절, 8절.
 *
 * 8절 결정: **결정은 지금 정적으로, 기록은 지금부터 전부.** 평가 데이터가 없으므로
 * "지능형" 점수 계산을 넣지 않는다(그건 추측이 담긴 설정 파일일 뿐이다). 대신 모든
 * `RoutingDecision`을 이벤트 로그에 남겨 나중에 데이터 기반으로 전환할 근거를 쌓는다.
 */

export interface RouterOptions {
  /** 역할별 선호 모델 override (환경변수/설정에서 온다). 모델 ID를 코드에 고정하지 않기 위한 축. */
  preferred?: Partial<Record<EngineRole, string>>;
  /** 조직 인증이 필요한 모델도 후보에 넣을지 (사용자가 인증됐다고 알린 경우) */
  allowOrgVerified?: boolean;
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
    });

    if (candidates.length === 0) {
      throw new RoutingError(
        input.availableProviders.length === 0
          ? "사용 가능한 공급자가 없습니다. API 키를 설정하세요."
          : `자격증명이 있는 공급자(${input.availableProviders.join(", ")})에 사용 가능한 모델이 없습니다.`
      );
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
      const independent = candidates.filter((c) => !executorProviders.has(c.providerId));

      if (independent.length > 0) {
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

    const estimatedCostUsd = assignments.reduce((sum, a) => {
      // 실제 토큰 수를 모르므로 대표값으로 추정한다. UI에 "예상"으로 표시되며 실측 usage가
      // 도착하면 대체된다 — 추정값을 실측처럼 보여주지 않는 것이 중요하다.
      const estimate = this.registry.costUsd(a.modelId, { inputTokens: 8_000, outputTokens: 2_000 });
      return sum + (estimate ?? 0);
    }, 0);

    return {
      taskId: input.taskId,
      complexityTier: input.complexityTier,
      activeRoles,
      assignments,
      appliedPolicies,
      reviewerIndependent,
      estimatedCostUsd,
      decidedAt: new Date().toISOString(),
    };
  }

  private pick(role: EngineRole, candidates: ModelEntry[]): RoleAssignment {
    const pool = candidates;
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
      return a.economics.outputPerMTok - b.economics.outputPerMTok;
    });

    const chosen = sorted[0];
    if (!chosen) throw new RoutingError(`${role} 역할에 배정할 모델이 없습니다.`);

    const reason = preferredId
      ? `설정의 ${preferredId}를 쓸 수 없어(자격증명 없음 또는 조직 인증 필요) ${chosen.modelId}로 대체함`
      : `정적 우선순위(구조화 출력 > 컨텍스트 크기 > 비용)로 ${chosen.modelId} 선택`;

    return { role, modelId: chosen.modelId, providerId: chosen.providerId, reason };
  }
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
