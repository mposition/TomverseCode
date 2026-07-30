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

/**
 * 모델 준비성 — **무엇을 알고 무엇을 모르는지 축별로 분리한다** (§2).
 *
 * # 왜 하나의 `available` 필드로 부족했나
 *
 * 예전에는 `available: "yes" | "no" | "unknown"` 하나였고, 오프라인 검사가 "쓸 수 없다고
 * 알려진 이유가 없으므로 yes"를 돌려줬다. 그건 **"레지스트리에 있으므로 사용 가능"**이라는
 * 말이고, 사실이 아니다 — gpt-5는 레지스트리에 있는데 미인증 계정에서 `model_not_found`로
 * 실패한다. 모델 가용성은 전역 사실이 아니라 **자격증명별 사실**이다.
 *
 * 그래서 하나의 결론 대신 **서로 다른 출처를 가진 사실들**을 따로 적는다. 카탈로그가 아는
 * 것(ID/단가/선언된 능력)과 환경이 아는 것(자격증명 존재)과 실제 호출만이 알 수 있는 것
 * (호출 가능 여부, 응답 모델 ID가 요청과 같은지)은 신뢰도가 다르다.
 *
 * # 불변식
 *
 * **오프라인 검사는 `credentialPresent`·`liveProbeVerified`·`exactModelIdVerified`를 true로
 * 만들 수 없다.** 이 세 개는 각각 환경과 실제 요청만이 확정할 수 있다. `registryReadiness`가
 * 이 셋을 항상 false로 두고, 올리는 경로는 명시적인 함수 두 개뿐이다.
 */
export type ReadinessSource = "registry" | "registry+environment" | "live_probe";

/** 실제 요청으로 확인한 결과. 시도하지 않은 것과 실패한 것은 **다른 사실**이다. */
export type LiveProbeOutcome = "not_attempted" | "verified" | "failed";

export interface ModelReadiness {
  modelId: string;
  providerId: string;
  /** Model Registry가 **정확히 이 ID**를 아는가. */
  catalogKnown: boolean;
  /** 기준일이 있는 쓸 수 있는 단가가 있는가. */
  pricingKnown: boolean;
  /**
   * 카탈로그가 구조화 출력(strict schema 또는 forced tool use)을 **선언**하는가.
   * 선언은 동작 확인이 아니다 — 그래서 이름이 `...Declared`다.
   */
  structuredOutputDeclared: boolean;
  /** 이 공급자의 자격증명이 환경에 있는가. **값은 읽지 않고 존재만 본다.** */
  credentialPresent: boolean;
  /** 실제 요청 1회로 호출 가능함이 확인됐는가. */
  liveProbeVerified: boolean;
  /** probe 결과 원본 — `not_attempted`와 `failed`를 구별해야 한다. */
  liveProbe: LiveProbeOutcome;
  /** 응답이 **요청한 것과 같은 모델 ID**임이 확인됐는가(조용한 대체 탐지). */
  exactModelIdVerified: boolean;
  /** 이 사실들을 확인한 시각. 없으면 "언제 기준인지 모르는 사실"이다. */
  checkedAt: string;
  source: ReadinessSource;
  /** 조직 인증 요구처럼, 사람이 알아야 하는 부가 사실. */
  notes: string[];
}

export interface CapabilityChecker {
  probe(entry: ModelEntry): ModelReadiness;
}

/** 카탈로그가 구조화 출력을 선언하는가. */
export function declaresStructuredOutput(entry: ModelEntry): boolean {
  return (
    entry.capabilities.structuredOutput === "strict_schema" ||
    entry.capabilities.structuredOutput === "forced_tool_use"
  );
}

/**
 * 레지스트리만 보고 만드는 준비성 — **네트워크도 환경변수도 보지 않는다.**
 *
 * 뒤 세 축(`credentialPresent`, `liveProbeVerified`, `exactModelIdVerified`)은 **항상 false**다.
 * 여기서 하나라도 true로 만들 수 있게 하면, 오프라인 검사 결과가 "실제로 확인했다"처럼
 * 읽히는 길이 열린다.
 */
export function registryReadiness(
  entry: ModelEntry,
  options: { checkedAt: string; allowZeroPricing?: boolean }
): ModelReadiness {
  const pricing = pricingIsUsable(entry, { allowZero: options.allowZeroPricing ?? false });
  const notes: string[] = [];
  if (!pricing.ok) notes.push(pricing.reason);
  if (entry.availability.requiresOrgVerification) {
    notes.push(
      `${entry.modelId}: 조직 인증(Organization Verification)이 필요한 모델입니다 — ` +
        `이 자격증명으로 쓸 수 있는지는 실제 호출로만 확인됩니다`
    );
  }
  return {
    modelId: entry.modelId,
    providerId: entry.providerId,
    catalogKnown: true,
    pricingKnown: pricing.ok,
    structuredOutputDeclared: declaresStructuredOutput(entry),
    credentialPresent: false,
    liveProbeVerified: false,
    liveProbe: "not_attempted",
    exactModelIdVerified: false,
    checkedAt: options.checkedAt,
    source: "registry",
    notes,
  };
}

