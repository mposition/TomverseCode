import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBudgetLedger,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  effectiveMaxOutputTokens,
  maxCallCostUsd,
  MAX_OUTPUT_TOKENS_PER_CALL,
  pricingIsUsable,
  validateApprovedLimit,
  type BudgetEvent,
} from "@tomverse/sidecar/budget";
import type { ModelEntry } from "@tomverse/protocol";
import {
  approvalCoversHistorical,
  createBudgetEventSink,
  readBudgetEvents,
  reconcile,
  recoverSpendFromRecords,
} from "../src/budgetRecovery.js";
import { criteriaHash, CRITERIA } from "../src/criteria.js";
import { loadAllFixtures, listFixtureIds } from "../src/manifest.js";
import {
  estimateRecordCost,
  maxCallsPerRecord,
  planModels,
  offlineChecker,
  isModelPlan,
  readinessBlockers,
  registryReadiness,
  withCredentialPresence,
  type ModelReadiness,
} from "../src/models.js";
import {
  probeModels,
  PROBE_RECORDS_FILE,
  writeProbeResults,
  type ProbeRole,
  type ProbeTransport,
  type RoleProbeOutcome,
} from "../src/probeModels.js";
import { ARMS } from "../src/arms.js";
import { OptionError, parseArgs, parseConcurrency, parseCostLimit, requireCostLimitForPaidRun } from "../src/options.js";
import { openRecordStore } from "../src/records.js";
import { buildStagedCards, renderRunCard, selectSmokeFixtures } from "../src/runCard.js";
import { checkCompatibility, RECORDS_FILE, runDirPaths, type RunMeta } from "../src/runDir.js";
import { runExperiment } from "../src/runner.js";
import { evaluateGate } from "../src/stats.js";
import type { GateRunRecord } from "../src/types.js";

/**
 * Pilot Safety Gate 테스트 (§9).
 *
 * **실제 provider를 부르지 않고 전부 돈다.** 모델 가용성 검사는 주입 가능한 checker로,
 * 비용은 순수 함수로, 실행 중단은 fake 실행으로 확인한다 — 유료 API가 필요한 테스트를
 * 만들면 `npm test`가 돈을 쓰게 되고, 그건 이 파일이 막으려는 것과 같은 종류의 사고다.
 */

/**
 * **`new URL(import.meta.url).pathname`을 쓰지 않는다.** Windows에서는 드라이브 문자 앞에
 * 슬래시가 붙어(`/C:/Users/...`) 경로가 깨진다. 그러면 fixture가 0개가 되고, 이 파일의
 * 검사들이 빈 집합에 대해 통과하거나 서로 무관해 보이는 실패로 나타난다 — 실측으로 그랬다.
 * `fileURLToPath`가 플랫폼별 규칙을 아는 유일한 변환이다.
 */
const FIXTURES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

/**
 * fixture가 실제로 로드되는지 **맨 먼저** 확인한다.
 *
 * 경로가 깨지면 아래 검사들이 빈 집합에 대해 돌면서 원인과 먼 실패를 낸다. 여기서 한 번
 * 크게 실패하는 편이 다섯 곳에서 조금씩 틀리는 것보다 낫다.
 */
test("0. fixture 24개가 실제로 로드된다 (경로가 깨지면 여기서 먼저 실패한다)", () => {
  const ids = listFixtureIds(FIXTURES_ROOT);
  assert.equal(ids.length, 24, `fixture 경로가 잘못되었습니다: ${FIXTURES_ROOT}`);
  assert.equal(loadAllFixtures(FIXTURES_ROOT, ids).length, 24);
});

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-safety-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function modelEntry(overrides: Partial<ModelEntry> & { modelId: string; providerId: string }): ModelEntry {
  return {
    protocol: "native",
    apiBaseUrl: "https://example.invalid",
    apiKeyEnvName: "X_API_KEY",
    capabilities: {
      toolCalling: "parallel",
      structuredOutput: "strict_schema",
      imageInput: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 10_000,
    },
    economics: { inputPerMTok: 1, outputPerMTok: 2, pricingAsOf: "2026-07-01T00:00:00Z" },
    availability: { requiresOrgVerification: false },
    ...overrides,
  } as ModelEntry;
}

// ---- 1·2. 유료 실행에는 비용 상한 필수, fake/dry-run은 면제 ----

test("1. 실제 pilot/run은 비용 상한이 없으면 거부한다", () => {
  for (const command of ["pilot", "run"]) {
    const options = parseArgs([command], "/tmp/out");
    assert.throws(
      () => requireCostLimitForPaidRun(options, false),
      (error: unknown) => {
        assert.ok(error instanceof OptionError);
        assert.ok(error.message.includes("--max-cost-usd가 필수"), error.message);
        // 올바른 사용 예를 함께 보여준다.
        assert.ok(error.message.includes("--max-cost-usd 25"), error.message);
        return true;
      },
      `${command}가 상한 없이 통과했습니다`
    );
  }
});

test("2. fake provider와 dry-run은 비용 상한 없이 허용한다", () => {
  // fake는 단가 0이라 예산이 의미가 없고, dry-run은 아예 호출하지 않는다.
  requireCostLimitForPaidRun(parseArgs(["pilot"], "/tmp/out"), true);
  requireCostLimitForPaidRun(parseArgs(["run"], "/tmp/out"), true);
  requireCostLimitForPaidRun(parseArgs(["dry-run"], "/tmp/out"), false);
  requireCostLimitForPaidRun(parseArgs(["validate"], "/tmp/out"), false);
  requireCostLimitForPaidRun(parseArgs(["plan-pilot"], "/tmp/out"), false);
});

test("2b. 비용 상한 없이 유료 실행하는 우회 옵션이 없다", () => {
  // "이번만 상한 없이"를 허용하는 순간 그게 기본 사용법이 된다.
  for (const flag of ["--no-budget", "--force", "--allow-unbounded-cost", "--yes"]) {
    assert.throws(() => parseArgs(["pilot", flag], "/tmp/out"), /알 수 없는 옵션/);
  }
});

// ---- 3. 잘못된 숫자 거부 ----

test("3. NaN/Infinity/0/음수/부분 숫자를 파싱 단계에서 거부한다", () => {
  const bad = ["0", "-1", "-0.5", "NaN", "Infinity", "-Infinity", "", "   ", "5달러", "5usd", "1e999", "0x10", "1,000", "abc", "5.", ".5.1"];
  for (const value of bad) {
    assert.throws(() => parseCostLimit(value), OptionError, `${JSON.stringify(value)}가 통과했습니다`);
  }
  // 정상 값은 통과한다.
  assert.equal(parseCostLimit("25"), 25);
  assert.equal(parseCostLimit("12.50"), 12.5);
  assert.equal(parseCostLimit(" 0.01 "), 0.01);
});

test("3b. ledger도 같은 값을 거부한다", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(validateApprovedLimit(value).ok, false, `${value}가 통과했습니다`);
    assert.throws(() => createBudgetLedger(value));
  }
});

// ---- 4. 가격 없는 모델은 preflight 차단 ----

test("4. 가격 정보가 없는 모델은 preflight blocker다", () => {
  const noPricingDate = modelEntry({
    modelId: "no-date",
    providerId: "openai",
    economics: { inputPerMTok: 1, outputPerMTok: 2, pricingAsOf: "" },
  });
  assert.equal(pricingIsUsable(noPricingDate, { allowZero: false }).ok, false);

  const zeroPriced = modelEntry({
    modelId: "free-looking",
    providerId: "openai",
    economics: { inputPerMTok: 0, outputPerMTok: 0, pricingAsOf: "2026-07-01T00:00:00Z" },
  });
  assert.equal(pricingIsUsable(zeroPriced, { allowZero: false }).ok, false, "실제 공급자의 단가 0을 통과시켰습니다");
  assert.equal(pricingIsUsable(zeroPriced, { allowZero: true }).ok, true, "fake는 단가 0이 정상입니다");

  const plan = planModels({
    entries: [zeroPriced, modelEntry({ modelId: "rev", providerId: "anthropic" })],
    allowZeroPricing: false,
  });
  assert.ok(plan.blockers.some((b) => b.includes("가격 정보")), plan.blockers.join("\n"));
});

