import test from "node:test";
import assert from "node:assert/strict";
import { CRITERIA, criteriaHash } from "../src/criteria.js";
import {
  classifyContribution,
  evaluateGate,
  pairedBootstrap,
  pairFixtures,
  mulberry32,
  percentile,
  seededShuffle,
  summarizeArm,
} from "../src/stats.js";
import { RECORD_SCHEMA_VERSION, type ArmId, type GateRunRecord } from "../src/types.js";

/** 테스트용 기록 생성기. providerKind는 명시하지 않으면 "real"이다. */
function record(overrides: Partial<GateRunRecord> & { fixtureId: string; arm: ArmId }): GateRunRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId: "test",
    fixtureHash: "hash",
    category: "multi_file_contract",
    repetition: 1,
    seed: 1,
    taskId: "t",
    providerId: "openai",
    requestedModelId: "m",
    publicVerificationPassed: true,
    oracleVerificationPassed: false,
    inputTokens: 100,
    outputTokens: 50,
    providerCallCount: 1,
    retryCount: 0,
    latencyMs: 1000,
    costUsd: 0.01,
    changedFiles: [],
    policyDenials: [],
    promptVersionHash: "p",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    providerKind: "real",
    criteriaHash: criteriaHash(),
    ...overrides,
  } as GateRunRecord;
}

/** N개 fixture × 반복, 지정한 통과 패턴으로 arm 기록을 만든다. */
function armRecords(arm: ArmId, fixtureCount: number, reps: number, passes: (i: number) => boolean): GateRunRecord[] {
  const out: GateRunRecord[] = [];
  for (let i = 0; i < fixtureCount; i += 1) {
    for (let r = 1; r <= reps; r += 1) {
      out.push(record({ fixtureId: `fx-${i}`, arm, repetition: r, oracleVerificationPassed: passes(i) }));
    }
  }
  return out;
}

test("인프라 실패는 성공률 분모에서 빠진다", () => {
  const records = [
    record({ fixtureId: "a", arm: "A", oracleVerificationPassed: true }),
    record({ fixtureId: "b", arm: "A", oracleVerificationPassed: false }),
    // 인프라 실패 — 모델 실패로 세면 통과율이 1/3로 잘못 내려간다.
    record({ fixtureId: "c", arm: "A", failureClass: "rate_limit" }),
  ];
  const summary = summarizeArm(records, "A");
  assert.equal(summary.runs, 3);
  assert.equal(summary.evaluableRuns, 2);
  assert.equal(summary.oraclePassRate, 0.5);
  assert.equal(summary.infraFailures, 1);
});

test("모델 실패는 분모에 남는다", () => {
  const records = [
    record({ fixtureId: "a", arm: "A", oracleVerificationPassed: true }),
    record({ fixtureId: "b", arm: "A", failureClass: "wrong_patch" }),
  ];
  assert.equal(summarizeArm(records, "A").oraclePassRate, 0.5);
});

test("검수자 기여는 oracle 결과만으로 분류된다", () => {
  assert.equal(classifyContribution(false, true), "correction");
  assert.equal(classifyContribution(true, false), "harm");
  assert.equal(classifyContribution(true, true), "no_measurable_correction");
  assert.equal(classifyContribution(false, false), "ineffective");
});

test("paired 비교는 한쪽이 비면 그 fixture를 제외한다", () => {
  const records = [
    record({ fixtureId: "a", arm: "C", oracleVerificationPassed: true }),
    record({ fixtureId: "a", arm: "A", oracleVerificationPassed: false }),
    // b는 C만 있다 — 0으로 채우면 없는 이득이 만들어진다.
    record({ fixtureId: "b", arm: "C", oracleVerificationPassed: true }),
  ];
  const paired = pairFixtures(records, "C", "A");
  assert.deepEqual(paired.map((p) => p.fixtureId), ["a"]);
  assert.equal(paired[0]!.diff, 1);
});

test("bootstrap은 같은 seed에서 재현된다", () => {
  const paired = pairFixtures(
    [
      ...armRecords("C", 6, 1, (i) => i < 5),
      ...armRecords("A", 6, 1, (i) => i < 2),
    ],
    "C",
    "A"
  );
  const first = pairedBootstrap(paired, 42, 0.95, 500);
  const second = pairedBootstrap(paired, 42, 0.95, 500);
  assert.deepEqual(first, second, "같은 seed인데 결과가 다릅니다 — 재현 불가능한 통계입니다");

  // seed가 다르면 **재추출 순서**가 다르다. 신뢰구간 값 자체가 달라지는지는 단정하지 않는다:
  // diff가 0/1로 이산적이면 서로 다른 재추출이 같은 백분위수에 떨어지는 일이 흔하고,
  // 그걸 단정하면 통계적으로 정상인 상황에서 테스트가 깨진다.
  const a = mulberry32(42);
  const b = mulberry32(43);
  assert.notEqual(a(), b(), "seed가 달라도 난수열이 같습니다");
});