/** 카탈로그에 없는 모델. `catalogKnown: false`이며 나머지는 알 수 없다. */
export function unknownModelReadiness(modelId: string, providerId: string, checkedAt: string, note: string): ModelReadiness {
  return {
    modelId,
    providerId,
    catalogKnown: false,
    pricingKnown: false,
    structuredOutputDeclared: false,
    credentialPresent: false,
    liveProbeVerified: false,
    liveProbe: "not_attempted",
    exactModelIdVerified: false,
    checkedAt,
    source: "registry",
    notes: [note],
  };
}

/**
 * 자격증명 존재 여부를 얹는다. **환경이 아는 사실**이므로 source가 바뀐다.
 *
 * 값을 읽지 않고 존재만 보므로 이 함수를 지나도 키가 어디에도 남지 않는다.
 */
export function withCredentialPresence(readiness: ModelReadiness, present: boolean): ModelReadiness {
  return {
    ...readiness,
    credentialPresent: present,
    source: readiness.source === "live_probe" ? "live_probe" : "registry+environment",
    notes: present
      ? readiness.notes
      : [...readiness.notes, `${readiness.providerId} 자격증명이 환경에 없습니다 — 실제 호출을 할 수 없습니다`],
  };
}

/**
 * 실제 probe 결과를 얹는다. **이 경로만이 뒤 두 축을 true로 만들 수 있다.**
 *
 * `exactModelIdVerified`는 응답이 실어 온 모델 ID가 요청한 것과 **글자 그대로 같을 때만**
 * true다. 조용한 대체(요청한 모델이 없어 공급자가 다른 모델로 응답)를 여기서 잡는다 —
 * 그걸 놓치면 "어떤 모델을 측정했는가"라는 실험의 전제가 무너진다.
 */
export function withLiveProbe(
  readiness: ModelReadiness,
  probe: {
    outcome: LiveProbeOutcome;
    returnedModelId?: string;
    /**
     * Model Registry가 이 응답 ID를 인정했는가(`providerModelIdAccepted`).
     *
     * 이 판정을 여기서 다시 하지 않는 이유: 허용 목록(`acceptedProviderModelIds`)은 레지스트리
     * 계약이고, 같은 규칙을 두 곳에 적으면 한쪽만 고쳐질 수 있다. 주어지지 않으면 **정확히
     * 일치만** 인정한다 — 기본값이 느슨한 쪽이면 이 축이 있으나 마나다.
     */
    acceptedByRegistry?: boolean;
    checkedAt: string;
    note?: string;
  }
): ModelReadiness {
  const idMatches =
    probe.acceptedByRegistry ??
    (probe.returnedModelId !== undefined && probe.returnedModelId === readiness.modelId);
  const exact = probe.outcome === "verified" && idMatches;
  const notes = [...readiness.notes];
  if (probe.note) notes.push(probe.note);
  if (probe.outcome === "verified" && !exact) {
    notes.push(
      `요청한 모델은 ${readiness.modelId}인데 응답이 실어 온 모델 ID는 ` +
        `${probe.returnedModelId ?? "(없음)"}입니다 — 조용한 대체를 허용하지 않습니다`
    );
  }
  return {
    ...readiness,
    liveProbe: probe.outcome,
    liveProbeVerified: probe.outcome === "verified",
    exactModelIdVerified: exact,
    checkedAt: probe.checkedAt,
    source: "live_probe",
    notes,
  };
}

/**
 * **유료 실행을 막는** 사실들. 실제 호출 없이도 확정되는 것만 여기 온다.
 *
 * `liveProbe === "failed"`도 blocker다 — 시도해서 안 됐다는 것은 확정된 사실이다.
 */
export function readinessBlockers(readiness: ModelReadiness): string[] {
  const blockers: string[] = [];
  if (!readiness.catalogKnown) {
    blockers.push(`모델 ${readiness.modelId}가 Model Registry에 없습니다`);
  }
  if (!readiness.pricingKnown) {
    blockers.push(`모델 ${readiness.modelId}의 가격 정보를 쓸 수 없습니다 — 예산 상한을 강제할 수 없습니다`);
  }
  if (!readiness.structuredOutputDeclared) {
    blockers.push(`모델 ${readiness.modelId}가 구조화 출력을 선언하지 않습니다`);
  }
  if (readiness.liveProbe === "failed") {
    blockers.push(`모델 ${readiness.modelId}의 실제 호출이 실패했습니다 — 다른 모델로 대체하지 않습니다`);
  }
  return blockers;
}

/**
 * **실제 probe만이 채울 수 있는 빈칸.** blocker와 구분하는 이유가 중요하다.
 *
 * 이건 "고쳐야 하는 결함"이 아니라 "아직 확인하지 않은 사실"이다. 둘을 한 목록에 섞으면
 * 사용자가 무엇을 해야 하는지 알 수 없다 — 앞의 것은 코드/설정을 고쳐야 하고, 뒤의 것은
 * `gate:g:probe-models`를 돌리면 된다.
 */