test("4b. 조직 인증이 필요한 모델은 '실제 확인 필요'로 남는다", () => {
  // gpt-5 사건: 가용성은 전역 사실이 아니라 자격증명별 사실이다.
  // 오프라인에서는 "쓸 수 없다"고도 "쓸 수 있다"고도 말할 수 없으므로 probeGap이다.
  const readiness = offlineChecker.probe(
    modelEntry({ modelId: "gpt-x", providerId: "openai", availability: { requiresOrgVerification: true } })
  );
  assert.equal(readiness.liveProbe, "not_attempted");
  assert.equal(readiness.liveProbeVerified, false);
  assert.ok(readiness.notes.some((n) => n.includes("조직 인증")), readiness.notes.join(" / "));

  const plan = planModels({
    entries: [
      modelEntry({ modelId: "gpt-x", providerId: "openai", availability: { requiresOrgVerification: true } }),
      modelEntry({ modelId: "rev", providerId: "anthropic" }),
    ],
    executorModel: "gpt-x",
    credentialPresence: () => true,
  });
  assert.ok(plan.probeGaps.some((g) => g.includes("확인되지 않았습니다")), plan.probeGaps.join("\n"));
  // 그리고 이 상태로는 유료 실행 카드가 나오지 않는다.
  assert.ok(isModelPlan(plan));
});

test("4c. 모델을 쓸 수 없어도 조용히 다른 모델로 대체하지 않는다", () => {
  const plan = planModels({
    entries: [modelEntry({ modelId: "only", providerId: "anthropic" })],
    executorModel: "does-not-exist",
  });
  assert.ok(!isModelPlan(plan));
  assert.ok(plan.blockers.some((b) => b.includes("Model Registry에 없습니다")), plan.blockers.join("\n"));
});

test("4d. 공급자 독립성이 깨지면 blocker다", () => {
  const plan = planModels({
    entries: [
      modelEntry({ modelId: "a", providerId: "openai" }),
      // reviewer 자리에 openai 모델을 강제로 지정하면 소속 불일치로 먼저 걸린다.
      modelEntry({ modelId: "b", providerId: "openai" }),
    ],
    reviewerModel: "b",
  });
  assert.ok(plan.blockers.length > 0);
});

// ---- 5. usage 없는 응답은 남은 호출 중단 ----

test("5. 실제 공급자에서 비용을 잴 수 없으면 남은 유료 호출을 중단한다", async () => {
  await withDirAsync(async (dir) => {
    const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT).slice(0, 2));
    const store = openRecordStore(path.join(dir, RECORDS_FILE));
    const ledger = createBudgetLedger(100);

    // 호스트를 부르지 않고 runner의 중단 경로만 확인하기 위해, 첫 기록이 비용 없이 끝나도록
    // 실제 실행을 흉내내는 대신 dryRun=false + 존재하지 않는 바이너리로 인프라 실패를 만든다.
    const result = await runExperiment({
      fixtures,
      arms: ["A"],
      repetitions: 1,
      seed: 1,
      store,
      runId: "unmeasurable-test",
      ledger,
      estimateRecordCostUsd: () => ({ maxUsd: 1, basis: "테스트" }),
      realProvider: true,
      maxCostUsd: 100,
    });

    assert.equal(result.unmeasurableCostAbort, true, "비용을 잴 수 없는데 계속 돌았습니다");
    assert.ok(result.abortReason?.includes("중단"), result.abortReason);
    // 첫 기록 하나만 실행하고 멈춘다 — 남은 fixture는 건드리지 않는다.
    assert.equal(result.executed, 1);
    assert.ok(result.planned > 1);
    // 기록은 보존되어 resume이 이어받을 수 있다.
    assert.equal(store.count(), 1);
    assert.equal(store.all()[0]!.failureClass, "cost_unmeasurable");
  });
});

async function withDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-safety-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 6·7·8. ledger 계약 ----

test("6. 예약이 승인 상한을 넘으면 provider를 부르지 않는다", () => {
  const ledger = createBudgetLedger(10);
  const first = ledger.reserve({ maxUsd: 7, basis: "b" }, "one");
  assert.ok(first.ok);
  const second = ledger.reserve({ maxUsd: 7, basis: "b" }, "two");
  assert.equal(second.ok, false, "남은 예산이 부족한데 예약이 승인됐습니다");
  if (!second.ok) {
    assert.ok(second.reason.includes("초과합니다"), second.reason);
    assert.equal(second.availableUsd, 3);
  }
});

test("6b. 예상 비용을 계산할 수 없으면 예약하지 않는다", () => {
  const ledger = createBudgetLedger(10);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const outcome = ledger.reserve({ maxUsd: bad, basis: "모름" }, "x");
    assert.equal(outcome.ok, false, `${bad}로 예약이 성공했습니다`);
  }
  assert.equal(ledger.reservedUsd(), 0);
});

test("7. 예약 비용과 실제 비용을 정산한다", () => {
  const ledger = createBudgetLedger(10);
  const outcome = ledger.reserve({ maxUsd: 4, basis: "b" }, "one");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(ledger.reservedUsd(), 4);
  assert.equal(ledger.availableUsd(), 6);

  outcome.reservation.settle(0.25);
  assert.equal(ledger.reservedUsd(), 0);
  assert.equal(ledger.cumulativeCommittedUsd(), 0.25);
  // 예약이 풀렸으므로 남은 예산이 늘어난다 — 과대 추정이 예산을 영구히 잡아먹지 않는다.
  assert.equal(ledger.availableUsd(), 9.75);
});

test("7b. 실제 비용이 예약보다 커도 실제 값을 기록한다", () => {
  // 예약액으로 깎아 기록하면 장부가 실제 청구액과 어긋난다.
  const ledger = createBudgetLedger(10);
  const outcome = ledger.reserve({ maxUsd: 1, basis: "b" }, "one");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  outcome.reservation.settle(3);
  assert.equal(ledger.cumulativeCommittedUsd(), 3);
});

test("8. 오류·취소·타임아웃 시 예약이 해제되고 장부가 일관된다", () => {
  const ledger = createBudgetLedger(10);
  const outcome = ledger.reserve({ maxUsd: 4, basis: "b" }, "one");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  outcome.reservation.release();
  assert.equal(ledger.reservedUsd(), 0);
  assert.equal(ledger.cumulativeCommittedUsd(), 0);
  assert.equal(ledger.availableUsd(), 10, "해제 후 예산이 원래대로 돌아오지 않았습니다");

  // 이중 정산은 장부를 망가뜨리므로 막는다.
  assert.throws(() => outcome.reservation.settle(1));
  assert.throws(() => outcome.reservation.release());

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.reservationsOpened, 1);
  assert.equal(snapshot.reservationsReleased, 1);
  assert.equal(snapshot.reservationsSettled, 0);
});

test("8b. 동시 예약이 double-spend를 만들지 않는다", () => {
  // 예약 시점에 즉시 차감하므로, 나중에 병렬 실행을 붙여도 합계가 상한을 넘지 못한다.
  const ledger = createBudgetLedger(10);
  const outcomes = [3, 3, 3, 3].map((amount, i) => ledger.reserve({ maxUsd: amount, basis: "b" }, `p${i}`));
  const accepted = outcomes.filter((o) => o.ok);
  assert.equal(accepted.length, 3, "상한을 넘는 예약이 승인됐습니다");
  assert.ok(ledger.reservedUsd() <= ledger.approvedLimitUsd);
});

// ---- 9·10. 동시성 계약 ----

test("9. --max-concurrency는 1만 허용한다", () => {
  assert.equal(parseConcurrency("1"), 1);
  for (const value of ["0", "2", "8", "-1", "NaN", "1.5", ""]) {
    assert.throws(() => parseConcurrency(value), OptionError, `${JSON.stringify(value)}가 통과했습니다`);
  }
});

test("9b. 거부 메시지가 이유를 설명한다", () => {
  try {
    parseConcurrency("4");
    assert.fail("통과했습니다");
  } catch (error) {
    assert.ok(error instanceof OptionError);
    assert.ok(error.message.includes("순차 실행만"), error.message);
    assert.ok(error.message.includes("p95"), error.message);
  }
});

test("10. 무시되는 CLI 옵션이 없다", () => {
  // 예전 --max-concurrency는 파싱되고 경고까지 냈지만 runner가 쓰지 않았다 — 거짓 계약이다.
  // 파싱된 모든 옵션이 실제 동작에 반영되는지 확인한다.
  const options = parseArgs(
    ["pilot", "--fixtures", "a,b", "--arms", "A,B", "--repetitions", "2", "--seed", "7",
     "--max-cost-usd", "5", "--max-concurrency", "1", "--resume", "--output", "/tmp/o",
     "--executor-model", "m1", "--reviewer-model", "m2"],
    "/default"
  );
  assert.deepEqual(options.fixtures, ["a", "b"]);
  assert.deepEqual(options.arms, ["A", "B"]);
  assert.equal(options.repetitions, 2);
  assert.equal(options.seed, 7);
  assert.equal(options.maxCostUsd, 5);
  assert.equal(options.maxConcurrency, 1);
  assert.equal(options.resume, true);
  assert.equal(options.executorModel, "m1");
  assert.equal(options.reviewerModel, "m2");

  // 1이 아닌 값은 애초에 파싱되지 않으므로 "무시될" 여지가 없다.
  assert.throws(() => parseArgs(["pilot", "--max-concurrency", "4"], "/default"), OptionError);
});

