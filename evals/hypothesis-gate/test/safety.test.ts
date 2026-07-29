import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBudgetLedger, maxCallCostUsd, pricingIsUsable, validateApprovedLimit } from "@tomverse/sidecar/budget";
import type { ModelEntry } from "@tomverse/protocol";
import { criteriaHash, CRITERIA } from "../src/criteria.js";
import { loadAllFixtures, listFixtureIds } from "../src/manifest.js";
import { estimateRecordCost, maxCallsPerRecord, planModels, offlineChecker, isModelPlan } from "../src/models.js";
import { OptionError, parseArgs, parseConcurrency, parseCostLimit, requireCostLimitForPaidRun } from "../src/options.js";
import { openRecordStore } from "../src/records.js";
import { buildRunCard, selectSmokeFixtures } from "../src/runCard.js";
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

const FIXTURES_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "fixtures");

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

test("4b. 조직 인증이 필요한 모델은 '확인되지 않음'으로 막는다", () => {
  // gpt-5 사건: 가용성은 전역 사실이 아니라 자격증명별 사실이다.
  const probe = offlineChecker.probe(
    modelEntry({ modelId: "gpt-x", providerId: "openai", availability: { requiresOrgVerification: true } })
  );
  assert.equal(probe.available, "unknown");
  const plan = planModels({
    entries: [
      modelEntry({ modelId: "gpt-x", providerId: "openai", availability: { requiresOrgVerification: true } }),
      modelEntry({ modelId: "rev", providerId: "anthropic" }),
    ],
    executorModel: "gpt-x",
  });
  assert.ok(plan.blockers.some((b) => b.includes("확인되지 않았습니다")), plan.blockers.join("\n"));
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
  assert.equal(ledger.committedUsd(), 0.25);
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
  assert.equal(ledger.committedUsd(), 3);
});

test("8. 오류·취소·타임아웃 시 예약이 해제되고 장부가 일관된다", () => {
  const ledger = createBudgetLedger(10);
  const outcome = ledger.reserve({ maxUsd: 4, basis: "b" }, "one");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  outcome.reservation.release();
  assert.equal(ledger.reservedUsd(), 0);
  assert.equal(ledger.committedUsd(), 0);
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

// ---- 14·15·16. Run Card ----

function buildCard(approvedLimitUsd?: number) {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  return buildRunCard({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputDir: "/tmp/run",
    ...(approvedLimitUsd !== undefined ? { approvedLimitUsd } : {}),
    models: planModels({}),
    generatedAt: "2026-07-29T00:00:00Z",
  });
}

test("14. Run Card에 자격증명이 없다", () => {
  const card = buildCard(30);
  const serialized = JSON.stringify(card);
  assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(serialized), "카드에 키처럼 보이는 값이 있습니다");
  // 환경변수 값이 통째로 실리지 않는다 — 이름조차 필요 없다.
  assert.ok(!serialized.includes("OPENAI_API_KEY"), serialized.slice(0, 200));
  assert.ok(!serialized.includes("ANTHROPIC_API_KEY"));
  assert.ok(!serialized.includes(process.env.PATH ?? "@@none@@"));
  // 계획서이지 결과가 아니므로 성공률이 없다.
  assert.ok(!serialized.includes("passRate"), "계획서에 성공률이 들어 있습니다");
  assert.equal(card.realApiCalls, 0);
});

test("15. Run Card의 P1 계획 수는 96, 최대 호출 수는 384다", () => {
  const card = buildCard(30);
  const p1 = card.stages.find((s) => s.stage === "pilot");
  assert.ok(p1, "P1 단계가 없습니다");
  assert.equal(p1.plannedRecords, 96, `fixture 24 × arm 4 × 반복 1 = 96이어야 합니다`);
  assert.equal(p1.maxProviderCalls, 384, "96 × 4(초안 1 + fix loop 3) = 384");
  // 검수자 호출을 포함한 상한은 더 크며, 비용 예약은 그쪽을 쓴다.
  assert.ok(
    p1.maxProviderCallsIncludingReviewer > p1.maxProviderCalls,
    "검수자 호출 상한이 executor 상한보다 크지 않습니다"
  );
});

test("16. P0 smoke 계획 수는 8이고 TypeScript/Rust를 하나씩 쓴다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const smoke = selectSmokeFixtures(fixtures);
  assert.equal(smoke.length, 2);
  assert.deepEqual(
    smoke.map((f) => f.manifest.language).sort(),
    ["rust", "typescript"],
    "Rust fixture는 다른 실패 모드를 가지므로 smoke에 반드시 들어가야 합니다"
  );

  const card = buildCard(30);
  const p0 = card.stages.find((s) => s.stage === "smoke");
  assert.ok(p0);
  assert.equal(p0.plannedRecords, 8, "fixture 2 × arm 4 × 반복 1 = 8");
  // P0와 P1은 다른 단계다 — 같은 디렉터리에 섞이면 안 되므로 stage로 구별한다.
  assert.notEqual(p0.stage, card.stages.find((s) => s.stage === "pilot")?.stage);
});

test("16b. 승인 상한이 한 건도 감당 못 하면 BLOCKED다", () => {
  const card = buildCard(0.01);
  assert.equal(card.status, "BLOCKED");
  assert.ok(card.blockers.some((b) => b.includes("예약할 수 없습니다")), card.blockers.join("\n"));
});

test("16c. 비용 상한 없이 만든 카드는 승인 대상이 아니다", () => {
  const card = buildCard(undefined);
  assert.equal(card.status, "BLOCKED");
  assert.ok(card.blockers.some((b) => b.includes("--max-cost-usd")), card.blockers.join("\n"));
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
  assert.ok(estimate.basis.includes("maxOutputTokens"), estimate.basis);

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