export function readinessProbeGaps(readiness: ModelReadiness): string[] {
  const gaps: string[] = [];
  if (!readiness.credentialPresent) {
    gaps.push(`${readiness.providerId} 자격증명이 환경에 없습니다 (${readiness.modelId})`);
  }
  if (!readiness.liveProbeVerified) {
    gaps.push(`모델 ${readiness.modelId}를 실제로 호출할 수 있는지 확인되지 않았습니다 (liveProbe=${readiness.liveProbe})`);
  }
  if (!readiness.exactModelIdVerified) {
    gaps.push(`모델 ${readiness.modelId}가 요청한 ID 그대로 응답하는지 확인되지 않았습니다`);
  }
  return gaps;
}

/**
 * 기본 검사기 — **네트워크도 환경변수도 부르지 않는다.**
 *
 * 레지스트리가 아는 것만 채우고, 나머지는 "확인되지 않음"으로 남긴다.
 * 이 결과만으로는 절대 유료 실행 승인이 나오지 않는다 — 그게 이 검사기의 요점이다.
 */
export const offlineChecker: CapabilityChecker = {
  probe(entry) {
    return registryReadiness(entry, { checkedAt: OFFLINE_CHECK_AT });
  },
};

/**
 * 오프라인 검사에 적을 시각.
 *
 * 실제 시각을 넣으면 카드가 매번 달라져 비교(diff)가 어렵고, 무엇보다 **"이 시점에 확인했다"는
 * 인상**을 준다. 오프라인 검사는 시점과 무관한 스냅샷 조회이므로 그렇게 적는다.
 */
export const OFFLINE_CHECK_AT = "(registry snapshot — 실제 확인 시각 없음)";

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
  readiness: ModelReadiness[];
  /** 고쳐야 하는 결함. 하나라도 있으면 BLOCKED다. */
  blockers: string[];
  /** 실제 probe로만 채울 수 있는 빈칸. 있으면 READY_FOR_MODEL_PROBE다. */
  probeGaps: string[];
}

/**
 * 실험이 쓸 두 모델을 확정한다.
 *
 * **결함(blockers)과 미확인(probeGaps)을 분리한다.** 예전에는 둘을 한 목록에 넣어서
 * "레지스트리에 있으므로 사용 가능"을 통과 조건으로 쓰거나, 반대로 오프라인에서 확인할 수
 * 없는 것을 결함으로 취급해 아무것도 진행할 수 없게 만들었다. 사용자에게 필요한 답은
 * "무엇을 고쳐야 하는가"와 "무엇을 아직 확인하지 않았는가"가 서로 다른 목록으로 나오는 것이다.
 */
export function planModels(input: {
  executorModel?: string;
  reviewerModel?: string;
  entries?: readonly ModelEntry[];
  checker?: CapabilityChecker;
  /** fake provider 실행이면 단가 0을 정상으로 본다. */
  allowZeroPricing?: boolean;
  /**
   * 자격증명 존재 여부. **주입 가능해야 한다** — 테스트가 실제 환경에 의존하면
   * 개발자 머신에 키가 있는지에 따라 결과가 달라진다.
   */
  credentialPresence?: (providerId: string) => boolean;
}): ModelPlan | { blockers: string[]; probeGaps: string[] } {
  const entries = input.entries ?? BUILTIN_MODELS;
  const checker = input.checker ?? offlineChecker;
  const blockers: string[] = [];
  const probeGaps: string[] = [];

  const executorPick = selectModel("openai", input.executorModel, entries);
  const reviewerPick = selectModel("anthropic", input.reviewerModel, entries);
  if (!executorPick.ok) blockers.push(`executor 모델: ${executorPick.reason}`);
  if (!reviewerPick.ok) blockers.push(`reviewer 모델: ${reviewerPick.reason}`);
  if (!executorPick.ok || !reviewerPick.ok) return { blockers, probeGaps };

  const executor = executorPick.entry;
  const reviewer = reviewerPick.entry;
  const allowZero = input.allowZeroPricing ?? false;

  // 단가 판정은 checker가 아는 것과 별개로 여기서도 확인한다 — 주입된 checker가
  // 가격을 안 볼 수도 있고, 예산 강제는 가격 없이는 성립하지 않는다.
  for (const entry of [executor, reviewer]) {
    const pricing = pricingIsUsable(entry, { allowZero });
    if (!pricing.ok) blockers.push(`가격 정보: ${pricing.reason}`);
  }

  const readiness = [executor, reviewer].map((entry) => {
    const base = checker.probe(entry);
    const present = input.credentialPresence?.(entry.providerId);
    // 자격증명 확인 함수를 주지 않았으면 "없다"가 아니라 "확인하지 않았다"이므로,
    // credentialPresent를 false로 두고 probeGap에 남긴다 — 그게 실제 상태다.
    return present === undefined ? base : withCredentialPresence(base, present);
  });

  for (const item of readiness) {
    blockers.push(...readinessBlockers(item));
    probeGaps.push(...readinessProbeGaps(item));
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
    readiness,
    blockers,
    probeGaps,
  };
}

export function isModelPlan(value: ModelPlan | { blockers: string[]; probeGaps: string[] }): value is ModelPlan {
  return "executor" in value;
}