// ---- 11·12·13. resume 계약 ----

test("11. 최초 실행과 resume이 같은 records.jsonl을 쓴다", () => {
  withDir((dir) => {
    const paths = runDirPaths(dir);
    assert.ok(paths.records.endsWith(RECORDS_FILE), paths.records);
    // 최초 실행이 만드는 파일과 재개가 여는 파일이 같은 경로여야 한다.
    const first = openRecordStore(runDirPaths(dir).records);
    first.append(sampleRecord("f1", "A", 1));
    const resumed = openRecordStore(runDirPaths(dir).records);
    assert.equal(resumed.count(), 1, "재개가 기존 기록을 찾지 못했습니다 — 처음부터 다시 돌게 됩니다");
    assert.equal(resumed.filePath, first.filePath);
  });
});

test("12. 이미 완료된 조합은 다시 호출하지 않는다", async () => {
  await withDirAsync(async (dir) => {
    const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT).slice(0, 1));
    const store = openRecordStore(path.join(dir, RECORDS_FILE));
    const id = fixtures[0]!.manifest.fixtureId;
    store.append(sampleRecord(id, "A", 1));

    const result = await runExperiment({
      fixtures,
      arms: ["A"],
      repetitions: 1,
      seed: 1,
      store,
      runId: "resume-test",
      dryRun: false,
      // ledger 없이 — 이 테스트는 "건너뛰는가"만 본다.
    });
    assert.equal(result.skippedResume, 1);
    assert.equal(result.executed, 0, "완료된 조합을 다시 실행했습니다");
  });
});

test("13. 다른 criteria/fixture/model/seed로는 재개를 거부한다", () => {
  const base: RunMeta = {
    metaVersion: 1,
    stage: "pilot",
    protocolVersion: CRITERIA.protocolVersion,
    criteriaHash: criteriaHash(),
    fixtureHashes: { f1: "hash1" },
    arms: ["A", "B", "C", "D"],
    repetitions: 1,
    seed: 1,
    executorModelId: "gpt-4.1",
    reviewerModelId: "claude-sonnet-5",
    approvals: [{ approvedLimitUsd: 30, at: "2026-07-01T00:00:00Z", note: "최초" }],
    createdAt: "2026-07-01T00:00:00Z",
  };
  const incoming = {
    stage: base.stage,
    protocolVersion: base.protocolVersion,
    criteriaHash: base.criteriaHash,
    fixtureHashes: { f1: "hash1" },
    arms: base.arms,
    repetitions: 1,
    seed: 1,
    executorModelId: base.executorModelId,
    reviewerModelId: base.reviewerModelId,
  };
  const budget = { approvedLimitUsd: 30, alreadySpentUsd: 1 };

  assert.equal(checkCompatibility(base, incoming, budget).ok, true, "같은 조건인데 거부했습니다");

  const cases: [string, Record<string, unknown>][] = [
    ["criteria hash", { criteriaHash: "deadbeef" }],
    ["fixture 내용", { fixtureHashes: { f1: "hash2" } }],
    ["executor 모델", { executorModelId: "other" }],
    ["reviewer 모델", { reviewerModelId: "other" }],
    ["seed", { seed: 2 }],
    ["arm 집합", { arms: ["A"] }],
    ["stage", { stage: "smoke" }],
    ["protocol version", { protocolVersion: 999 }],
    ["모르는 fixture", { fixtureHashes: { f9: "x" } }],
  ];
  for (const [label, override] of cases) {
    const result = checkCompatibility(base, { ...incoming, ...override } as typeof incoming, budget);
    assert.equal(result.ok, false, `${label}이(가) 달라도 재개를 허용했습니다`);
    assert.ok(result.conflicts.length > 0);
  }
});

test("13b. 이미 쓴 금액보다 낮은 상한으로 재개하면 즉시 중단, 올리면 새 승인", () => {
  const base: RunMeta = {
    metaVersion: 1,
    stage: "pilot",
    protocolVersion: CRITERIA.protocolVersion,
    criteriaHash: criteriaHash(),
    fixtureHashes: {},
    arms: ["A"],
    repetitions: 1,
    seed: 1,
    executorModelId: "e",
    reviewerModelId: "r",
    approvals: [{ approvedLimitUsd: 30, at: "t", note: "최초" }],
    createdAt: "t",
  };
  const incoming = {
    stage: "pilot",
    protocolVersion: CRITERIA.protocolVersion,
    criteriaHash: criteriaHash(),
    fixtureHashes: {},
    arms: ["A"],
    repetitions: 1,
    seed: 1,
    executorModelId: "e",
    reviewerModelId: "r",
  };

  const below = checkCompatibility(base, incoming, { approvedLimitUsd: 5, alreadySpentUsd: 9 });
  assert.equal(below.budgetBelowSpent, true);
  assert.equal(below.ok, false, "이미 쓴 금액보다 낮은 상한으로 재개를 허용했습니다");

  // 낮추되 아직 여유가 있으면 허용한다 — 더 조심하겠다는 뜻이므로.
  const lowered = checkCompatibility(base, incoming, { approvedLimitUsd: 20, alreadySpentUsd: 9 });
  assert.equal(lowered.ok, true);
  assert.equal(lowered.budgetRaised, false);

  const raised = checkCompatibility(base, incoming, { approvedLimitUsd: 50, alreadySpentUsd: 9 });
  assert.equal(raised.budgetRaised, true, "상한 상향이 새 승인으로 기록되지 않습니다");
});

test("13c. 잘린 마지막 줄 복구 규칙이 유지된다", () => {
  withDir((dir) => {
    const file = path.join(dir, RECORDS_FILE);
    writeFileSync(file, `${JSON.stringify(sampleRecord("f1", "A", 1))}\n{"partial":`);
    const store = openRecordStore(file);
    assert.equal(store.count(), 1, "잘린 줄 때문에 멀쩡한 기록을 잃었습니다");
  });
});

// ---- 14·15·16. Run Card (단계별) ----

function buildCards(p0?: number, p1?: number) {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  return buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    ...(p0 !== undefined ? { p0ApprovedLimitUsd: p0 } : {}),
    ...(p1 !== undefined ? { p1ApprovedLimitUsd: p1 } : {}),
    // 자격증명 존재 여부를 주입한다 — 개발자 머신에 키가 있는지에 따라 결과가 달라지면
    // 이 테스트는 아무것도 보장하지 않는다.
    models: planModels({ credentialPresence: () => true }),
    generatedAt: "2026-07-29T00:00:00Z",
    joinPath: (a, b) => `${a}/${b}`,
  });
}

test("14. Run Card에 자격증명이 없다", () => {
  const cards = buildCards(30, 300);
  for (const card of [cards.p0, cards.p1]) {
    const serialized = JSON.stringify(card);
    assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(serialized), "카드에 키처럼 보이는 값이 있습니다");
    // 환경변수 값이 통째로 실리지 않는다 — 이름조차 필요 없다.
    assert.ok(!serialized.includes("OPENAI_API_KEY"), serialized.slice(0, 200));
    assert.ok(!serialized.includes("ANTHROPIC_API_KEY"));
    assert.ok(!serialized.includes(process.env.PATH ?? "@@none@@"));
    // 계획서이지 결과가 아니므로 성공률이 없다.
    assert.ok(!serialized.includes("passRate"), "계획서에 성공률이 들어 있습니다");
    assert.equal(card.realApiCalls, 0);
  }
});

test("15. P1 카드가 executor-only가 아니라 진짜 총 호출 상한을 말한다", () => {
  const p1 = buildCards(30, 300).p1.stage;
  assert.equal(p1.stage, "pilot");
  assert.equal(p1.plannedRecords, 96, "fixture 24 × arm 4 × 반복 1 = 96이어야 합니다");

  // 내역은 arm 정의와 루프 상한에서 유도된다 — 상수를 적어두지 않는다.
  const expected = ARMS.reduce(
    (acc, spec) => {
      const calls = maxCallsPerRecord(spec.arm, spec.providers.length);
      return { executor: acc.executor + calls.executor * 24, reviewer: acc.reviewer + calls.reviewer * 24 };
    },
    { executor: 0, reviewer: 0 }
  );
  assert.equal(p1.maxExecutorCalls, expected.executor);
  assert.equal(p1.maxReviewerCalls, expected.reviewer);
  // **핵심**: "최대"라고 부르는 값은 executor만 센 값이 아니라 전부 더한 값이다.
  assert.equal(p1.maxProviderCallsTotal, expected.executor + expected.reviewer);
  assert.ok(p1.maxProviderCallsTotal > p1.maxExecutorCalls, "총 상한이 executor 내역보다 크지 않습니다");

  // 렌더링에서도 총 상한이 먼저 나오고, executor 수치가 "최대"로 표시되지 않는다.
  const rendered = renderRunCard(buildCards(30, 300).p1).join("\n");
  assert.ok(rendered.includes(`최대 provider 호출 수(총 상한): ${p1.maxProviderCallsTotal}회`), rendered);
  assert.ok(!rendered.includes(`최대 provider 호출 수: ${p1.maxExecutorCalls}회`), "executor 수치를 최대라고 불렀습니다");
});

