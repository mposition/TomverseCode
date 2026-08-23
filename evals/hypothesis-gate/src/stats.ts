import { armSpec, CROSS_VERIFICATION_ARM, SINGLE_MODEL_ARMS } from "./arms.js";
import { CRITERIA, criteriaHash, type GateCriteria } from "./criteria.js";
import {
  isInfrastructureFailure,
  type ArmId,
  type ArmSummary,
  type GateRunRecord,
  type GateVerdict,
  type ReviewerContribution,
} from "./types.js";

/**
 * 집계와 판정.
 *
 * # 판정에 쓰는 것과 쓰지 않는 것
 *
 * 쓰는 것: oracle 종료 코드. 그것뿐이다.
 * 쓰지 않는 것: 모델의 verdict, 공개 검증 통과 여부, 모델이 스스로 붙인 설명.
 *
 * 측정 대상이 자기 점수를 매기게 하면 아무것도 측정하지 못한다.
 */

/** 결정론적 난수 — seed가 같으면 bootstrap 결과가 재현된다. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** seed 기반 Fisher-Yates. 실행 순서 무작위화가 재현 가능해야 한다(§7). */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

/** 인프라 실패는 성공률 분모에서 뺀다 — 모델 실패로 세지 않는다(§11). */
export function isEvaluable(record: GateRunRecord): boolean {
  return !isInfrastructureFailure(record.failureClass);
}

export function summarizeArm(records: readonly GateRunRecord[], arm: ArmId): ArmSummary {
  const armRecords = records.filter((r) => r.arm === arm);
  const evaluable = armRecords.filter(isEvaluable);
  const oraclePasses = evaluable.filter((r) => r.oracleVerificationPassed).length;
  const costs = evaluable.map((r) => r.costUsd ?? 0);
  const latencies = evaluable.map((r) => r.latencyMs);
  const totalCost = costs.reduce((a, b) => a + b, 0);

  return {
    arm,
    label: armSpec(arm).label,
    runs: armRecords.length,
    evaluableRuns: evaluable.length,
    oraclePasses,
    oraclePassRate: evaluable.length === 0 ? 0 : oraclePasses / evaluable.length,
    publicPasses: evaluable.filter((r) => r.publicVerificationPassed).length,
    infraFailures: armRecords.length - evaluable.length,
    meanCostUsd: evaluable.length === 0 ? 0 : totalCost / evaluable.length,
    costPerSuccessUsd: oraclePasses === 0 ? null : totalCost / oraclePasses,
    meanLatencyMs: latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    totalInputTokens: evaluable.reduce((a, r) => a + r.inputTokens, 0),
    totalOutputTokens: evaluable.reduce((a, r) => a + r.outputTokens, 0),
    retryRate: evaluable.length === 0 ? 0 : evaluable.reduce((a, r) => a + r.retryCount, 0) / evaluable.length,
  };
}

export interface PairedFixtureResult {
  fixtureId: string;
  category: string;
  /** fixture 단위 성공률 (반복 평균) */
  treatmentRate: number;
  baselineRate: number;
  diff: number;
  outcome: "win" | "loss" | "tie";
}

/**
 * fixture 단위 paired 비교.
 *
 * 왜 paired인가: fixture마다 난이도가 크게 다르다. 두 arm의 전체 성공률만 비교하면 어느 fixture가
 * 표본에 들어갔는지에 결과가 크게 흔들린다. 같은 fixture 안에서 비교하면 난이도가 상쇄된다.
 */