test("표본이 2개 미만이면 bootstrap이 insufficient로 표시된다", () => {
  const result = pairedBootstrap([{ fixtureId: "a", category: "x", treatmentRate: 1, baselineRate: 0, diff: 1, outcome: "win" }], 1);
  assert.equal(result.insufficient, true);
});

test("seed 기반 셔플은 재현되고 원소를 잃지 않는다", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(seededShuffle(items, 7), seededShuffle(items, 7));
  assert.notDeepEqual(seededShuffle(items, 7), seededShuffle(items, 8));
  assert.deepEqual([...seededShuffle(items, 7)].sort((a, b) => a - b), items);
});

test("percentile은 경계에서 터지지 않는다", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
});

// ---- 판정 경계값 ----

test("fake provider 기록만 있으면 INCONCLUSIVE이고 성공률을 주장하지 않는다", () => {
  const records = armRecords("C", 24, 3, () => true).map((r) => ({ ...r, providerKind: "fake" as const }));
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "INCONCLUSIVE");
  assert.ok(evaluation.reasons.some((r) => r.includes("fake")), evaluation.reasons.join(" / "));
  assert.equal(evaluation.realApiRuns, 0);
  assert.equal(evaluation.fakeRuns, 72);
});

/**
 * **Phase 0이 겪은 상황이 FAIL로 보고되면 안 된다.**
 *
 * 단일 모델이 거의 다 통과하면 개선할 여지 자체가 없다. 그때 나오는 "개선 0%p"는
 * "교차검증이 이득이 없다"가 아니라 **"이 세트로는 잴 수 없다"**이고, 그 둘을 뭉치면
 * 근거 없는 판정을 근거로 M1 방향이 정해진다.
 */
test("단일 모델이 이미 천장에 닿으면 FAIL이 아니라 INCONCLUSIVE다", () => {
  const records = [
    ...armRecords("C", 24, 3, () => true),
    // 최강 단일 arm이 24개 중 23개 통과 = 가능한 최대 개선 4.2%p < 기준 10%p.
    ...armRecords("A", 24, 3, (i) => i > 0),
    ...armRecords("B", 24, 3, () => false),
  ];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "INCONCLUSIVE", evaluation.reasons.join(" / "));
  assert.ok(
    evaluation.reasons.some((r) => r.includes("최대 개선")),
    evaluation.reasons.join(" / ")
  );
});

test("천장 문턱은 상수가 아니라 요구 개선폭에서 유도된다", () => {
  // 최강 단일 arm 통과율 0.5 → 최대 개선 50%p. 요구 개선폭을 60%p로 올리면 잴 수 없어진다.
  const records = [
    ...armRecords("C", 24, 3, () => true),
    ...armRecords("A", 24, 3, (i) => i % 2 === 0),
    ...armRecords("B", 24, 3, () => false),
  ];
  const relaxed = evaluateGate(records, { seed: 1 });
  assert.notEqual(relaxed.verdict, "INCONCLUSIVE", relaxed.reasons.join(" / "));

  const strict = evaluateGate(records, {
    seed: 1,
    criteria: { ...CRITERIA, minOraclePassRateGainPp: 60 },
  });
  assert.equal(strict.verdict, "INCONCLUSIVE", strict.reasons.join(" / "));
  assert.ok(strict.reasons.some((r) => r.includes("최대 개선")), strict.reasons.join(" / "));
});

test("fixture가 24개 미만이면 INCONCLUSIVE", () => {
  const records = [
    ...armRecords("C", 23, 3, () => true),
    ...armRecords("A", 23, 3, () => false),
    ...armRecords("B", 23, 3, () => false),
  ];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "INCONCLUSIVE");
  assert.ok(evaluation.reasons.some((r) => r.includes("fixture")));
});

test("반복이 3회 미만이면 INCONCLUSIVE (pilot 결과로 PASS를 내지 않는다)", () => {
  const records = [
    ...armRecords("C", 24, 1, () => true),
    ...armRecords("A", 24, 1, () => false),
    ...armRecords("B", 24, 1, () => false),
  ];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "INCONCLUSIVE");
  assert.ok(evaluation.reasons.some((r) => r.includes("반복")));
});

test("인프라 실패율이 5% 이상이면 INCONCLUSIVE", () => {
  const good = [
    ...armRecords("C", 24, 3, () => true),
    ...armRecords("A", 24, 3, () => false),
    ...armRecords("B", 24, 3, () => false),
  ];
  const broken = Array.from({ length: 20 }, (_, i) =>
    record({ fixtureId: `fx-${i}`, arm: "C", repetition: 4, failureClass: "provider_5xx" })
  );
  const evaluation = evaluateGate([...good, ...broken], { seed: 1 });
  assert.equal(evaluation.verdict, "INCONCLUSIVE");
  assert.ok(evaluation.reasons.some((r) => r.includes("인프라")));
});