test("16. P0 smoke는 8건이고 TypeScript/Rust를 하나씩 쓴다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const smoke = selectSmokeFixtures(fixtures);
  assert.equal(smoke.length, 2);
  assert.deepEqual(
    smoke.map((f) => f.manifest.language).sort(),
    ["rust", "typescript"],
    "Rust fixture는 다른 실패 모드를 가지므로 smoke에 반드시 들어가야 합니다"
  );

  const cards = buildCards(30, 300);
  assert.equal(cards.p0.stage.stage, "smoke");
  assert.equal(cards.p0.stage.plannedRecords, 8, "fixture 2 × arm 4 × 반복 1 = 8");
  assert.ok(cards.p0.stage.maxCostUsd !== undefined && cards.p1.stage.maxCostUsd !== undefined);
  assert.ok(cards.p0.stage.maxCostUsd < cards.p1.stage.maxCostUsd);
});

test("16b. P0와 P1은 카드·승인·출력 디렉터리가 분리된다", () => {
  // 승인 하나가 두 단계를 덮으면 "P0가 정상일 때만 P1"이 절차로 성립하지 않는다.
  const cards = buildCards(30, 300);
  assert.notEqual(cards.p0.outputDir, cards.p1.outputDir);
  assert.equal(cards.p0.approvedLimitUsd, 30);
  assert.equal(cards.p1.approvedLimitUsd, 300);
  assert.notEqual(cards.p0.stage.stage, cards.p1.stage.stage);
  // 실행 명령이 자기 단계와 자기 디렉터리를 가리킨다.
  assert.ok(cards.p0.runCommand.includes("--stage smoke"), cards.p0.runCommand);
  assert.ok(cards.p0.runCommand.includes(cards.p0.outputDir), cards.p0.runCommand);
  assert.ok(cards.p1.runCommand.includes("--stage pilot"), cards.p1.runCommand);
  assert.ok(cards.p1.runCommand.includes(cards.p1.outputDir), cards.p1.runCommand);
  // P1에는 선행 조건이 붙는다 — P0 결과를 확인하지 않고 승인하지 않도록.
  assert.ok((cards.p1.prerequisites ?? []).some((p) => p.includes("P0")), JSON.stringify(cards.p1.prerequisites));
  assert.equal(cards.p0.prerequisites, undefined);
  // --stage 조합이 명령과 맞지 않으면 파싱에서 막힌다.
  assert.throws(() => parseArgs(["run", "--stage", "smoke"], "/o"), OptionError);
  assert.throws(() => parseArgs(["pilot", "--stage", "confirmatory"], "/o"), OptionError);
  assert.equal(parseArgs(["pilot", "--stage", "smoke"], "/o").stage, "smoke");
});

test("16c. 승인 상한이 한 건도 감당 못 하면 BLOCKED다", () => {
  const cards = buildCards(0.01, 300);
  assert.equal(cards.p0.status, "BLOCKED");
  assert.ok(cards.p0.blockers.some((b) => b.includes("예약할 수 없습니다")), cards.p0.blockers.join("\n"));
});

test("16d. 단계별 비용 상한이 없는 카드는 승인 대상이 아니다", () => {
  const cards = buildCards(undefined, undefined);
  for (const card of [cards.p0, cards.p1]) {
    assert.equal(card.status, "BLOCKED");
    assert.ok(card.blockers.some((b) => b.includes("--max-cost-usd")), card.blockers.join("\n"));
  }
});

test("16e. 오프라인 사실만으로는 READY_FOR_PAID_RUN이 되지 않는다", () => {
  // 예전에는 "레지스트리에 있으므로 사용 가능"이 승인 조건을 만족시켰다.
  const cards = buildCards(30, 300);
  for (const card of [cards.p0, cards.p1]) {
    assert.equal(card.status, "READY_FOR_MODEL_PROBE", card.blockers.join("\n"));
    assert.ok(card.nextAction.includes("probe-models"), card.nextAction);
    assert.ok(card.probeGaps.length > 0, "실제 확인이 필요한 항목이 하나도 없습니다");
  }
  // 카드 어디에도 "레지스트리에 있으므로 사용 가능"류의 표현이 없다.
  const rendered = renderRunCard(cards.p0).join("\n");
  assert.ok(!/사용가능=yes/.test(rendered), rendered);
});

// ---- 17·18. fake/pilot 결과로 PASS 불가 ----

test("17. fake 기록만으로는 PASS가 나오지 않는다", () => {
  const records: GateRunRecord[] = [];
  for (let i = 0; i < 30; i += 1) {
    for (const arm of ["A", "B", "C", "D"] as const) {
      const record = sampleRecord(`f${i}`, arm, 1);
      record.providerKind = "fake";
      record.oracleVerificationPassed = arm === "C" || arm === "D";
      records.push(record);
    }
  }
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.notEqual(evaluation.verdict, "PASS", "fake 기록으로 PASS를 냈습니다");
  assert.equal(evaluation.verdict, "INCONCLUSIVE");
});

test("18. pilot(반복 1회) 기록으로는 PASS가 나오지 않는다", () => {
  // 판정 기준 2번이 fixture당 3회 반복을 요구한다 — 반복 1회는 구조적으로 부족하다.
  const records: GateRunRecord[] = [];
  for (let i = 0; i < 24; i += 1) {
    for (const arm of ["A", "B", "C", "D"] as const) {
      const record = sampleRecord(`f${i}`, arm, 1);
      record.providerKind = "real";
      record.costUsd = 0.01;
      record.oracleVerificationPassed = arm === "C" || arm === "D";
      records.push(record);
    }
  }
  const evaluation = evaluateGate(records, { seed: 1 });
  assert.notEqual(evaluation.verdict, "PASS", "반복 1회로 PASS를 냈습니다");
});

// ---- 19. 실제 provider 없이 전부 돈다 ----

test("19. 이 파일의 모든 테스트가 실제 공급자 키 없이 돈다", () => {
  // 키가 있어도 쓰지 않는다는 것을 구조로 확인한다: 이 파일은 provider 어댑터를 import하지 않는다.
  const source = readFileSync(new URL(import.meta.url), "utf8");
  assert.ok(!/providers\/(openai|anthropic)/.test(source), "테스트가 provider 어댑터를 직접 import합니다");
  assert.ok(!/api\.openai\.com|api\.anthropic\.com/.test(source), "테스트에 실제 엔드포인트가 있습니다");
});

test("19b. 비용 추정은 순수 함수이므로 네트워크 없이 검증된다", () => {
  const executor = modelEntry({ modelId: "e", providerId: "openai" });
  const reviewer = modelEntry({ modelId: "r", providerId: "anthropic" });

  // in $1/M × 100k입력 상한(모델 max 100k) + out $2/M × 10k = 0.1 + 0.02 = 0.12
  const perCall = maxCallCostUsd(executor, { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 });
  // 금액 비교에서 정확한 이진 표현을 기대하면 안 된다 — 근사로 본다.
  assert.ok(perCall !== undefined && Math.abs(perCall - 0.12) < 1e-9, `모델 상한으로 잘라내지 않았습니다: ${perCall}`);

  const calls = maxCallsPerRecord("C", 2);
  assert.deepEqual(calls, { executor: 4, reviewer: 3 });
  const estimate = estimateRecordCost(executor, reviewer, calls, 1_000_000);
  assert.ok(estimate);
  assert.ok(Math.abs(estimate.maxUsd - (0.12 * 4 + 0.12 * 3)) < 1e-9, String(estimate.maxUsd));
  assert.ok(estimate.basis.includes("어댑터가 실제 요청하는 값"), estimate.basis);

  // 가격을 모르면 undefined — 0으로 대체하지 않는다.
  const broken = modelEntry({
    modelId: "x",
    providerId: "openai",
    economics: { inputPerMTok: Number.NaN, outputPerMTok: 1, pricingAsOf: "t" },
  });
  assert.equal(maxCallCostUsd(broken, { maxInputTokens: 1, maxOutputTokens: 1 }), undefined);
  assert.equal(estimateRecordCost(broken, reviewer, calls), undefined);
});