export function pairFixtures(
  records: readonly GateRunRecord[],
  treatment: ArmId,
  baseline: ArmId
): PairedFixtureResult[] {
  const fixtureIds = [...new Set(records.map((r) => r.fixtureId))].sort();
  const results: PairedFixtureResult[] = [];

  for (const fixtureId of fixtureIds) {
    const forFixture = records.filter((r) => r.fixtureId === fixtureId && isEvaluable(r));
    const t = forFixture.filter((r) => r.arm === treatment);
    const b = forFixture.filter((r) => r.arm === baseline);
    // 한쪽이 비면 paired 비교가 성립하지 않는다 — 조용히 0으로 채우지 않고 제외한다.
    if (t.length === 0 || b.length === 0) continue;

    const treatmentRate = t.filter((r) => r.oracleVerificationPassed).length / t.length;
    const baselineRate = b.filter((r) => r.oracleVerificationPassed).length / b.length;
    const diff = treatmentRate - baselineRate;
    results.push({
      fixtureId,
      category: t[0]!.category,
      treatmentRate,
      baselineRate,
      diff,
      outcome: diff > 0 ? "win" : diff < 0 ? "loss" : "tie",
    });
  }
  return results;
}

export interface BootstrapResult {
  meanDiff: number;
  lowerBound: number;
  upperBound: number;
  confidence: number;
  iterations: number;
  /** 표본이 너무 적어 신뢰구간이 의미 없는 경우 */
  insufficient: boolean;
}

/**
 * fixture 단위 paired bootstrap.
 *
 * fixture를 복원추출로 다시 뽑아 평균 차이의 분포를 만든다. 개별 실행이 아니라 **fixture를**
 * 재추출하는 것이 핵심이다 — 같은 fixture의 반복은 서로 독립이 아니므로, 실행 단위로 뽑으면
 * 신뢰구간이 실제보다 좁게 나와 있지도 않은 유의성을 만들어낸다.
 */
export function pairedBootstrap(
  paired: readonly PairedFixtureResult[],
  seed: number,
  confidence = CRITERIA.bootstrapConfidence,
  iterations = 10_000
): BootstrapResult {
  if (paired.length < 2) {
    return { meanDiff: paired[0]?.diff ?? 0, lowerBound: 0, upperBound: 0, confidence, iterations: 0, insufficient: true };
  }
  const random = mulberry32(seed);
  const diffs = paired.map((p) => p.diff);
  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j += 1) {
      sum += diffs[Math.floor(random() * diffs.length)]!;
    }
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    meanDiff: diffs.reduce((a, b) => a + b, 0) / diffs.length,
    lowerBound: means[Math.floor(alpha * means.length)]!,
    upperBound: means[Math.min(means.length - 1, Math.ceil((1 - alpha) * means.length) - 1)]!,
    confidence,
    iterations,
    insufficient: false,
  };
}

export interface ContributionTally {
  correction: number;
  harm: number;
  no_measurable_correction: number;
  ineffective: number;
}

export function tallyContributions(records: readonly GateRunRecord[], arm: ArmId): ContributionTally {
  const tally: ContributionTally = { correction: 0, harm: 0, no_measurable_correction: 0, ineffective: 0 };
  for (const record of records) {
    if (record.arm !== arm || !isEvaluable(record)) continue;
    const contribution = record.reviewerContribution;
    if (contribution) tally[contribution] += 1;
  }
  return tally;
}

/**
 * 초안/검수 후 oracle 결과로 검수자 기여를 분류한다 (§5 필수 counterfactual).
 * 판정 근거는 oracle뿐이다 — 검수자가 무슨 verdict를 냈는지는 여기에 영향을 주지 않는다.
 */
export function classifyContribution(draftPassed: boolean, reviewedPassed: boolean): ReviewerContribution {
  if (!draftPassed && reviewedPassed) return "correction";
  if (draftPassed && !reviewedPassed) return "harm";
  if (draftPassed && reviewedPassed) return "no_measurable_correction";
  return "ineffective";
}

export interface GateEvaluation {
  verdict: GateVerdict;
  reasons: string[];
  criteriaHash: string;
  arms: ArmSummary[];
  strongestSingleArm: ArmId | null;
  paired: PairedFixtureResult[];
  bootstrap: BootstrapResult | null;
  contributions: ContributionTally;
  fixtureCount: number;
  minRepetitionsObserved: number;
  infrastructureFailureRate: number;
  realApiRuns: number;
  fakeRuns: number;
  categoryRates: { category: string; arm: ArmId; rate: number; n: number }[];
  /** blind/informed 판정이 갈린 비율 (Arm C vs D) */
  blindInformedVerdictDivergence: number | null;
  blindInformedOracleDivergence: number | null;
}

