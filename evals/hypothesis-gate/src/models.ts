import { BUILTIN_MODELS } from "@tomverse/sidecar/registry";
import {
  maxCallCostUsd,
  pricingIsUsable,
  effectiveMaxOutputTokens,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
} from "@tomverse/sidecar/budget";
import type { ModelEntry } from "@tomverse/protocol";
import type { ArmId } from "./types.js";

/**
 * 모델 가용성·가격 검증 (§6).
 *
 * # 왜 레지스트리를 그대로 믿지 않는가
 *
 * 모델 ID와 가격은 시간에 따라 바뀐다. 레지스트리의 값은 **특정 시점의 스냅샷**이고,
 * 그 시점이 언제인지 없이는 "비용이 상한의 2배 이하"라는 판정을 재현할 수 없다.
 * 그래서 여기서는 (a) 스냅샷이 실제로 존재하고 쓸 수 있는 상태인지 확인하고,
 * (b) 확인한 사실을 run metadata에 **고정**해 실험 도중 바뀌지 않게 한다.
 *
 * # 왜 실제 네트워크를 부르지 않는가
 *
 * 이 모듈은 `npm test`에서 돌고, 테스트가 유료 API를 부르면 안 된다. 그래서 실제 확인은
 * 주입 가능한 `CapabilityChecker`로 분리했고, 기본 구현은 **레지스트리만 보는 오프라인 검사**다.
 * 네트워크 확인은 별도 명령(`verify-models`)에서만, 사용자가 명시적으로 요청할 때 돈다.
 *
 * # 조용한 대체 금지
 *
 * 모델을 쓸 수 없으면 다른 모델로 바꾸지 않는다. arm 중간에 모델이 바뀌면 A/C/D가 같은
 * 초안을 공유한다는 전제가 깨지고, 비교 자체가 성립하지 않는다. 쓸 수 없으면 BLOCKED다.
 */

export interface ModelFacts {
  modelId: string;
  providerId: string;
  inputPerMTok: number;
  outputPerMTok: number;
  pricingAsOf: string;
  maxContextTokens: number;
  /** 모델이 허용하는 최대 출력 토큰. */
  modelMaxOutputTokens: number;
  /** **어댑터가 실제로 요청하는** 출력 토큰. 비용을 지배하는 값이다. */
  requestedMaxOutputTokens: number;
  structuredOutput: string;
  toolCalling: string;
  requiresOrgVerification: boolean;
}

export type ProbeSource = "registry" | "network";

export interface ModelProbe {
  modelId: string;
  /** 이 자격증명으로 실제 호출 가능한가. `unknown`이면 확인되지 않았다는 뜻이다. */
  available: "yes" | "no" | "unknown";
  /** 구조화 출력/tool-use가 이 실험에 충분한가. */
  structuredOutputOk: "yes" | "no" | "unknown";
  source: ProbeSource;
  detail?: string;
}

export interface CapabilityChecker {
  probe(entry: ModelEntry): ModelProbe;
}

/**
 * 기본 검사기 — **네트워크를 부르지 않는다.**
 *
 * 레지스트리가 아는 것만 판정한다. `requiresOrgVerification`이 켜진 모델은
 * "확인되지 않음"으로 두고 통과시키지 않는다 — gpt-5 사건의 교훈이다.
 * 실제 호출 가능 여부는 자격증명별 사실이므로 오프라인에서 `yes`라고 말할 수 없다.
 */
export const offlineChecker: CapabilityChecker = {
  probe(entry) {
    const structuredOk =
      entry.capabilities.structuredOutput === "strict_schema" ||
      entry.capabilities.structuredOutput === "forced_tool_use";
    if (entry.availability.requiresOrgVerification) {
      return {
        modelId: entry.modelId,
        available: "unknown",
        structuredOutputOk: structuredOk ? "yes" : "no",
        source: "registry",
        detail: "조직 인증(Organization Verification)이 필요한 모델입니다 — 이 자격증명으로 쓸 수 있는지 확인되지 않았습니다",
      };
    }
    return {
      modelId: entry.modelId,
      // 레지스트리만으로는 "실제로 호출된다"를 말할 수 없다. 이 실험에서 요구하는 것은
      // "쓸 수 없다고 알려진 이유가 없다"이므로 yes로 두되, source가 registry임을 남긴다.
      available: "yes",
      structuredOutputOk: structuredOk ? "yes" : "no",
      source: "registry",
    };
  },
};