// ---- 공용 ----

function sampleRecord(fixtureId: string, arm: "A" | "B" | "C" | "D", repetition: number): GateRunRecord {
  const now = "2026-07-29T00:00:00Z";
  return {
    schemaVersion: 1,
    runId: "test",
    fixtureId,
    fixtureHash: "hash1",
    category: "multi_file_contract",
    repetition,
    arm,
    seed: 1,
    taskId: `t-${fixtureId}-${arm}`,
    providerId: "openai",
    requestedModelId: "gpt-4.1",
    publicVerificationPassed: false,
    oracleVerificationPassed: false,
    inputTokens: 0,
    outputTokens: 0,
    providerCallCount: 0,
    retryCount: 0,
    latencyMs: 1,
    changedFiles: [],
    policyDenials: [],
    promptVersionHash: "p",
    startedAt: now,
    completedAt: now,
    providerKind: "real",
    criteriaHash: criteriaHash(),
  };
}

// ---- 출력 토큰 상한: 추정과 실제 요청이 갈라지면 안 된다 ----

test("20. 어댑터가 모델 최대치가 아니라 공용 상한을 요청한다", () => {
  // 어댑터가 `entry.capabilities.maxOutputTokens`를 그대로 넘기면 비용 상한이 그 값에
  // 지배된다(P1에서 출력이 약 85%였다). 상한을 한 곳에 두고 어댑터와 추정기가 같은 것을
  // 읽어야 예약이 실제 청구와 맞는다 — 한쪽만 바꾸면 조용히 어긋난다.
  // dist/test → dist → hypothesis-gate → evals → 저장소 루트 (네 단계다).
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  for (const file of ["openai.ts", "anthropic.ts"]) {
    const source = readFileSync(path.join(root, "packages", "sidecar", "src", "providers", file), "utf8");
    assert.ok(
      /max_(?:output_)?tokens:\s*effectiveMaxOutputTokens\(/.test(source),
      `${file}이 공용 상한을 쓰지 않습니다 — 추정과 실제 요청이 갈라집니다`
    );
    assert.ok(
      !/max_(?:output_)?tokens:\s*this\.entry\.capabilities\.maxOutputTokens/.test(source),
      `${file}이 모델 최대치를 그대로 요청합니다`
    );
  }
});

test("20b. 공용 상한이 모델 최대치보다 작을 때만 잘라낸다", () => {
  const big = modelEntry({ modelId: "big", providerId: "openai" });
  big.capabilities.maxOutputTokens = 64_000;
  assert.equal(effectiveMaxOutputTokens(big), MAX_OUTPUT_TOKENS_PER_CALL);

  // 모델이 우리 상한보다 작으면 모델 쪽을 따른다 — 요청할 수 없는 값을 보내면 오류가 난다.
  const small = modelEntry({ modelId: "small", providerId: "openai" });
  small.capabilities.maxOutputTokens = 8_192;
  assert.equal(effectiveMaxOutputTokens(small), 8_192);
});

test("20c. 비용 추정이 실제 요청값을 쓴다", () => {
  const executor = modelEntry({ modelId: "e", providerId: "openai" });
  executor.capabilities.maxOutputTokens = 64_000;
  const reviewer = modelEntry({ modelId: "r", providerId: "anthropic" });
  reviewer.capabilities.maxOutputTokens = 64_000;

  const estimate = estimateRecordCost(executor, reviewer, maxCallsPerRecord("C", 2));
  assert.ok(estimate);
  // 추정이 모델 최대치(64,000)를 썼다면 이 값보다 훨씬 커진다.
  const perCallWithCap = maxCallCostUsd(executor, {
    maxInputTokens: 60_000,
    maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
  });
  assert.ok(perCallWithCap !== undefined);
  assert.ok(
    estimate.maxUsd < perCallWithCap * 8,
    `추정이 공용 상한을 반영하지 않았습니다: $${estimate.maxUsd}`
  );
  assert.ok(estimate.basis.includes("어댑터가 실제 요청하는 값"), estimate.basis);
});

test("20d. 모든 arm이 같은 출력 상한을 쓴다 (비교를 왜곡하지 않는다)", () => {
  // arm마다 다른 상한을 주면 A와 C/D의 비교에 교란 변수가 들어간다.
  const openai = modelEntry({ modelId: "e", providerId: "openai" });
  const anthropic = modelEntry({ modelId: "r", providerId: "anthropic" });
  assert.equal(effectiveMaxOutputTokens(openai), effectiveMaxOutputTokens(anthropic));
});

// ---------------------------------------------------------------------------
// 21~29. 재개 시 예산 복구 (§1)
//
// 여기서 검증하는 것은 한 문장이다: **재시작이 승인 상한을 늘리지 않는다.**
// 예전에는 재개할 때 원장을 `createBudgetLedger(limit)`로 새로 만들었고 `committed`가 0에서
// 시작했다. $25 한도에서 $20을 쓴 뒤 재개하면 $25를 더 쓸 수 있었다는 뜻이고, 그러면
// "승인 상한"이라는 말이 아무것도 뜻하지 않는다.
//
// 그래서 메타데이터가 호환된다는 것만 확인하지 않는다 — **실제 예약 결과와 provider 호출
// 횟수**를 본다. 호환성 검사는 통과하면서 돈이 새는 조합이 바로 이 결함이었다.
// ---------------------------------------------------------------------------

/** 유료 호출을 실제로 한 기록 하나. 복구 함수가 세는 것과 같은 모양이어야 한다. */
function paidRecord(fixtureId: string, arm: "A" | "B" | "C" | "D", repetition: number, costUsd: number | undefined): GateRunRecord {
  return { ...sampleRecord(fixtureId, arm, repetition), providerCallCount: 1, ...(costUsd !== undefined ? { costUsd } : {}) };
}

test("21. 이전 지출을 복원한 원장은 남은 금액만 예약을 승인한다", () => {
  // 한도 $25, 이전 실행에서 확정 $20 → 남은 것은 $5뿐이다.
  const records = [paidRecord("f1", "A", 1, 12), paidRecord("f2", "A", 1, 8)];
  const recovered = recoverSpendFromRecords(records);
  assert.ok(recovered.ok);
  if (!recovered.ok) return;
  assert.equal(recovered.spend.historicalUsd, 20);

  const ledger = createBudgetLedger(25, { initialCommittedUsd: recovered.spend.historicalUsd });
  assert.equal(ledger.historicalCommittedUsd(), 20);
  assert.equal(ledger.availableUsd(), 5);

  const tooBig = ledger.reserve({ maxUsd: 6, basis: "테스트" }, "over");
  assert.equal(tooBig.ok, false, "$25 한도에서 $20을 쓴 뒤 $6 예약이 승인됐습니다");
  if (!tooBig.ok) {
    assert.ok(tooBig.reason.includes("이전 $20.0000"), tooBig.reason);
    assert.equal(tooBig.availableUsd, 5);
  }

  const fits = ledger.reserve({ maxUsd: 5, basis: "테스트" }, "fits");
  assert.equal(fits.ok, true, "남은 금액과 같은 $5 예약이 거부됐습니다");
});

test("22. 정산 후 재시작해도 누적이 상한을 넘지 못한다", () => {
  // 1회차: 한도 $25에서 $20을 쓴다.
  const first = createBudgetLedger(25, { initialCommittedUsd: 0 });
  const r1 = first.reserve({ maxUsd: 20, basis: "b" }, "one");
  assert.ok(r1.ok);
  if (!r1.ok) return;
  r1.reservation.settle(20);
  assert.equal(first.cumulativeCommittedUsd(), 20);

  // 2회차: 같은 승인 상한으로 재개한다. 복원값을 넘기므로 남은 것은 $5다.
  const resumed = createBudgetLedger(25, { initialCommittedUsd: first.cumulativeCommittedUsd() });
  const r2 = resumed.reserve({ maxUsd: 5, basis: "b" }, "two");
  assert.ok(r2.ok);
  if (!r2.ok) return;
  r2.reservation.settle(5);

  assert.equal(resumed.cumulativeCommittedUsd(), 25);
  assert.equal(resumed.availableUsd(), 0);
  // 누적이 상한과 같아졌으므로 아무리 작은 금액도 더 예약되지 않는다.
  assert.equal(resumed.reserve({ maxUsd: 0.01, basis: "b" }, "three").ok, false);
});

test("23. 이전 지출이 상한과 같으면 provider를 한 번도 부르지 않는다", async () => {
  await withDirAsync(async (dir) => {
    const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT).slice(0, 2));
    const store = openRecordStore(path.join(dir, RECORDS_FILE));
    const ledger = createBudgetLedger(25, { initialCommittedUsd: 25 });

    // 비용 추정이 불린 횟수를 센다. 예약 시도조차 없어야 한다 —
    // "예약에서 거부된다"와 "시작조차 하지 않는다"는 다른 사실이고, 후자여야 한다.
    let estimateCalls = 0;
    const result = await runExperiment({
      fixtures,
      arms: ["A"],
      repetitions: 1,
      seed: 1,
      store,
      runId: "exhausted-test",
      ledger,
      historicalSpentUsd: 25,
      maxCostUsd: 25,
      estimateRecordCostUsd: () => {
        estimateCalls += 1;
        return { maxUsd: 1, basis: "테스트" };
      },
      realProvider: true,
    });

    assert.equal(result.executed, 0, "예산을 다 쓴 상태에서 유료 호출이 실행됐습니다");
    assert.equal(store.count(), 0, "기록이 생겼다는 것은 host를 띄웠다는 뜻입니다");
    assert.equal(estimateCalls, 0, "예약을 시도했습니다 — 시작 전에 멈춰야 합니다");
    assert.equal(result.budgetExhausted, true);
    assert.equal(ledger.snapshot().reservationsOpened, 0);

    // 지출 보고가 session/cumulative를 구별한다.
    assert.equal(result.historicalSpentUsd, 25);
    assert.equal(result.sessionSpentUsd, 0);
    assert.equal(result.cumulativeSpentUsd, 25);
    assert.equal(result.availableUsd, 0);
  });
});