/**
 * 최종 판정. **사전 등록된 기준만 쓴다.**
 *
 * INCONCLUSIVE가 나오는 경우를 넉넉히 잡아둔 것은 의도적이다. 표본이 모자라거나 실제 API를
 * 돌리지 않았는데 PASS/FAIL을 내면, 그 판정을 근거로 M1 방향이 정해진다 —
 * 근거 없는 판정이 근거 있는 판정보다 나쁘다.
 */
export function evaluateGate(
  records: readonly GateRunRecord[],
  options: { seed: number; criteria?: Readonly<GateCriteria> } = { seed: 1 }
): GateEvaluation {
  const criteria = options.criteria ?? CRITERIA;
  const reasons: string[] = [];

  const realRecords = records.filter((r) => r.providerKind === "real");
  const fakeRuns = records.length - realRecords.length;

  const arms = [...new Set(records.map((r) => r.arm))].sort().map((arm) => summarizeArm(records, arm));
  const fixtureCount = new Set(realRecords.map((r) => r.fixtureId)).size;

  // 기준 해시가 섞이면 서로 다른 실험의 기록이 한 파일에 있는 것이다.
  const hashes = new Set(records.map((r) => r.criteriaHash));
  if (hashes.size > 1) {
    reasons.push(`판정 기준이 다른 기록이 섞여 있습니다 (${[...hashes].join(", ")}) — 같은 실험이 아닙니다`);
  }

  const primaryArms: ArmId[] = [CROSS_VERIFICATION_ARM, ...SINGLE_MODEL_ARMS];
  let minRepetitions = Number.POSITIVE_INFINITY;
  for (const arm of primaryArms) {
    const byFixture = new Map<string, number>();
    for (const record of realRecords) {
      if (record.arm !== arm) continue;
      byFixture.set(record.fixtureId, (byFixture.get(record.fixtureId) ?? 0) + 1);
    }
    for (const count of byFixture.values()) minRepetitions = Math.min(minRepetitions, count);
    if (byFixture.size === 0) minRepetitions = 0;
  }
  if (!Number.isFinite(minRepetitions)) minRepetitions = 0;

  const evaluableAll = records.filter(isEvaluable).length;
  const infrastructureFailureRate = records.length === 0 ? 0 : (records.length - evaluableAll) / records.length;

  // ---- 가장 강한 single arm ----
  const singleSummaries = SINGLE_MODEL_ARMS.map((arm) => summarizeArm(realRecords, arm)).filter((s) => s.evaluableRuns > 0);
  const strongest = singleSummaries.slice().sort((a, b) => b.oraclePassRate - a.oraclePassRate)[0] ?? null;
  const strongestSingleArm = strongest?.arm ?? null;

  const cross = summarizeArm(realRecords, CROSS_VERIFICATION_ARM);
  const paired = strongestSingleArm ? pairFixtures(realRecords, CROSS_VERIFICATION_ARM, strongestSingleArm) : [];
  const bootstrap = paired.length > 0 ? pairedBootstrap(paired, options.seed, criteria.bootstrapConfidence) : null;
  const contributions = tallyContributions(realRecords, CROSS_VERIFICATION_ARM);

  const categoryRates = computeCategoryRates(realRecords);
  const divergence = computeBlindInformedDivergence(realRecords);

  // ---- INCONCLUSIVE 조건을 먼저 본다 ----
  if (realRecords.length === 0) {
    reasons.push(
      fakeRuns > 0
        ? `실제 API 실행 기록이 없습니다 (fake provider 기록 ${fakeRuns}건뿐). fake 결과로는 가설을 판정하지 않습니다.`
        : "실행 기록이 없습니다."
    );
    return inconclusive();
  }
  if (fixtureCount < criteria.minFixtures) {
    reasons.push(`유효 fixture ${fixtureCount}개 < 기준 ${criteria.minFixtures}개`);
  }
  if (minRepetitions < criteria.minRepetitions) {
    reasons.push(`primary arm fixture당 최소 반복 ${minRepetitions}회 < 기준 ${criteria.minRepetitions}회`);
  }
  if (!strongestSingleArm) {
    reasons.push("비교할 single arm 결과가 없습니다");
  }
  if (cross.evaluableRuns === 0) {
    reasons.push("교차검증 arm의 유효 실행이 없습니다");
  }
  if (infrastructureFailureRate >= criteria.maxInfrastructureFailureRate) {
    reasons.push(
      `인프라 실패율 ${(infrastructureFailureRate * 100).toFixed(1)}% ≥ 기준 ${criteria.maxInfrastructureFailureRate * 100}% — 표본을 신뢰할 수 없습니다`
    );
  }

  // ---- 개선할 여지가 있었는가 (천장 검사) ----
  //
  // **이게 없으면 Phase 0이 겪은 상황이 FAIL로 보고된다.** 단일 모델이 5/5를 통과했을 때
  // 사실은 "교차검증이 도움이 안 된다"가 아니라 **"이 세트로는 잴 수 없다"**였다. 그런데
  // 아래 gainPp 검사는 그 둘을 구별하지 못하고 전자로 적는다 — 그리고 그 판정을 근거로
  // M1 방향이 정해진다.
  //
  // 문턱은 새 상수가 아니라 **유도된다**: 가장 강한 단일 arm이 s를 통과했다면 가능한 최대
  // 개선은 (1 − s)이고, 그것이 요구하는 개선폭보다 작으면 무엇을 관측하든 기준을 넘을 수 없다.
  // 상수로 적어두면 `minOraclePassRateGainPp`를 바꿨을 때 따라오지 않는다.
  if (strongest) {
    const headroomPp = (1 - strongest.oraclePassRate) * 100;
    if (headroomPp < criteria.minOraclePassRateGainPp) {
      reasons.push(
        `가장 강한 단일 Arm ${strongest.arm}이 이미 ${(strongest.oraclePassRate * 100).toFixed(1)}% 통과 — ` +
          `가능한 최대 개선 ${headroomPp.toFixed(1)}%p가 기준 ${criteria.minOraclePassRateGainPp}%p보다 작습니다. ` +
          `이 fixture 세트로는 가설을 판정할 수 없습니다 (교차검증이 이득이 없다는 뜻이 아닙니다).`
      );
    }
  }

  if (reasons.length > 0) return inconclusive();

  // ---- 여기부터는 PASS/FAIL 판정 ----
  const failures: string[] = [];
  const gainPp = (cross.oraclePassRate - strongest!.oraclePassRate) * 100;
  if (gainPp < criteria.minOraclePassRateGainPp) {
    failures.push(
      `oracle pass rate 개선 ${gainPp.toFixed(1)}%p < 기준 ${criteria.minOraclePassRateGainPp}%p ` +
        `(교차검증 ${(cross.oraclePassRate * 100).toFixed(1)}% vs 최강 단일 Arm ${strongestSingleArm} ${(strongest!.oraclePassRate * 100).toFixed(1)}%)`
    );
  }
  if (!bootstrap || bootstrap.insufficient) {
    failures.push("paired bootstrap 신뢰구간을 계산할 표본이 부족합니다");
  } else if (bootstrap.lowerBound <= criteria.bootstrapLowerBoundAbove) {
    failures.push(
      `bootstrap ${Math.round(criteria.bootstrapConfidence * 100)}% 신뢰구간 하한 ${bootstrap.lowerBound.toFixed(3)} ≤ ${criteria.bootstrapLowerBoundAbove}`
    );
  }
  if (contributions.harm > 0 && contributions.correction < contributions.harm * criteria.minCorrectionToHarmRatio) {
    failures.push(
      `reviewer correction ${contributions.correction}건이 harm ${contributions.harm}건의 ${criteria.minCorrectionToHarmRatio}배에 미달`
    );
  }
  if (contributions.correction === 0) {
    failures.push("reviewer correction이 한 건도 없습니다 — 검수가 측정 가능한 기여를 하지 못했습니다");
  }

  const securityRegressions = paired.filter(
    (p) => p.category === "security_path_permission" && p.outcome === "loss"
  ).length;
  if (securityRegressions > criteria.maxSecurityRegressions) {
    failures.push(`보안 카테고리 regression ${securityRegressions}건 > 기준 ${criteria.maxSecurityRegressions}건`);
  }

  if (strongest!.meanCostUsd > 0 && cross.meanCostUsd > strongest!.meanCostUsd * criteria.maxCostMultiplier) {
    failures.push(
      `평균 비용 $${cross.meanCostUsd.toFixed(4)} > 최강 단일 arm의 ${criteria.maxCostMultiplier}배 ($${(strongest!.meanCostUsd * criteria.maxCostMultiplier).toFixed(4)})`
    );
  }
  if (strongest!.p95LatencyMs > 0 && cross.p95LatencyMs > strongest!.p95LatencyMs * criteria.maxP95LatencyMultiplier) {
    failures.push(
      `p95 지연 ${Math.round(cross.p95LatencyMs)}ms > 최강 단일 arm의 ${criteria.maxP95LatencyMultiplier}배`
    );
  }

  return {
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    reasons: failures.length === 0 ? ["사전 등록된 모든 기준을 만족했습니다"] : failures,
    criteriaHash: criteriaHash(criteria),
    arms,
    strongestSingleArm,
    paired,
    bootstrap,
    contributions,
    fixtureCount,
    minRepetitionsObserved: minRepetitions,
    infrastructureFailureRate,
    realApiRuns: realRecords.length,
    fakeRuns,
    categoryRates,
    ...divergence,
  };

  function inconclusive(): GateEvaluation {
    return {
      verdict: "INCONCLUSIVE",
      reasons,
      criteriaHash: criteriaHash(criteria),
      arms,
      strongestSingleArm,
      paired,
      bootstrap,
      contributions,
      fixtureCount,
      minRepetitionsObserved: minRepetitions,
      infrastructureFailureRate,
      realApiRuns: realRecords.length,
      fakeRuns,
      categoryRates,
      ...divergence,
    };
  }
}