export function factsOf(entry: ModelEntry): ModelFacts {
  return {
    modelId: entry.modelId,
    providerId: entry.providerId,
    inputPerMTok: entry.economics.inputPerMTok,
    outputPerMTok: entry.economics.outputPerMTok,
    pricingAsOf: entry.economics.pricingAsOf,
    maxContextTokens: entry.capabilities.maxContextTokens,
    modelMaxOutputTokens: entry.capabilities.maxOutputTokens,
    requestedMaxOutputTokens: effectiveMaxOutputTokens(entry),
    structuredOutput: entry.capabilities.structuredOutput,
    toolCalling: entry.capabilities.toolCalling,
    requiresOrgVerification: entry.availability.requiresOrgVerification,
  };
}

export function lookupModel(modelId: string, entries: readonly ModelEntry[] = BUILTIN_MODELS): ModelEntry | undefined {
  return entries.find((e) => e.modelId === modelId);
}

/**
 * arm이 실제로 쓸 모델을 고른다.
 *
 * override가 없으면 각 공급자에서 **조직 인증이 필요 없는 가장 싼 모델**을 고른다 —
 * 스스로 비싼 모델을 고르지 않는 것이 사용자 돈에 대한 기본 태도이고, 어떤 모델이 선택됐는지는
 * Run Card에 그대로 나간다.
 */
export function selectModel(
  providerId: string,
  override: string | undefined,
  entries: readonly ModelEntry[] = BUILTIN_MODELS
): { ok: true; entry: ModelEntry } | { ok: false; reason: string } {
  if (override !== undefined) {
    const entry = lookupModel(override, entries);
    if (!entry) return { ok: false, reason: `모델 ${override}가 Model Registry에 없습니다` };
    if (entry.providerId !== providerId) {
      return {
        ok: false,
        reason: `모델 ${override}는 ${entry.providerId} 소속인데 ${providerId} 자리에 지정되었습니다`,
      };
    }
    return { ok: true, entry };
  }
  const candidates = entries
    .filter((e) => e.providerId === providerId && !e.availability.requiresOrgVerification)
    .sort((a, b) => a.economics.outputPerMTok - b.economics.outputPerMTok);
  const chosen = candidates[0];
  if (!chosen) {
    return { ok: false, reason: `${providerId}에 조직 인증 없이 쓸 수 있는 모델이 없습니다` };
  }
  return { ok: true, entry: chosen };
}

// ---------------------------------------------------------------------------
// 호출 수 상한 — 비용 예약의 근거
// ---------------------------------------------------------------------------

/**
 * 한 기록(fixture × arm × 반복)에서 가능한 **최대** provider 호출 수.
 *
 * 제품의 루프 상한(CLAUDE.md 원칙 5)에서 유도한다:
 *  - executor: 초안 1 + `fixLoopRounds` 3 = 4
 *  - reviewer: 검수 1 + `reviseRounds` 2 = 3
 *
 * Arm C/D는 초안을 재생하므로 executor의 초안 호출이 없지만, **보수적으로 빼지 않는다** —
 * 예약은 넘치는 쪽으로 틀려야 안전하다.
 */
export const MAX_EXECUTOR_CALLS_PER_RECORD = 4;
export const MAX_REVIEWER_CALLS_PER_RECORD = 3;

export function maxCallsPerRecord(arm: ArmId, providerCount: number): { executor: number; reviewer: number } {
  return {
    executor: MAX_EXECUTOR_CALLS_PER_RECORD,
    reviewer: providerCount > 1 ? MAX_REVIEWER_CALLS_PER_RECORD : 0,
  };
}

export interface RecordCostEstimate {
  maxUsd: number;
  basis: string;
  executorCalls: number;
  reviewerCalls: number;
}

/**
 * 한 기록의 보수적 최대 비용.
 *
 * **입력**은 컨텍스트 엔진의 토큰 예산으로, **출력**은 어댑터가 provider에 실제로 넘기는
 * `maxOutputTokens`로 잡는다. 후자가 비용을 지배한다 — 어댑터가 모델의 최대 출력 토큰을
 * 그대로 요청하기 때문이다(`providers/openai.ts`의 `max_output_tokens`).
 *
 * 가격을 알 수 없으면 `undefined`를 돌려준다. 0으로 대체하지 않는다.
 */