test("24. 이미 쓴 금액보다 낮은 상한으로는 시작하지 않는다", () => {
  // $20을 쓴 실행에 $19를 승인하면 새 호출이 불가능하다 — 그 사실을 시작 전에 말한다.
  const blocked = approvalCoversHistorical(19, 20);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.reason.includes("이하입니다"), blocked.reason);

  // 같은 값도 막는다 — 남은 금액이 0이면 어떤 예약도 성립하지 않는다.
  assert.equal(approvalCoversHistorical(20, 20).ok, false);
  assert.equal(approvalCoversHistorical(20.01, 20).ok, true);
  // 상한이 없는 실행(fake/dry-run)에는 적용되지 않는다.
  assert.equal(approvalCoversHistorical(undefined, 20).ok, true);

  // 그리고 원장 자체도 이 상태에서 아무것도 승인하지 않는다.
  const ledger = createBudgetLedger(19, { initialCommittedUsd: 20 });
  assert.ok(ledger.availableUsd() < 0);
  assert.equal(ledger.reserve({ maxUsd: 0.01, basis: "b" }, "x").ok, false);
});

test("25. 비용을 확정할 수 없는 유료 기록이 있으면 재개를 막는다 (fail closed)", () => {
  // 유료 호출을 했는데 비용이 없는 기록 — 얼마를 썼는지 모른다.
  const missing = recoverSpendFromRecords([paidRecord("f1", "A", 1, undefined)]);
  assert.equal(missing.ok, false, "비용을 모르는 유료 기록으로 재개가 허용됐습니다");
  if (!missing.ok) assert.ok(missing.reasons.some((r) => r.includes("비용이 기록되지 않았습니다")), missing.reasons.join(" / "));

  // NaN / Infinity / 음수 — 어느 것도 0으로 대체하지 않는다.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const outcome = recoverSpendFromRecords([paidRecord("f1", "A", 1, bad)]);
    assert.equal(outcome.ok, false, `${bad}가 통과했습니다`);
  }

  // 비용을 잴 수 없어 중단된 기록(cost_unmeasurable)도 재개를 막는다.
  const unmeasurable: GateRunRecord = { ...paidRecord("f1", "A", 1, undefined), failureClass: "cost_unmeasurable" };
  const blocked = recoverSpendFromRecords([unmeasurable]);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.reasons.some((r) => r.includes("cost_unmeasurable")), blocked.reasons.join(" / "));

  // 같은 조합이 두 번 있으면 합계를 신뢰할 수 없다.
  const dup = recoverSpendFromRecords([paidRecord("f1", "A", 1, 1), paidRecord("f1", "A", 1, 1)]);
  assert.equal(dup.ok, false);
});

test("26. 세 번 재개해도 승인 총액을 넘지 않는다", () => {
  // 승인 $10, 한 기록의 보수적 최대 비용 $3, 실제도 $3이라고 가정한다.
  const APPROVED = 10;
  const records: GateRunRecord[] = [];
  let sessions = 0;

  for (let round = 1; round <= 3; round += 1) {
    const recovered = recoverSpendFromRecords(records);
    assert.ok(recovered.ok, `${round}회차 복원 실패`);
    if (!recovered.ok) return;
    // 상한을 감당하지 못하면 그 회차는 시작하지 않는다(CLI가 하는 판정과 같은 함수).
    if (!approvalCoversHistorical(APPROVED, recovered.spend.historicalUsd).ok) break;

    const ledger = createBudgetLedger(APPROVED, { initialCommittedUsd: recovered.spend.historicalUsd });
    sessions += 1;
    // 예약이 거부될 때까지 돈다 — 실제 실행이 하는 것과 같다.
    for (let i = 0; i < 10; i += 1) {
      const outcome = ledger.reserve({ maxUsd: 3, basis: "회차 추정" }, `r${round}-${i}`);
      if (!outcome.ok) break;
      outcome.reservation.settle(3);
      records.push(paidRecord(`f${round}-${i}`, "A", round, 3));
    }
    assert.ok(
      ledger.cumulativeCommittedUsd() <= APPROVED,
      `${round}회차에서 누적 $${ledger.cumulativeCommittedUsd()}가 승인 $${APPROVED}를 넘었습니다`
    );
  }

  const total = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  assert.equal(sessions, 3, "세 회차가 모두 시작되지 않았습니다");
  assert.ok(total <= APPROVED, `전체 누적 $${total}가 승인 $${APPROVED}를 넘었습니다`);
  // $3 단위이므로 $9에서 멈춘다 — 남은 $1로는 $3을 예약할 수 없다.
  assert.equal(total, 9);
});

test("27. 승인 상향과 예약 이력이 append-only로 남는다", () => {
  withDir((dir) => {
    const sink = createBudgetEventSink(dir);
    const ledger = createBudgetLedger(10, {
      initialCommittedUsd: 2,
      runId: "run-1",
      stage: "pilot",
      onEvent: sink,
      now: () => "2026-07-30T00:00:00Z",
    });
    const r = ledger.reserve({ maxUsd: 1, basis: "b" }, "one");
    assert.ok(r.ok);
    if (!r.ok) return;
    r.reservation.settle(0.5);
    ledger.recordApprovalRaised(20, "사용자 승인");
    ledger.recordBlocked("테스트 차단");

    const events = readBudgetEvents(dir);
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "approval_created",
        "reservation_opened",
        "reservation_settled",
        "provider_usage_recorded",
        "approval_raised",
        "run_blocked",
      ]
    );
    // 상향은 사실로만 남고 이 원장의 상한을 바꾸지 않는다 — 새 상한은 새 원장이 받는다.
    assert.equal(ledger.approvedLimitUsd, 10);
    for (const event of events) {
      assert.equal(event.runId, "run-1");
      assert.equal(event.stage, "pilot");
      assert.equal(event.approvedLimitUsd, 10);
      // 자격증명이 이벤트에 실리면 저장·공유되는 순간 유출이다.
      assert.ok(!JSON.stringify(event).includes("sk-"), JSON.stringify(event));
    }
    // 누적이 이벤트에 함께 남아야 사후에 설명할 수 있다.
    assert.equal(events[events.length - 1]!.cumulativeUsd, 2.5);

    // 두 번째 원장이 같은 디렉터리에 써도 앞의 이벤트를 덮지 않는다.
    const before = events.length;
    createBudgetLedger(10, { initialCommittedUsd: 2.5, runId: "run-2", stage: "pilot", onEvent: createBudgetEventSink(dir) });
    const after = readBudgetEvents(dir);
    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1]!.runId, "run-2");
  });
});