function computeCategoryRates(records: readonly GateRunRecord[]): GateEvaluation["categoryRates"] {
  const out: GateEvaluation["categoryRates"] = [];
  const categories = [...new Set(records.map((r) => r.category))].sort();
  const arms = [...new Set(records.map((r) => r.arm))].sort() as ArmId[];
  for (const category of categories) {
    for (const arm of arms) {
      const subset = records.filter((r) => r.category === category && r.arm === arm && isEvaluable(r));
      if (subset.length === 0) continue;
      out.push({
        category,
        arm,
        rate: subset.filter((r) => r.oracleVerificationPassed).length / subset.length,
        n: subset.length,
      });
    }
  }
  return out;
}

/** Arm C(informed)와 Arm D(blind)가 같은 초안에 대해 얼마나 다르게 판단했는가. */
function computeBlindInformedDivergence(records: readonly GateRunRecord[]): {
  blindInformedVerdictDivergence: number | null;
  blindInformedOracleDivergence: number | null;
} {
  const pairs: { informed: GateRunRecord; blind: GateRunRecord }[] = [];
  const informed = records.filter((r) => r.arm === "C" && isEvaluable(r));
  const blind = records.filter((r) => r.arm === "D" && isEvaluable(r));
  for (const i of informed) {
    const match = blind.find((b) => b.fixtureId === i.fixtureId && b.repetition === i.repetition);
    if (match) pairs.push({ informed: i, blind: match });
  }
  if (pairs.length === 0) return { blindInformedVerdictDivergence: null, blindInformedOracleDivergence: null };
  return {
    blindInformedVerdictDivergence:
      pairs.filter((p) => p.informed.reviewerVerdict !== p.blind.reviewerVerdict).length / pairs.length,
    blindInformedOracleDivergence:
      pairs.filter((p) => p.informed.oracleVerificationPassed !== p.blind.oracleVerificationPassed).length / pairs.length,
  };
}
