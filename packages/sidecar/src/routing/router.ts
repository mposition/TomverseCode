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
      // ---- 5절 검수자 독립성 불변식 ----
      //
      //   activeRoles가 executor와 reviewer를 모두 포함하면
      //   assignment(executor).providerId ≠ assignment(reviewer).providerId
      //
      // 이건 설정이 아니라 코드로 강제한다. 같은 공급자로 "검증한 척"하는 것보다
      // 검증하지 않았음을 드러내는 편이 안전하다.
      const independent = candidates.filter((c) => c.providerId !== executor.providerId);
      if (independent.length > 0) {
        const reviewer = this.pick("reviewer", independent);
        assignments.push(reviewer);
        activeRoles.push("reviewer");
        reviewerIndependent = true;
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
    const preferredId = this.options.preferred?.[role];
    if (preferredId) {
      const match = candidates.find((c) => c.modelId === preferredId);
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
    const sorted = [...candidates].sort((a, b) => {
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