test("27b. 8가지 예산 이벤트가 모두 필수 필드를 갖고 남는다", () => {
  // 감사 추적이 목적이므로 "어느 실행의, 어떤 승인 아래, 그 시점 누적이 얼마였는가"가
  // 모든 이벤트에 있어야 한다. 하나라도 빠지면 사후에 설명할 수 없다.
  withDir((dir) => {
    const sink = createBudgetEventSink(dir);
    const ledger = createBudgetLedger(10, { runId: "run-x", stage: "smoke", onEvent: sink, now: () => "T" });

    const released = ledger.reserve({ maxUsd: 1, basis: "b" }, "released");
    assert.ok(released.ok);
    if (!released.ok) return;
    released.reservation.release();

    // 실제가 예약을 넘으면 추정이 틀렸다는 사실이 남고, 이후 예약이 차단된다.
    const breached = ledger.reserve({ maxUsd: 1, basis: "b" }, "breached");
    assert.ok(breached.ok);
    if (!breached.ok) return;
    breached.reservation.settle(3);
    assert.equal(ledger.estimateBreached(), true);
    assert.equal(ledger.reserve({ maxUsd: 0.01, basis: "b" }, "after").ok, false);

    ledger.recordApprovalRaised(20, "사용자 승인");

    const events = readBudgetEvents(dir);
    const types = new Set(events.map((e) => e.type));
    for (const required of [
      "approval_created",
      "approval_raised",
      "reservation_opened",
      "reservation_released",
      "reservation_settled",
      "provider_usage_recorded",
      "budget_estimate_breached",
      "run_blocked",
    ] as const) {
      assert.ok(types.has(required), `${required} 이벤트가 없습니다: ${[...types].join(",")}`);
    }
    for (const event of events) {
      assert.equal(typeof event.at, "string");
      assert.equal(event.runId, "run-x");
      assert.equal(event.stage, "smoke");
      assert.equal(event.approvedLimitUsd, 10);
      assert.equal(typeof event.cumulativeUsd, "number");
    }
    // 예약/정산/초과가 같은 correlationId로 이어진다 — 어느 호출의 이야기인지 알 수 있다.
    const breachEvent = events.find((e) => e.type === "budget_estimate_breached");
    assert.ok(breachEvent?.correlationId?.startsWith("breached"), JSON.stringify(breachEvent));
    assert.equal(breachEvent?.reservedUsd, 1);
    assert.equal(breachEvent?.actualUsd, 3);
  });
});

test("28. fake 기록은 유료 사용액으로 세지 않는다", () => {
  const fake: GateRunRecord = { ...paidRecord("f1", "A", 1, 0), providerKind: "fake" };
  const outcome = recoverSpendFromRecords([fake, paidRecord("f2", "A", 1, 3)]);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.spend.historicalUsd, 3, "fake 기록이 유료 사용액에 섞였습니다");
  assert.equal(outcome.spend.fakeRecords, 1);
  assert.equal(outcome.spend.countedRecords, 1);

  // 다만 fake에 0이 아닌 비용이 적혀 있으면 그건 조용히 넘길 일이 아니다.
  const weird: GateRunRecord = { ...paidRecord("f3", "A", 1, 5), providerKind: "fake" };
  assert.equal(recoverSpendFromRecords([weird]).ok, false);
});

test("29. 예산 이벤트와 기록 합계가 다르면 재개하지 않는다", () => {
  withDir((dir) => {
    const sink = createBudgetEventSink(dir);
    const ledger = createBudgetLedger(10, { runId: "r", stage: "pilot", onEvent: sink });
    const r = ledger.reserve({ maxUsd: 2, basis: "b" }, "one");
    assert.ok(r.ok);
    if (!r.ok) return;
    r.reservation.settle(2);

    const events = readBudgetEvents(dir);
    // 기록 파일이 같은 값을 말하면 재개할 수 있다.
    assert.equal(reconcile(2, events).ok, true);
    // 다르면 어느 쪽이 맞는지 코드가 알 수 없다 — 한쪽을 골라 계속하지 않는다.
    const mismatch = reconcile(0, events);
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.ok(mismatch.reason.includes("다릅니다"), mismatch.reason);

    // 이벤트 파일이 아예 없는 것은 불일치가 아니다(이 기능 이전에 만든 실행 디렉터리).
    assert.equal(reconcile(2, []).ok, true);
  });
});

// ---------------------------------------------------------------------------
// 30~36. probe-models (§3)
//
// **이 블록은 실제 공급자를 부르지 않는다.** `ProbeTransport`를 mock으로 채워
// probeModels()의 결정만 검증한다 — `probeTransport.ts`(실제 네트워크로 나가는 유일한 파일)를
// import조차 하지 않으므로, `npm test`가 실수로 유료 API를 부를 경로가 없다.
// ---------------------------------------------------------------------------

function probeEntry(modelId: string, providerId: string): ModelEntry {
  return modelEntry({ modelId, providerId });
}

function offlineReadiness(entry: ModelEntry): ModelReadiness {
  return withCredentialPresence(registryReadiness(entry, { checkedAt: "T0" }), true);
}

interface MockTransportLog {
  calls: { role: ProbeRole; modelId: string }[];
}

function mockTransport(
  outcomes: Partial<Record<ProbeRole, RoleProbeOutcome | Error>>,
  log: MockTransportLog
): ProbeTransport {
  return {
    async probe(role, entry) {
      log.calls.push({ role, modelId: entry.modelId });
      const outcome = outcomes[role];
      if (outcome === undefined) throw new Error(`mock에 ${role} 결과가 없습니다`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function goodOutcome(modelId: string): RoleProbeOutcome {
  return {
    returnedModelId: modelId,
    usage: { inputTokens: 500, outputTokens: 120 },
    latencyMs: 900,
    structuredOutputOk: true,
    evidence: "필수 필드가 채워짐",
  };
}

function probeInput(
  transport: ProbeTransport,
  overrides: Partial<Parameters<typeof probeModels>[0]> = {}
): Parameters<typeof probeModels>[0] {
  const executor = probeEntry("exec-1", "openai");
  const reviewer = probeEntry("rev-1", "anthropic");
  return {
    roles: [
      { role: "executor", entry: executor, readiness: offlineReadiness(executor) },
      { role: "reviewer", entry: reviewer, readiness: offlineReadiness(reviewer) },
    ],
    maxCostUsd: 5,
    maxConcurrency: 1,
    transport,
    costOfUsage: (modelId, usage) => {
      const entry = modelId === "exec-1" ? executor : reviewer;
      return (
        (usage.inputTokens / 1_000_000) * entry.economics.inputPerMTok +
        (usage.outputTokens / 1_000_000) * entry.economics.outputPerMTok
      );
    },
    now: () => "2026-07-30T00:00:00Z",
    ...overrides,
  };
}

test("30. probe-models는 비용 상한 없이 요청을 보내지 않는다", async () => {
  const log: MockTransportLog = { calls: [] };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: goodOutcome("exec-1") }, log), { maxCostUsd: undefined })
  );
  assert.equal(summary.status, "BLOCKED");
  assert.equal(summary.requestsSent, 0, "상한 없이 요청을 보냈습니다");
  assert.equal(log.calls.length, 0);
  assert.ok(summary.blockers.some((b) => b.includes("--max-cost-usd")), summary.blockers.join("\n"));
  // 우회 옵션이 없다는 것은 CLI 쪽에서도 성립한다.
  assert.throws(
    () => requireCostLimitForPaidRun(parseArgs(["probe-models"], "/o"), false),
    OptionError
  );
});

test("30b. 동시성 1이 아니면 시작하지 않는다", async () => {
  const log: MockTransportLog = { calls: [] };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: goodOutcome("exec-1") }, log), { maxConcurrency: 2 })
  );
  assert.equal(summary.status, "BLOCKED");
  assert.equal(log.calls.length, 0);
});

test("31. 역할당 정확히 한 번만 요청한다", async () => {
  const log: MockTransportLog = { calls: [] };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: goodOutcome("exec-1"), reviewer: goodOutcome("rev-1") }, log))
  );
  assert.equal(summary.status, "READY_FOR_PAID_RUN", summary.blockers.join("\n"));
  assert.equal(summary.requestsSent, 2);
  assert.deepEqual(log.calls, [
    { role: "executor", modelId: "exec-1" },
    { role: "reviewer", modelId: "rev-1" },
  ]);
  // 실제 확인 결과가 준비성의 뒤 축들을 채운다 — 이 경로만이 채울 수 있다.
  for (const r of summary.readiness) {
    assert.equal(r.liveProbeVerified, true);
    assert.equal(r.exactModelIdVerified, true);
    assert.equal(r.source, "live_probe");
    assert.notEqual(r.checkedAt, "T0", "확인 시각이 갱신되지 않았습니다");
  }
});