test("이득이 기준 미만이면 FAIL", () => {
  // 교차검증 50%, 최강 단일 45% → 5%p < 10%p
  const records = [
    ...armRecords("C", 24, 3, (i) => i < 12),
    ...armRecords("A", 24, 3, (i) => i < 11),
    ...armRecords("B", 24, 3, (i) => i < 5),
  ];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "FAIL");
  assert.ok(evaluation.reasons.some((r) => r.includes("%p")), evaluation.reasons.join(" / "));
});

test("모든 기준을 만족하면 PASS", () => {
  // 교차검증이 fixture 20/24에서 성공, 단일은 8/24 — 50%p 차이.
  // correction이 harm보다 충분히 많도록 기여도 채운다.
  const cross = armRecords("C", 24, 3, (i) => i < 20).map((r, idx) => ({
    ...r,
    draftOraclePassed: false,
    reviewedOraclePassed: r.oracleVerificationPassed,
    reviewerContribution: (r.oracleVerificationPassed ? "correction" : "ineffective") as
      | "correction"
      | "ineffective",
    latencyMs: 1000 + idx,
  }));
  const records = [...cross, ...armRecords("A", 24, 3, (i) => i < 8), ...armRecords("B", 24, 3, (i) => i < 4)];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "PASS", evaluation.reasons.join(" / "));
  assert.equal(evaluation.strongestSingleArm, "A");
  assert.ok(evaluation.contributions.correction > 0);
});

test("correction이 0이면 이득이 커도 FAIL", () => {
  const cross = armRecords("C", 24, 3, (i) => i < 20).map((r) => ({
    ...r,
    reviewerContribution: (r.oracleVerificationPassed ? "no_measurable_correction" : "ineffective") as
      | "no_measurable_correction"
      | "ineffective",
  }));
  const records = [...cross, ...armRecords("A", 24, 3, (i) => i < 8), ...armRecords("B", 24, 3, (i) => i < 4)];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "FAIL");
  assert.ok(evaluation.reasons.some((r) => r.includes("correction")));
});

test("보안 카테고리 regression이 있으면 FAIL", () => {
  const cross = armRecords("C", 24, 3, (i) => i < 20).map((r, i) => ({
    ...r,
    category: i < 6 ? ("security_path_permission" as const) : r.category,
    // 첫 보안 fixture에서 교차검증이 진다.
    oracleVerificationPassed: i < 3 ? false : r.oracleVerificationPassed,
    reviewerContribution: "correction" as const,
  }));
  const single = armRecords("A", 24, 3, (i) => i < 8).map((r, i) => ({
    ...r,
    category: i < 6 ? ("security_path_permission" as const) : r.category,
    oracleVerificationPassed: i < 3 ? true : r.oracleVerificationPassed,
  }));
  const evaluation = evaluateGate([...cross, ...single, ...armRecords("B", 24, 3, () => false)], { seed: 1 });
  assert.equal(evaluation.verdict, "FAIL");
  assert.ok(evaluation.reasons.some((r) => r.includes("보안")), evaluation.reasons.join(" / "));
});

test("비용이 2배를 넘으면 FAIL", () => {
  const cross = armRecords("C", 24, 3, (i) => i < 20).map((r) => ({
    ...r,
    costUsd: 0.1,
    reviewerContribution: "correction" as const,
  }));
  const single = armRecords("A", 24, 3, (i) => i < 8).map((r) => ({ ...r, costUsd: 0.01 }));
  const evaluation = evaluateGate([...cross, ...single, ...armRecords("B", 24, 3, () => false)], { seed: 1 });
  assert.equal(evaluation.verdict, "FAIL");
  assert.ok(evaluation.reasons.some((r) => r.includes("비용")), evaluation.reasons.join(" / "));
});

test("기준 해시가 다른 기록이 섞이면 INCONCLUSIVE", () => {
  const records = [
    ...armRecords("C", 24, 3, () => true),
    ...armRecords("A", 24, 3, () => false),
    ...armRecords("B", 24, 3, () => false),
    record({ fixtureId: "fx-0", arm: "C", repetition: 9, criteriaHash: "다른기준" }),
  ];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.verdict, "INCONCLUSIVE");
  assert.ok(evaluation.reasons.some((r) => r.includes("기준")));
});

test("blind/informed 불일치율이 계산된다", () => {
  const records = [
    record({ fixtureId: "a", arm: "C", reviewerVerdict: "ACCEPT", oracleVerificationPassed: true }),
    record({ fixtureId: "a", arm: "D", reviewerVerdict: "REVISE", oracleVerificationPassed: true }),
    record({ fixtureId: "b", arm: "C", reviewerVerdict: "ACCEPT", oracleVerificationPassed: true }),
    record({ fixtureId: "b", arm: "D", reviewerVerdict: "ACCEPT", oracleVerificationPassed: false }),
  ];
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.equal(evaluation.blindInformedVerdictDivergence, 0.5);
  assert.equal(evaluation.blindInformedOracleDivergence, 0.5);
});