export function estimateRecordCost(
  executor: ModelEntry,
  reviewer: ModelEntry | undefined,
  calls: { executor: number; reviewer: number },
  contextTokenBudget = DEFAULT_CONTEXT_TOKEN_BUDGET
): RecordCostEstimate | undefined {
  // **어댑터가 실제로 요청하는 값**을 쓴다. 모델 최대치를 쓰면 예약이 실제 청구보다 크게
  // 부풀고, 그러면 승인 상한이 감당 못 하는 것처럼 보여 실행을 막는다.
  const perExecutor = maxCallCostUsd(executor, {
    maxInputTokens: contextTokenBudget,
    maxOutputTokens: effectiveMaxOutputTokens(executor),
  });
  if (perExecutor === undefined) return undefined;

  let total = perExecutor * calls.executor;
  let reviewerPart = "";
  if (calls.reviewer > 0) {
    if (!reviewer) return undefined;
    const perReviewer = maxCallCostUsd(reviewer, {
      maxInputTokens: contextTokenBudget,
      maxOutputTokens: effectiveMaxOutputTokens(reviewer),
    });
    if (perReviewer === undefined) return undefined;
    total += perReviewer * calls.reviewer;
    reviewerPart = ` + ${reviewer.modelId} ${calls.reviewer}회×$${perReviewer.toFixed(4)}`;
  }

  return {
    maxUsd: total,
    executorCalls: calls.executor,
    reviewerCalls: calls.reviewer,
    basis:
      `입력 ${contextTokenBudget.toLocaleString()}토큰 상한 + 출력 ` +
      `${effectiveMaxOutputTokens(executor).toLocaleString()}토큰(어댑터가 실제 요청하는 값): ` +
      `${executor.modelId} ${calls.executor}회×$${perExecutor.toFixed(4)}${reviewerPart}`,
  };
}

// ---------------------------------------------------------------------------
// preflight용 종합 판정
// ---------------------------------------------------------------------------

export interface ModelPlan {
  executor: ModelFacts;
  reviewer: ModelFacts;
  /** 검수자 독립성 — 두 공급자가 다른가. */
  providerIndependent: boolean;
  probes: ModelProbe[];
  blockers: string[];
}

/**
 * 실험이 쓸 두 모델을 확정한다. 하나라도 불확실하면 blocker를 남긴다 —
 * "불확실하면 READY가 아니라 BLOCKED"가 §6의 요구다.
 */
export function planModels(input: {
  executorModel?: string;
  reviewerModel?: string;
  entries?: readonly ModelEntry[];
  checker?: CapabilityChecker;
  /** fake provider 실행이면 단가 0을 정상으로 본다. */
  allowZeroPricing?: boolean;
}): ModelPlan | { blockers: string[] } {
  const entries = input.entries ?? BUILTIN_MODELS;
  const checker = input.checker ?? offlineChecker;
  const blockers: string[] = [];

  const executorPick = selectModel("openai", input.executorModel, entries);
  const reviewerPick = selectModel("anthropic", input.reviewerModel, entries);
  if (!executorPick.ok) blockers.push(`executor 모델: ${executorPick.reason}`);
  if (!reviewerPick.ok) blockers.push(`reviewer 모델: ${reviewerPick.reason}`);
  if (!executorPick.ok || !reviewerPick.ok) return { blockers };

  const executor = executorPick.entry;
  const reviewer = reviewerPick.entry;
  const allowZero = input.allowZeroPricing ?? false;

  for (const entry of [executor, reviewer]) {
    const pricing = pricingIsUsable(entry, { allowZero });
    if (!pricing.ok) blockers.push(`가격 정보: ${pricing.reason}`);
  }

  const probes = [checker.probe(executor), checker.probe(reviewer)];
  for (const probe of probes) {
    if (probe.available === "no") {
      blockers.push(`모델 ${probe.modelId}를 사용할 수 없습니다${probe.detail ? ` — ${probe.detail}` : ""}`);
    } else if (probe.available === "unknown") {
      blockers.push(
        `모델 ${probe.modelId}의 사용 가능 여부가 확인되지 않았습니다${probe.detail ? ` — ${probe.detail}` : ""}`
      );
    }
    if (probe.structuredOutputOk !== "yes") {
      blockers.push(`모델 ${probe.modelId}의 구조화 출력 지원이 확인되지 않았습니다`);
    }
  }

  const providerIndependent = executor.providerId !== reviewer.providerId;
  if (!providerIndependent) {
    blockers.push(
      `검수자 독립성 위반: executor와 reviewer가 같은 공급자입니다 (${executor.providerId})`
    );
  }

  return {
    executor: factsOf(executor),
    reviewer: factsOf(reviewer),
    providerIndependent,
    probes,
    blockers,
  };
}

export function isModelPlan(value: ModelPlan | { blockers: string[] }): value is ModelPlan {
  return "executor" in value;
}