test("32. 요청 전에 예약하고, 예약할 수 없으면 부르지 않는다", async () => {
  const log: MockTransportLog = { calls: [] };
  const events: BudgetEvent[] = [];
  // 예약 금액보다 작은 상한을 주면 첫 요청도 나가지 않는다.
  const summary = await probeModels(
    probeInput(mockTransport({ executor: goodOutcome("exec-1") }, log), {
      maxCostUsd: 0.000001,
      onEvent: (e) => events.push(e),
    })
  );
  assert.equal(summary.status, "BLOCKED");
  assert.equal(log.calls.length, 0, "예약 실패인데 요청을 보냈습니다");
  // 예약 시도와 차단이 감사 추적에 남는다.
  assert.ok(events.some((e) => e.type === "run_blocked"), events.map((e) => e.type).join(","));
  assert.ok(!events.some((e) => e.type === "reservation_opened"));
});

test("33. 응답 모델 ID가 요청과 다르면 BLOCKED다 (조용한 대체 금지)", async () => {
  const log: MockTransportLog = { calls: [] };
  const substituted: RoleProbeOutcome = { ...goodOutcome("exec-1"), returnedModelId: "some-other-model" };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: substituted, reviewer: goodOutcome("rev-1") }, log))
  );
  assert.equal(summary.status, "BLOCKED");
  assert.ok(summary.blockers.some((b) => b.includes("조용한 대체")), summary.blockers.join("\n"));
  // 대체가 확인된 뒤에는 다음 역할을 부르지 않는다 — 그리고 다른 모델로 바꿔 재시도하지 않는다.
  assert.deepEqual(log.calls, [{ role: "executor", modelId: "exec-1" }]);
  assert.equal(summary.records[0]!.exactModelIdVerified, false);
  assert.equal(summary.records[0]!.returnedModelId, "some-other-model");
});

test("33b. 실제 호출이 실패하면 다른 모델로 대체하지 않는다", async () => {
  const log: MockTransportLog = { calls: [] };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: new Error("model_not_found"), reviewer: goodOutcome("rev-1") }, log))
  );
  assert.equal(summary.status, "BLOCKED");
  assert.equal(log.calls.length, 1, "실패 후 다른 요청을 보냈습니다");
  assert.equal(summary.records[0]!.liveProbe, "failed");
  assert.ok(summary.records[0]!.failureReason?.includes("model_not_found"));
  assert.equal(summary.readiness[0]!.liveProbeVerified, false);
  // 실패는 확정된 사실이므로 blocker다(미확인이 아니다).
  assert.ok(readinessBlockers(summary.readiness[0]!).some((b) => b.includes("실제 호출이 실패")));
});

test("34. usage가 없거나 비용을 잴 수 없으면 중단한다", async () => {
  const log: MockTransportLog = { calls: [] };
  const noUsage: RoleProbeOutcome = { ...goodOutcome("exec-1"), usage: { inputTokens: 0, outputTokens: 0 } };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: noUsage, reviewer: goodOutcome("rev-1") }, log))
  );
  assert.equal(summary.status, "BLOCKED");
  // 0으로 대체하지 않는다 — actualUsd가 undefined로 남는다.
  assert.equal(summary.records[0]!.actualUsd, undefined);
  assert.equal(summary.actualUsd, 0, "측정 불가를 비용 0으로 합산했습니다");
  assert.ok(summary.blockers.some((b) => b.includes("usage")), summary.blockers.join("\n"));
  assert.equal(log.calls.length, 1, "비용을 못 재는 상태로 다음 요청을 보냈습니다");

  // 가격 정보가 없어 계산이 불가한 경우도 같다.
  const log2: MockTransportLog = { calls: [] };
  const unpriced = await probeModels(
    probeInput(mockTransport({ executor: goodOutcome("exec-1") }, log2), { costOfUsage: () => undefined })
  );
  assert.equal(unpriced.status, "BLOCKED");
  assert.equal(unpriced.records[0]!.actualUsd, undefined);
});

test("35. usage·예약액·실제 비용이 모두 기록된다", async () => {
  const log: MockTransportLog = { calls: [] };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: goodOutcome("exec-1"), reviewer: goodOutcome("rev-1") }, log))
  );
  for (const record of summary.records) {
    assert.equal(record.inputTokens, 500);
    assert.equal(record.outputTokens, 120);
    assert.ok(record.estimatedMaxUsd > 0, "예약 금액이 기록되지 않았습니다");
    assert.ok(record.actualUsd !== undefined && record.actualUsd > 0);
    // 실제는 보수적 최대보다 작아야 한다 — 그래야 예약이 상한을 지킨다는 말이 성립한다.
    assert.ok(record.actualUsd < record.estimatedMaxUsd, `실제 $${record.actualUsd} ≥ 예약 $${record.estimatedMaxUsd}`);
  }
  assert.ok(summary.actualUsd > 0);
  assert.ok(summary.estimatedMaxUsd > summary.actualUsd);
  assert.ok(summary.actualUsd < summary.approvedLimitUsd);
});

test("36. probe 결과는 게이트 기록과 다른 파일에 저장되고 자격증명이 없다", async () => {
  const log: MockTransportLog = { calls: [] };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: goodOutcome("exec-1"), reviewer: goodOutcome("rev-1") }, log))
  );
  withDir((dir) => {
    const written = writeProbeResults(dir, summary);
    assert.ok(written.records.endsWith(PROBE_RECORDS_FILE), written.records);
    assert.ok(!written.records.endsWith(RECORDS_FILE), "게이트 기록 파일에 섞였습니다");
    const text = readFileSync(written.summary, "utf8");
    assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(text), "probe 결과에 키처럼 보이는 값이 있습니다");
    assert.ok(!text.includes("OPENAI_API_KEY"));
    assert.ok(!text.includes(process.env.PATH ?? "@@none@@"));
  });

  // 자격증명처럼 보이는 값이 섞이면 **쓰지 않는다.**
  const poisoned = { ...summary, records: [{ ...summary.records[0]!, evidence: "sk-abcdefghijklmnopqrstuvwxyz" }] };
  withDir((dir) => {
    assert.throws(() => writeProbeResults(dir, poisoned), /비밀값/);
  });
});

// ---------------------------------------------------------------------------
// 37~38. 토큰 상한의 단일 출처와 추정의 완결성 (§6)
// ---------------------------------------------------------------------------

test("37. 출력 상한과 컨텍스트 예산이 한 곳에서만 정의된다", () => {
  // 두 곳에 숫자를 적으면 한쪽만 바뀌고, 그러면 예약이 실제 청구를 감당하지 못한다.
  // dist/test → dist → hypothesis-gate → evals → 저장소 루트 (네 단계다).
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const engine = readFileSync(path.join(root, "packages", "sidecar", "src", "context", "engine.ts"), "utf8");
  assert.ok(
    engine.includes("DEFAULT_CONTEXT_TOKEN_BUDGET"),
    "컨텍스트 엔진이 공용 상수를 읽지 않습니다 — 비용 추정의 입력 상한과 어긋날 수 있습니다"
  );
  assert.ok(
    !/maxTokens\s*\?\?\s*\d/.test(engine),
    "컨텍스트 엔진이 기본 예산을 숫자로 직접 적고 있습니다"
  );
  assert.equal(DEFAULT_CONTEXT_TOKEN_BUDGET, 60_000);
  assert.equal(MAX_OUTPUT_TOKENS_PER_CALL, 16_000);
});

test("38. 비용 추정이 입력과 출력 상한을 모두 반영한다", () => {
  // 한쪽만 세면 예약이 실제보다 작아진다. 두 축이 각각 금액을 움직이는지 확인한다.
  const executor = modelEntry({
    modelId: "e",
    providerId: "openai",
    economics: { inputPerMTok: 10, outputPerMTok: 20, pricingAsOf: "2026-07-01" },
  });
  const calls = { executor: 1, reviewer: 0 };

  const small = estimateRecordCost(executor, undefined, calls, 10_000);
  const large = estimateRecordCost(executor, undefined, calls, 20_000);
  assert.ok(small && large);
  // 입력 예산을 늘리면 추정이 늘어난다 → 입력이 반영되어 있다.
  assert.ok(large.maxUsd > small.maxUsd, `입력 상한이 추정에 반영되지 않았습니다: ${small.maxUsd} → ${large.maxUsd}`);

  // 출력 몫이 실제로 들어 있는지: 입력만 세었다면 10,000/1M × $10 = $0.1이어야 한다.
  const inputOnly = (10_000 / 1_000_000) * 10;
  assert.ok(small.maxUsd > inputOnly, `출력 상한이 추정에 반영되지 않았습니다: ${small.maxUsd}`);
  // 그리고 출력 몫은 공용 상한(모델 최대치가 아니라)으로 계산된다.
  const expected = inputOnly + (effectiveMaxOutputTokens(executor) / 1_000_000) * 20;
  assert.ok(Math.abs(small.maxUsd - expected) < 1e-9, `${small.maxUsd} != ${expected}`);
});
