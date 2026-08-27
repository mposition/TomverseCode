import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  type DispatchState,
  type Settlement,
} from "@tomverse/sidecar/budget";
import {
  attemptFacts,
  callWithRetry,
  containsSecretLike,
  createAdapter,
  MissingCredentialError,
  ProviderCallFailed,
  ProviderCallFailure,
  redactSecrets,
  resolveCredential,
} from "@tomverse/sidecar/providers";
import type { ModelEntry } from "@tomverse/protocol";
import {
  analyzeBudgetEvents,
  approvalCoversHistorical,
  budgetStatus,
  createBudgetEventSink,
  readBudgetEvents,
  reconcileBudget,
  recoverSpendFromRecords,
  renderBudgetStatus,
} from "../src/budgetRecovery.js";
import { BUILTIN_MODELS, ModelRegistry, providerModelIdAccepted } from "@tomverse/sidecar/registry";
import { computeCallBudget } from "../src/callBudget.js";
import { criteriaHash, CRITERIA } from "../src/criteria.js";
import { attestP0, validateP0Attestation, type AttestationInput } from "../src/p0Attestation.js";
import {
  buildProbeEvidence,
  computeCredentialBinding,
  validateProbeEvidence,
  writeProbeEvidence,
  type CredentialBinding,
  type ProbeEvidence,
  type RoleEvidence,
} from "../src/probeEvidence.js";
import {
  buildCredentialBinding,
  buildExecutionReceipt,
  credentialBindingMatchesResolved,
  credentialDigest,
  factsOf,
  readExecutionReceipts,
  RECEIPT_CREDENTIAL_PURPOSE,
  reuseOrConflict,
  type ExecutionAuthorizationReceipt,
  type ReceiptFacts,
  type ResolvedProviderCredential,
} from "../src/receipt.js";
import {
  ArtifactConflictError,
  approvalPaths,
  loadApprovalArtifactByPath,
  storeApprovalArtifact,
} from "../src/approvalStore.js";
import { artifactHash, canonicalJson, CanonicalJsonError, verifyArtifactHash } from "../src/canonical.js";
import { diffArgv, executionArgv, executionCliArgv } from "../src/executionRequest.js";
import { createAdapterProbeTransport } from "../src/probeTransport.js";
import { credentialPresent, credentialProblem, preflight } from "../src/preflight.js";
import { quotePowerShellArg } from "../src/shellQuote.js";
import { loadAllFixtures, listFixtureIds, type LoadedFixture } from "../src/manifest.js";
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
  lookupModel,
} from "../src/models.js";
import {
  probeModels,
  PROBE_RECORDS_FILE,
  renderProbeSummary,
  writeProbeResults,
  type ProbeRole,
  type ProbeTransport,
  type RoleProbeOutcome,
} from "../src/probeModels.js";
import { ARMS, modelForRole } from "../src/arms.js";
import { OptionError, parseArgs, parseConcurrency, parseCostLimit, requireCostLimitForPaidRun } from "../src/options.js";
import { openRecordStore } from "../src/records.js";
import {
  authorizeRunCard,
  buildStagedCards,
  loadRunCard,
  renderRunCard,
  cardPointerFileFor,
  selectSmokeFixtures,
  type CardExecutionRequest,
  writeRunCard,
  type RunCard,
  runCardHash,
} from "../src/runCard.js";
import { checkCompatibility, RECORDS_FILE, runDirPaths, type RunMeta } from "../src/runDir.js";
import { classifyDispatch, partitionSettlement, runExperiment } from "../src/runner.js";
import { evaluateGate } from "../src/stats.js";
import type { ArmId, GateRunRecord, ProviderCallFact } from "../src/types.js";

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

/**
 * 정산 인자를 만드는 테스트 헬퍼.
 *
 * `settle(usd)` 하나였던 것을 `Settlement`로 바꾼 이유가 §7이다 — "0달러였다"와 "모른다"를
 * 숫자 하나로는 구별할 수 없었고, NaN/음수가 0으로 정산됐다.
 */
function settlement(usd: number, overrides: Partial<Settlement> = {}): Settlement {
  return {
    cost: { measured: true, usd },
    usage: { measured: true, inputTokens: 100, outputTokens: 50 },
    providerKind: "real",
    dispatchState: "response_received_with_usage",
    ...overrides,
  };
}

/** 이벤트 목록만 필요할 때. 읽기가 실패하면 테스트가 그 자리에서 죽어야 한다. */
function eventsIn(dir: string): BudgetEvent[] {
  const read = readBudgetEvents(dir);
  assert.equal(read.ok, true, read.ok ? "" : read.reasons.join(" / "));
  return read.ok ? read.events : [];
}

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

/**
 * **"막는 요인"이 비었다고 되는 것이 아니다** — preflight는 자격증명 **존재**만 본다.
 *
 * 실측 사례가 이 저장소 개발 환경에 있다: `OPENAI_API_KEY`가 설정되어 있는데 egress 프록시가
 * OpenAI 호스트를 막는다. blocker 목록만 보면 "키 하나만 더 넣으면 된다"로 읽힌다.
 *
 * (호스트 이름을 여기 그대로 적지 않는다 — 아래 19번이 이 파일 소스에서 실제 엔드포인트를
 * 찾으므로, 주석에 적으면 그 테스트가 **내 주석을 잡는다**.)
 */
test("preflight는 확인하지 않은 것을 반드시 함께 낸다", () => {
  const report = preflight({
    fixtureCount: 24,
    arms: ["A", "B", "C"],
    repetitions: 3,
    usingFakeProvider: false,
    msvc: { kind: "not_needed" },
  });
  assert.ok(report.notChecked.length >= 3, JSON.stringify(report.notChecked));
  const joined = report.notChecked.join(" ");
  // 셋은 성질이 다르고 다음에 할 일도 다르다 — 뭉치면 무엇을 고쳐야 하는지 알 수 없다.
  assert.ok(joined.includes("닿는가"), joined);
  assert.ok(joined.includes("모델을 부를 수 있는가"), joined);
  assert.ok(joined.includes("유효한가"), joined);
});

test("확인하지 않은 것 목록은 막는 요인이 없어도 나온다", () => {
  // blocker가 비면 "이제 된다"로 읽히는데, 이 점검은 그 문장을 보증할 수 없다.
  const report = preflight({
    fixtureCount: 24,
    arms: ["A"],
    repetitions: 1,
    usingFakeProvider: true,
    msvc: { kind: "not_needed" },
  });
  assert.equal(report.blockers.length, 0, report.blockers.join(" | "));
  assert.ok(report.notChecked.length >= 3);
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

    // 호스트를 부르지 않고 runner의 중단 경로만 확인하기 위해 **존재하지 않는 바이너리**로
    // 인프라 실패를 만든다. provider 호출이 아예 없으므로 비용이 미측정으로 남는다.
    //
    // 예전에는 이 장치가 주석에만 있었고, 실제 실패는 "자격증명이 없어 공급자 후보가 비었다"로
    // 만들어지고 있었다. 그건 **환경이 검증을 대신 해주는 것**이라 두 가지로 무너진다:
    // 키가 있는 기계에서는 실제 호출이 성공해 중단이 일어나지 않으므로 테스트가 실패하고,
    // 그 실패는 조용한 것이 아니라 **실제 과금**을 동반한다. 게이트를 돌리는 환경은 반드시
    // 키가 있는 환경이므로, 하필 그때만 그렇게 된다.
    const result = await runExperiment({
      hostBin: path.join(dir, "존재하지-않는-호스트"),
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

  outcome.reservation.settle(settlement(0.25));
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
  outcome.reservation.settle(settlement(3));
  assert.equal(ledger.cumulativeCommittedUsd(), 3);
});

test("8. 오류·취소·타임아웃 시 예약이 해제되고 장부가 일관된다", () => {
  const ledger = createBudgetLedger(10);
  const outcome = ledger.reserve({ maxUsd: 4, basis: "b" }, "one");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  outcome.reservation.release({ dispatchState: "not_dispatched", reason: "테스트" });
  assert.equal(ledger.reservedUsd(), 0);
  assert.equal(ledger.cumulativeCommittedUsd(), 0);
  assert.equal(ledger.availableUsd(), 10, "해제 후 예산이 원래대로 돌아오지 않았습니다");

  // 이중 정산은 장부를 망가뜨리므로 막는다.
  assert.throws(() => outcome.reservation.settle(settlement(1)));
  assert.throws(() => outcome.reservation.release({ dispatchState: "not_dispatched", reason: "테스트" }));

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
    credentialsPresent: true,
    createdAt: "2026-07-29T00:00:00Z",
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
  assert.equal(p1.callBudget.executor, expected.executor);
  assert.equal(p1.callBudget.reviewer, expected.reviewer);
  // **핵심**: "최대"라고 부르는 값은 executor만 센 값이 아니라 전부 더한 값이다.
  assert.equal(p1.callBudget.total, expected.executor + expected.reviewer);
  assert.ok(p1.callBudget.total > p1.callBudget.executor, "총 상한이 executor 내역보다 크지 않습니다");

  // 렌더링에서도 총 상한이 먼저 나오고, executor 수치가 "최대"로 표시되지 않는다.
  const rendered = renderRunCard(buildCards(30, 300).p1).join("\n");
  assert.ok(rendered.includes(`최대 provider 호출 수(총 상한): ${p1.callBudget.total}회`), rendered);
  assert.ok(!rendered.includes(`최대 provider 호출 수: ${p1.callBudget.executor}회`), "executor 수치를 최대라고 불렀습니다");
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
  assert.ok(cards.p0.runCommandPowerShell.includes("--stage smoke"), cards.p0.runCommandPowerShell);
  assert.ok(cards.p0.runCommandPowerShell.includes(cards.p0.outputDir), cards.p0.runCommandPowerShell);
  assert.ok(cards.p1.runCommandPowerShell.includes("--stage pilot"), cards.p1.runCommandPowerShell);
  assert.ok(cards.p1.runCommandPowerShell.includes(cards.p1.outputDir), cards.p1.runCommandPowerShell);
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
    providerCalls: [],
    eventsReadable: true,
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
  r1.reservation.settle(settlement(20));
  assert.equal(first.cumulativeCommittedUsd(), 20);

  // 2회차: 같은 승인 상한으로 재개한다. 복원값을 넘기므로 남은 것은 $5다.
  const resumed = createBudgetLedger(25, { initialCommittedUsd: first.cumulativeCommittedUsd() });
  const r2 = resumed.reserve({ maxUsd: 5, basis: "b" }, "two");
  assert.ok(r2.ok);
  if (!r2.ok) return;
  r2.reservation.settle(settlement(5));

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
      outcome.reservation.settle(settlement(3));
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
    r.reservation.settle(settlement(0.5));
    ledger.recordApprovalRaised(20, "사용자 승인");
    ledger.recordBlocked("테스트 차단");

    const events = eventsIn(dir);
    // `provider_usage_recorded`가 없는 것이 의도다: 비용·usage·응답 모델 ID를 정산 이벤트
    // 하나에 담아 **이벤트 사이 crash window를 없앴다.** 두 이벤트로 나누면 그 사이에 죽었을 때
    // "정산은 됐는데 usage는 모르는" 상태가 남고, 어느 쪽을 믿어야 하는지 알 수 없다.
    assert.deepEqual(
      events.map((e) => e.type),
      ["approval_created", "reservation_opened", "reservation_settled", "approval_raised", "run_blocked"]
    );
    const settled = events.find((e) => e.type === "reservation_settled");
    assert.deepEqual(settled?.usage, { inputTokens: 100, outputTokens: 50 }, "정산 이벤트에 usage가 없습니다");
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
    const after = eventsIn(dir);
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
    released.reservation.release({ dispatchState: "not_dispatched", reason: "테스트" });

    // 실제가 예약을 넘으면 추정이 틀렸다는 사실이 남고, 이후 예약이 차단된다.
    const breached = ledger.reserve({ maxUsd: 1, basis: "b" }, "breached");
    assert.ok(breached.ok);
    if (!breached.ok) return;
    breached.reservation.settle(settlement(3));
    assert.equal(ledger.estimateBreached(), true);
    assert.equal(ledger.reserve({ maxUsd: 0.01, basis: "b" }, "after").ok, false);

    ledger.recordApprovalRaised(20, "사용자 승인");

    const events = eventsIn(dir);
    const types = new Set(events.map((e) => e.type));
    for (const required of [
      "approval_created",
      "approval_raised",
      "reservation_opened",
      "reservation_released",
      "reservation_settled",
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
    r.reservation.settle(settlement(2));

    const events = eventsIn(dir);
    // 기록 파일이 같은 값을 말하면 재개할 수 있다.
    assert.equal(reconcileBudget({ recordsUsd: 2, events }).ok, true);
    // 다르면 어느 쪽이 맞는지 코드가 알 수 없다 — 한쪽을 골라 계속하지 않는다.
    const mismatch = reconcileBudget({ recordsUsd: 0, events });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.ok(mismatch.reasons.join(" ").includes("다릅니다"), mismatch.reasons.join(" / "));

    // 이벤트 파일이 아예 없는 것은 불일치가 아니다(이 기능 이전에 만든 실행 디렉터리).
    assert.equal(reconcileBudget({ recordsUsd: 2, events: [] }).ok, true);
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
    providerReportedModelId: modelId,
    usage: { inputTokens: 500, outputTokens: 120 },
    latencyMs: 900,
    structuredOutputOk: true,
    evidence: "필수 필드가 채워짐",
    dispatchState: "response_received_with_usage",
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
  const substituted: RoleProbeOutcome = { ...goodOutcome("exec-1"), providerReportedModelId: "some-other-model" };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: substituted, reviewer: goodOutcome("rev-1") }, log))
  );
  assert.equal(summary.status, "BLOCKED");
  assert.ok(
    summary.blockers.some((b) => b.includes("정확히 일치만 통과")),
    summary.blockers.join("\n")
  );
  // 대체가 확인된 뒤에는 다음 역할을 부르지 않는다 — 그리고 다른 모델로 바꿔 재시도하지 않는다.
  assert.deepEqual(log.calls, [{ role: "executor", modelId: "exec-1" }]);
  assert.equal(summary.records[0]!.exactModelIdVerified, false);
  assert.equal(summary.records[0]!.providerReportedModelId, "some-other-model");
});

test("33b. 실제 호출이 실패하면 다른 모델로 대체하지 않는다", async () => {
  const log: MockTransportLog = { calls: [] };
  const summary = await probeModels(
    probeInput(mockTransport({ executor: new Error("model_not_found"), reviewer: goodOutcome("rev-1") }, log))
  );
  // 평범한 Error는 요청이 나갔는지 알려주지 않는다 → 과금 불확실로 본다.
  assert.equal(summary.status, "BLOCKED_UNRESOLVED_RESERVATION");
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
  // 응답을 받았으므로 과금됐을 수 있다 — 해제하지 않고 미해결로 남긴다.
  assert.equal(summary.status, "BLOCKED_UNRESOLVED_RESERVATION");
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
  assert.equal(unpriced.status, "BLOCKED_UNRESOLVED_RESERVATION");
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

// ---------------------------------------------------------------------------
// 39~55. Crash-safe 예산과 증거 체인 (§11)
//
// **실제 네트워크를 타지 않는다.** provider 호출은 mock transport 또는 주입된 어댑터로만
// 일어나고, 아래 테스트들은 "이름이 요구사항을 반복하는" 대신 실제 provider callback 횟수,
// 이벤트 상태, 파일 내용, CLI 종료 코드를 확인한다.
// ---------------------------------------------------------------------------

/** 개시만 있고 종결이 없는 예약을 만든다 — crash를 재현하는 가장 정확한 방법이다. */
function crashAfterOpen(dir: string): void {
  const sink = createBudgetEventSink(dir);
  const ledger = createBudgetLedger(10, { runId: "crash", stage: "smoke", onEvent: sink, now: () => "T0" });
  const outcome = ledger.reserve({ maxUsd: 3, basis: "b" }, "fx/A/rep1");
  assert.ok(outcome.ok);
  // 여기서 프로세스가 죽었다고 가정한다: settle도 release도 부르지 않는다.
}

test("39. 열린 예약을 reconcile이 정상으로 반환하지 않는다", () => {
  withDir((dir) => {
    crashAfterOpen(dir);
    const read = readBudgetEvents(dir);
    assert.equal(read.ok, true);
    if (!read.ok) return;

    // 합계만 보면 0 == 0이라 통과했을 상태다. 상태 머신이 열린 예약을 잡아야 한다.
    const settledSum = read.events
      .filter((e) => e.type === "reservation_settled")
      .reduce((sum, e) => sum + (e.actualUsd ?? 0), 0);
    assert.equal(settledSum, 0, "정산 이벤트가 없어야 하는 상황입니다");

    const outcome = reconcileBudget({ recordsUsd: 0, events: read.events });
    assert.equal(outcome.ok, false, "열린 예약이 있는데 재개 가능으로 판정했습니다");
    if (!outcome.ok) {
      assert.equal(outcome.status, "BLOCKED_UNRESOLVED_RESERVATION");
      assert.ok(outcome.reasons.join(" ").includes("종결 이벤트가 없습니다"), outcome.reasons.join(" / "));
    }
    // 예약액은 사용 가능한 예산으로 되돌아오지 않는다.
    assert.equal(outcome.analysis.unresolvedUsd, 3);
    assert.equal(outcome.analysis.settledUsd, 0);
  });
});

test("39b. crash 지점별 판정 — opened / 요청 후 / 기록 후 / settle 후", () => {
  // 1) reservation_opened 직후 종료 → BLOCKED
  withDir((dir) => {
    crashAfterOpen(dir);
    const events = eventsIn(dir);
    assert.equal(reconcileBudget({ recordsUsd: 0, events }).ok, false);
  });

  // 2) provider 요청 전송 후 결과 저장 전 종료 → 같은 흔적이 남으므로 BLOCKED
  //    (요청이 나갔다는 사실은 이벤트 파일에 없다 — 그래서 열린 예약을 과금 가능으로 본다.)
  withDir((dir) => {
    crashAfterOpen(dir);
    const status = budgetStatus({ runDir: dir, records: [], eventRead: readBudgetEvents(dir), approvedLimitUsd: 10 });
    assert.equal(status.resumable, false);
    assert.equal(status.blockedStatus, "BLOCKED_UNRESOLVED_RESERVATION");
    assert.equal(status.openReservations.length, 1);
    assert.equal(status.openReservations[0]!.reservedUsd, 3);
    assert.equal(status.openReservations[0]!.stage, "smoke");
    assert.equal(status.openReservations[0]!.openedAt, "T0");
  });

  // 3) record 저장 후 settle 전 종료 → 기록에는 비용이 있는데 이벤트에는 정산이 없다.
  withDir((dir) => {
    crashAfterOpen(dir);
    const events = eventsIn(dir);
    const outcome = reconcileBudget({ recordsUsd: 2.5, events });
    assert.equal(outcome.ok, false, "기록만 있고 정산 이벤트가 없는데 재개를 허용했습니다");
  });

  // 4) settle 후 종료 → 정산 이벤트 하나에 비용·usage·모델 ID가 모두 있으므로 안전하게 판정된다.
  //    (예전에는 정산과 usage가 두 이벤트였고 그 사이가 crash window였다.)
  withDir((dir) => {
    const sink = createBudgetEventSink(dir);
    const ledger = createBudgetLedger(10, { runId: "ok", stage: "smoke", onEvent: sink, now: () => "T1" });
    const outcome = ledger.reserve({ maxUsd: 3, basis: "b" }, "fx/A/rep1");
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    outcome.reservation.settle(settlement(1.25, { providerReportedModelId: "m-1", requestedModelId: "m-1" }));

    const events = eventsIn(dir);
    const settled = events.find((e) => e.type === "reservation_settled");
    assert.ok(settled?.usage, "정산 이벤트에 usage가 없습니다 — crash window가 남아 있습니다");
    assert.equal(settled?.providerReportedModelId, "m-1");
    assert.equal(reconcileBudget({ recordsUsd: 1.25, events }).ok, true);
  });

  // 5) 정상 release 완료 → 재개 가능
  withDir((dir) => {
    const sink = createBudgetEventSink(dir);
    const ledger = createBudgetLedger(10, { runId: "rel", stage: "smoke", onEvent: sink, now: () => "T2" });
    const outcome = ledger.reserve({ maxUsd: 3, basis: "b" }, "fx/A/rep1");
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    outcome.reservation.release({ dispatchState: "not_dispatched", reason: "요청 전 중단" });
    assert.equal(reconcileBudget({ recordsUsd: 0, events: eventsIn(dir) }).ok, true);
  });
});

test("39c. settled/released 중복과 순서 위반을 거부한다", () => {
  const base = (overrides: Partial<BudgetEvent>): BudgetEvent => ({
    eventVersion: 2,
    type: "reservation_opened",
    at: "T",
    runId: "r",
    stage: "smoke",
    approvedLimitUsd: 10,
    cumulativeUsd: 0,
    ...overrides,
  });

  // settled + released 둘 다
  const both = analyzeBudgetEvents([
    base({ type: "reservation_opened", correlationId: "x", reservedUsd: 1 }),
    base({ type: "reservation_settled", correlationId: "x", reservedUsd: 1, actualUsd: 0.5 }),
    base({ type: "reservation_released", correlationId: "x", reservedUsd: 1 }),
  ]);
  assert.ok(both.problems.some((p) => p.includes("종결 이벤트가 두 번")), both.problems.join(" / "));

  // opened 없이 settled
  const orphan = analyzeBudgetEvents([base({ type: "reservation_settled", correlationId: "y", actualUsd: 1 })]);
  assert.ok(orphan.problems.some((p) => p.includes("없이 reservation_settled")), orphan.problems.join(" / "));

  // 예약액 불일치
  const mismatch = analyzeBudgetEvents([
    base({ type: "reservation_opened", correlationId: "z", reservedUsd: 1 }),
    base({ type: "reservation_settled", correlationId: "z", reservedUsd: 5, actualUsd: 1 }),
  ]);
  assert.ok(mismatch.problems.some((p) => p.includes("예약액")), mismatch.problems.join(" / "));

  // provider usage 이벤트와 정산 비용 불일치
  const usageMismatch = analyzeBudgetEvents([
    base({ type: "reservation_opened", correlationId: "u", reservedUsd: 2 }),
    base({ type: "reservation_settled", correlationId: "u", reservedUsd: 2, actualUsd: 1 }),
    base({ type: "provider_usage_recorded", correlationId: "u", actualUsd: 9 }),
  ]);
  assert.ok(usageMismatch.problems.some((p) => p.includes("provider usage")), usageMismatch.problems.join(" / "));

  // 모르는 이벤트 버전
  withDir((dir) => {
    writeFileSync(path.join(dir, "budget-events.jsonl"), `${JSON.stringify(base({ eventVersion: 99 }))}\n`);
    const read = readBudgetEvents(dir);
    assert.equal(read.ok, false);
    if (!read.ok) assert.ok(read.reasons.join(" ").includes("버전"), read.reasons.join(" / "));
  });

  // 손상된 **중간** 줄 (마지막 줄이 아니므로 중단 흔적이 아니다)
  withDir((dir) => {
    writeFileSync(
      path.join(dir, "budget-events.jsonl"),
      `{"broken":\n${JSON.stringify(base({ correlationId: "a", reservedUsd: 1 }))}\n`
    );
    const read = readBudgetEvents(dir);
    assert.equal(read.ok, false);
  });

  // 잘린 **마지막** 줄은 버리되 사실을 남긴다 → 재개 불가
  withDir((dir) => {
    writeFileSync(
      path.join(dir, "budget-events.jsonl"),
      `${JSON.stringify(base({ correlationId: "a", reservedUsd: 1 }))}\n{"partial":`
    );
    const read = readBudgetEvents(dir);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.truncatedLastLine, true);
    const outcome = reconcileBudget({ recordsUsd: 0, events: read.events, truncatedLastLine: true });
    assert.equal(outcome.ok, false, "잘린 줄이 있는데 재개를 허용했습니다");
  });
});

test("40. 열린 예약이 있으면 재시작해도 그 금액을 재사용할 수 없다", () => {
  // 상한 $10, 열린 예약 $3. 세 번 재시작해도 남은 예산은 $7을 넘지 않는다.
  for (let restart = 1; restart <= 3; restart += 1) {
    const ledger = createBudgetLedger(10, { initialUnresolvedUsd: 3 });
    assert.equal(ledger.unresolvedUsd(), 3);
    assert.equal(ledger.availableUsd(), 7, `${restart}회차에서 미해결 금액이 예산으로 돌아왔습니다`);
    // 그리고 원장이 차단 상태이므로 애초에 예약을 받지 않는다.
    assert.equal(ledger.state(), "UNRESOLVED_RESERVATION");
    const outcome = ledger.reserve({ maxUsd: 1, basis: "b" }, "x");
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.state, "UNRESOLVED_RESERVATION");
  }
});

test("41. NaN/Infinity/음수 비용은 fail closed — 0으로 정산되지 않는다", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const events: BudgetEvent[] = [];
    const ledger = createBudgetLedger(10, { onEvent: (e) => events.push(e) });
    const outcome = ledger.reserve({ maxUsd: 2, basis: "b" }, "one");
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    const settled = outcome.reservation.settle(settlement(bad));
    assert.equal(settled.ok, false, `${bad}가 정산되었습니다`);
    if (!settled.ok) assert.equal(settled.state, "BUDGET_LEDGER_INVALID");

    // **예약이 해제되지 않는다** — 0으로 정산하면 그 금액만큼 상한이 되살아난다.
    assert.equal(ledger.sessionCommittedUsd(), 0);
    assert.equal(ledger.unresolvedUsd(), 2);
    assert.equal(ledger.availableUsd(), 8);
    assert.equal(ledger.state(), "BUDGET_LEDGER_INVALID");
    // 이후 유료 호출이 차단된다.
    assert.equal(ledger.reserve({ maxUsd: 0.01, basis: "b" }, "two").ok, false);
    // 감사 이벤트가 남는다.
    assert.ok(events.some((e) => e.type === "budget_ledger_invalid"), events.map((e) => e.type).join(","));
  }
});

test("41b. usage 토큰 이상값과 실공급자 0토큰도 fail closed", () => {
  const cases: { label: string; settlement: Settlement }[] = [
    {
      label: "inputTokens NaN",
      settlement: settlement(1, { usage: { measured: true, inputTokens: Number.NaN, outputTokens: 1 } }),
    },
    {
      label: "outputTokens 음수",
      settlement: settlement(1, { usage: { measured: true, inputTokens: 1, outputTokens: -1 } }),
    },
    {
      label: "실공급자 응답의 0/0 토큰",
      settlement: settlement(1, { usage: { measured: true, inputTokens: 0, outputTokens: 0 }, providerKind: "real" }),
    },
    {
      label: "비용 측정 실패",
      settlement: settlement(0, { cost: { measured: false, reason: "usage 없음" } }),
    },
  ];
  for (const testCase of cases) {
    const ledger = createBudgetLedger(10);
    const outcome = ledger.reserve({ maxUsd: 2, basis: "b" }, "one");
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    const settled = outcome.reservation.settle(testCase.settlement);
    assert.equal(settled.ok, false, `${testCase.label}가 정산되었습니다`);
    assert.equal(ledger.sessionCommittedUsd(), 0, testCase.label);
    assert.equal(ledger.unresolvedUsd(), 2, testCase.label);
  }

  // **0은 fake에서 합법이다** — 타입 수준에서 "0달러"와 "모른다"를 구별한 결과다.
  const fake = createBudgetLedger(10);
  const outcome = fake.reserve({ maxUsd: 1, basis: "b" }, "fake");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const ok = outcome.reservation.settle({
    cost: { measured: true, usd: 0 },
    usage: { measured: true, inputTokens: 0, outputTokens: 0 },
    providerKind: "fake",
  });
  assert.equal(ok.ok, true, "fake의 0토큰/0달러 정산이 막혔습니다");
  assert.equal(fake.unresolvedUsd(), 0);
});

test("42. parse/schema 오류 후 예약이 해제되지 않는다", async () => {
  // 응답을 받고 usage까지 있었지만 스키마에서 실패한 경우 — 과금됐다.
  const log: MockTransportLog = { calls: [] };
  const events: BudgetEvent[] = [];
  const failure = new ProviderCallFailure({
    message: "구조화 출력이 JSON이 아님",
    dispatchState: "response_received_with_usage",
    classification: { kind: "schema_violation", message: "json", status: 400, retryable: false },
    usage: { inputTokens: 400, outputTokens: 90 },
    providerReportedModelId: "exec-1",
  });
  const summary = await probeModels(
    probeInput(mockTransport({ executor: failure, reviewer: goodOutcome("rev-1") }, log), {
      onEvent: (e) => events.push(e),
    })
  );

  assert.equal(summary.status, "BLOCKED");
  // usage가 있으므로 **실제 비용으로 정산**된다 — 해제(=안 쓴 것으로 만들기)가 아니다.
  assert.ok(summary.actualUsd > 0, `실제 비용이 정산되지 않았습니다: ${summary.actualUsd}`);
  assert.equal(summary.records[0]!.reservationOutcome, "settled");
  assert.ok(!events.some((e) => e.type === "reservation_released"), "과금된 호출의 예약이 해제되었습니다");
  // 다음 역할은 부르지 않는다.
  assert.equal(log.calls.length, 1);

  // usage를 모르는 경우 → 미해결로 남는다(해제도 정산도 아니다).
  const log2: MockTransportLog = { calls: [] };
  const events2: BudgetEvent[] = [];
  const noUsage = new ProviderCallFailure({
    message: "응답을 받았으나 usage 없음",
    dispatchState: "response_received_without_usage",
    classification: { kind: "schema_violation", message: "no usage", retryable: false },
  });
  const summary2 = await probeModels(
    probeInput(mockTransport({ executor: noUsage, reviewer: goodOutcome("rev-1") }, log2), {
      onEvent: (e) => events2.push(e),
    })
  );
  assert.equal(summary2.status, "BLOCKED_UNRESOLVED_RESERVATION");
  assert.equal(summary2.records[0]!.reservationOutcome, "unresolved");
  assert.ok(summary2.unresolvedUsd > 0);
  assert.ok(!events2.some((e) => e.type === "reservation_released"));
  assert.ok(events2.some((e) => e.type === "reservation_unresolved"));
  assert.equal(log2.calls.length, 1);

  // **요청이 나가지 않은 것이 확실할 때만** 해제된다.
  const log3: MockTransportLog = { calls: [] };
  const events3: BudgetEvent[] = [];
  const notDispatched = new ProviderCallFailure({
    message: "요청 조립 실패",
    dispatchState: "not_dispatched",
    classification: { kind: "auth", message: "no key", retryable: false },
  });
  const summary3 = await probeModels(
    probeInput(mockTransport({ executor: notDispatched }, log3), { onEvent: (e) => events3.push(e) })
  );
  assert.equal(summary3.unresolvedUsd, 0);
  assert.equal(summary3.records[0]!.reservationOutcome, "released");
  assert.ok(events3.some((e) => e.type === "reservation_released"));
});

test("43. 오류 메시지에 secret-like 문자열이 있어도 어디에도 남지 않는다", async () => {
  const secret = "sk-ant-0123456789abcdefghijklmnopqrstuvwxyz";
  const log: MockTransportLog = { calls: [] };
  const events: BudgetEvent[] = [];
  const leaky = new ProviderCallFailure({
    message: `401 from provider: Authorization: Bearer ${secret}`,
    dispatchState: "not_dispatched",
    classification: { kind: "auth", message: "unauthorized", retryable: false },
  });
  const summary = await probeModels(
    probeInput(mockTransport({ executor: leaky }, log), { onEvent: (e) => events.push(e) })
  );

  // **만드는 지점에서 지운다** — 저장 직전 검사만으로는 stdout에 이미 나간 것을 못 막는다.
  assert.ok(!leaky.message.includes(secret), "ProviderCallFailure가 원문 키를 그대로 담았습니다");
  assert.ok(redactSecrets(`Bearer ${secret}`).includes("[REDACTED"), "redaction이 동작하지 않습니다");

  const serialized = JSON.stringify({ summary, events });
  assert.ok(!serialized.includes(secret), "요약 또는 이벤트에 키가 남았습니다");
  assert.ok(!containsSecretLike(serialized), serialized.slice(0, 300));

  // 화면 출력에도 남지 않는다.
  const rendered = renderProbeSummary(summary).join("\n");
  assert.ok(!rendered.includes(secret));
  assert.ok(!containsSecretLike(rendered));

  // 파일에도 남지 않는다.
  withDir((dir) => {
    writeProbeResults(dir, summary);
    const text = readFileSync(path.join(dir, "model-probe.json"), "utf8");
    assert.ok(!text.includes(secret));
    assert.ok(!containsSecretLike(text));
  });
});

// ---------------------------------------------------------------------------
// 44~55. Probe evidence → Run Card → P0 → P1 증거 체인 (§11)
// ---------------------------------------------------------------------------

const FAKE_KEYS = { OPENAI_API_KEY: "test-openai-key-value", ANTHROPIC_API_KEY: "test-anthropic-key-value" };

/** 환경변수 맵을 **해석된 자격증명**으로 바꾼다 — resolver가 하는 일을 테스트에서도 그대로 쓴다. */
function credentialsFrom(env: NodeJS.ProcessEnv = FAKE_KEYS): ResolvedProviderCredential[] {
  const out: ResolvedProviderCredential[] = [];
  for (const [providerId, envName] of [
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
  ] as const) {
    const resolved = resolveCredential(providerId, envName, env);
    assert.ok(resolved.ok, `${providerId} 자격증명을 해석할 수 없습니다`);
    if (resolved.ok) out.push({ providerId, envName: resolved.envName, value: resolved.value });
  }
  return out;
}

function bindingFor(env: NodeJS.ProcessEnv = FAKE_KEYS): CredentialBinding {
  const binding = computeCredentialBinding(credentialsFrom(env), "a".repeat(64));
  assert.ok(binding, "binding을 만들 수 없습니다");
  return binding!;
}

const EVIDENCE_BINDING = {
  protocolVersion: CRITERIA.protocolVersion,
  criteriaHash: criteriaHash(),
  registrySnapshotHash: "reg-hash",
  adapterContractVersion: "2",
};

function roleEvidenceFor(modelId: string, providerId: string): RoleEvidence {
  return {
    providerId,
    requestedModelId: modelId,
    providerReportedModelId: modelId,
    exactModelIdVerified: true,
    structuredOutputVerified: true,
    usage: { inputTokens: 500, outputTokens: 120 },
    actualUsd: 0.002,
  };
}

function validEvidence(overrides: Partial<Parameters<typeof buildProbeEvidence>[0]> = {}): ProbeEvidence {
  return buildProbeEvidence({
    createdAt: "2026-07-30T00:00:00.000Z",
    ...EVIDENCE_BINDING,
    executor: roleEvidenceFor("gpt-4.1", "openai"),
    reviewer: roleEvidenceFor("claude-sonnet-5", "anthropic"),
    approvedProbeLimitUsd: 1,
    cumulativeProbeCostUsd: 0.004,
    credentialBinding: bindingFor(),
    evidenceId: "probe-fixed-id",
    ...overrides,
  });
}

function expectationsAt(now: string): Parameters<typeof validateProbeEvidence>[1] {
  return {
    now,
    ...EVIDENCE_BINDING,
    executorModelId: "gpt-4.1",
    reviewerModelId: "claude-sonnet-5",
    credentials: credentialsFrom(FAKE_KEYS),
  };
}

test("44. probe evidence는 만료·변조·모델 불일치·다른 키를 거부한다", () => {
  const evidence = validEvidence();
  const inWindow = "2026-07-30T01:00:00.000Z";
  assert.equal(validateProbeEvidence(evidence, expectationsAt(inWindow)).ok, true);

  // 만료
  const expired = validateProbeEvidence(evidence, expectationsAt("2026-08-01T00:00:00.000Z"));
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.ok(expired.reasons.some((r) => r.includes("만료")), expired.reasons.join(" / "));

  // 변조: 비용을 손으로 고치면 해시가 깨진다.
  const tampered = { ...evidence, cumulativeProbeCostUsd: 0.000001 };
  const tamperedVerdict = validateProbeEvidence(tampered, expectationsAt(inWindow));
  assert.equal(tamperedVerdict.ok, false);
  if (!tamperedVerdict.ok) {
    assert.equal(tamperedVerdict.status, "BLOCKED_INVALID_PROBE_EVIDENCE");
    assert.ok(tamperedVerdict.reasons.some((r) => r.includes("해시")), tamperedVerdict.reasons.join(" / "));
  }

  // 모델 불일치
  const otherModel = validateProbeEvidence(evidence, { ...expectationsAt(inWindow), executorModelId: "gpt-5.1" });
  assert.equal(otherModel.ok, false);
  if (!otherModel.ok) assert.ok(otherModel.reasons.some((r) => r.includes("executor 모델")));

  // 레지스트리 스냅샷 / 어댑터 계약이 바뀌면 거부
  for (const changed of [{ registrySnapshotHash: "other" }, { adapterContractVersion: "3" }]) {
    const verdict = validateProbeEvidence(evidence, { ...expectationsAt(inWindow), ...changed });
    assert.equal(verdict.ok, false, JSON.stringify(changed));
  }

  // 다른 자격증명
  const otherKey = validateProbeEvidence(evidence, {
    ...expectationsAt(inWindow),
    credentials: credentialsFrom({ ...FAKE_KEYS, OPENAI_API_KEY: "different-key" }),
  });
  assert.equal(otherKey.ok, false);
  if (!otherKey.ok) assert.ok(otherKey.reasons.some((r) => r.includes("probe 당시와 다릅니다")));

  // 키가 사라진 경우
  const noKey = validateProbeEvidence(evidence, {
    ...expectationsAt(inWindow),
    credentials: [{ providerId: "openai", envName: "OPENAI_API_KEY", value: "test-openai-key-value" }],
  });
  assert.equal(noKey.ok, false);
});

test("44b. credentialBinding에 키 원문·prefix·suffix가 없다", () => {
  const evidence = validEvidence();
  const text = JSON.stringify(evidence);
  for (const key of Object.values(FAKE_KEYS)) {
    assert.ok(!text.includes(key), "evidence에 키 원문이 있습니다");
    assert.ok(!text.includes(key.slice(0, 8)), "evidence에 키 prefix가 있습니다");
    assert.ok(!text.includes(key.slice(-8)), "evidence에 키 suffix가 있습니다");
  }
  assert.equal(evidence.credentialBinding.algorithm, "HMAC-SHA256");
  // 환경변수 **이름**은 남는다 — 값이 아니라 어디를 봐야 하는지의 정보다.
  assert.ok(text.includes("OPENAI_API_KEY"));
});

test("45. probe 결과가 Run Card readiness에 반영된다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const models = planModels({ credentialPresence: () => true });
  const common = {
    fixtures,
    arms: ["A", "B", "C", "D"] as ArmId[],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    p1ApprovedLimitUsd: 300,
    models,
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    joinPath: (a: string, b: string) => `${a}/${b}`,
  };

  // evidence 없음 → READY_FOR_MODEL_PROBE
  const before = buildStagedCards(common);
  assert.equal(before.p0.status, "READY_FOR_MODEL_PROBE");
  assert.equal(before.p0.probeEvidenceId, undefined);

  // evidence 있음 → P0는 승인 가능, P1은 P0 결과 대기
  const after = buildStagedCards({ ...common, probeEvidence: validEvidence() });
  assert.equal(after.p0.status, "READY_FOR_P0_APPROVAL", after.p0.blockers.join(" / "));
  assert.equal(after.p0.probeEvidenceId, "probe-fixed-id");
  assert.equal(after.p1.status, "BLOCKED_PENDING_P0_RESULT");

  // P0 attestation까지 있으면 P1도 승인 가능
  const withP0 = buildStagedCards({
    ...common,
    probeEvidence: validEvidence(),
    p0Attestation: { attestationId: "p0-x", attestationHash: "hash-x", path: "/tmp/run/approvals/attestations/p0-x.json" },
  });
  assert.equal(withP0.p1.status, "READY_FOR_P1_APPROVAL", withP0.p1.blockers.join(" / "));
  assert.equal(withP0.p1.p0AttestationId, "p0-x");

  // 자격증명이 없으면 그것이 가장 먼저다.
  const noCreds = buildStagedCards({ ...common, credentialsPresent: false, probeEvidence: validEvidence() });
  assert.equal(noCreds.p0.status, "BLOCKED_MISSING_CREDENTIALS");

  // evidence가 깨졌으면 READY_FOR_MODEL_PROBE가 아니라 BLOCKED_INVALID_PROBE_EVIDENCE다.
  const broken = buildStagedCards({ ...common, probeEvidenceProblems: ["해시가 다릅니다"] });
  assert.equal(broken.p0.status, "BLOCKED_INVALID_PROBE_EVIDENCE");
});

test("46. Run Card 없이는 유료 실행 경로에 들어갈 수 없다", () => {
  // CLI 인수 수준에서 카드 없이 실행하는 우회 플래그가 없다.
  const options = parseArgs(["pilot", "--max-cost-usd", "10"], "/o");
  assert.equal(options.runCard, undefined);
  const flags = ["--force", "--no-run-card", "--skip-run-card", "--unsafe", "--yes"];
  for (const flag of flags) {
    assert.throws(() => parseArgs(["pilot", flag], "/o"), OptionError, `${flag}가 받아들여졌습니다`);
  }
  // 카드 경로는 받는다.
  assert.ok(parseArgs(["pilot", "--run-card", "/tmp/p0-run-card.json"], "/o").runCard?.endsWith("p0-run-card.json"));
});

test("47. 카드 해시·단계·경로·인자·예산이 다르면 승인하지 않는다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const cards = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    p1ApprovedLimitUsd: 300,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: validEvidence(),
    joinPath: (a, b) => `${a}/${b}`,
  });
  const card = cards.p0;
  const request: CardExecutionRequest = {
    stage: "smoke",
    outputDir: card.outputDir,
    // **현재 fixture 사실**을 넘긴다 — id뿐 아니라 내용 해시까지 비교된다(§2.4).
    fixtures: card.fixtureHashes.map((f) => ({ ...f })),
    arms: card.stage.arms,
    repetitions: 1,
    maxConcurrency: 1,
    seed: 1,
    maxCostUsd: 30,
    executorModelId: card.models!.executor.modelId,
    reviewerModelId: card.models!.reviewer.modelId,
    runCardPath: card.immutableCardPath,
    probeEvidencePath: card.probeEvidencePath!,
    now: "2026-07-30T01:00:00.000Z",
  };
  assert.equal(authorizeRunCard(card, request).ok, true, JSON.stringify(authorizeRunCard(card, request)));

  const rejections: { label: string; patch: Partial<CardExecutionRequest> }[] = [
    { label: "단계", patch: { stage: "pilot" } },
    { label: "출력 경로", patch: { outputDir: "/tmp/other" } },
    {
      label: "fixture 집합",
      patch: { fixtures: [{ fixtureId: "nope", category: "multi_file_contract", language: "typescript", hash: "h" }] },
    },
    {
      // **같은 id인데 내용이 바뀐 경우** (§2.4). 예전 검증은 id 집합만 봐서 이걸 통과시켰다.
      label: "fixture 내용",
      patch: { fixtures: card.fixtureHashes.map((f) => ({ ...f, hash: `${f.hash}-changed` })) },
    },
    { label: "동시성", patch: { maxConcurrency: 4 } },
    { label: "카드 경로", patch: { runCardPath: "/tmp/other-card.json" } },
    { label: "evidence 경로", patch: { probeEvidencePath: "/tmp/other-evidence.json" } },
    { label: "arm", patch: { arms: ["A"] as ArmId[] } },
    { label: "반복", patch: { repetitions: 3 } },
    { label: "seed", patch: { seed: 99 } },
    { label: "예산", patch: { maxCostUsd: 300 } },
    { label: "executor 모델", patch: { executorModelId: "gpt-5.1" } },
    { label: "만료", patch: { now: "2026-08-05T00:00:00.000Z" } },
  ];
  for (const rejection of rejections) {
    const verdict = authorizeRunCard(card, { ...request, ...rejection.patch });
    assert.equal(verdict.ok, false, `${rejection.label}가 달라도 승인했습니다`);
    if (!verdict.ok) assert.equal(verdict.status, "BLOCKED_INVALID_RUN_CARD");
  }

  // 카드 파일을 손으로 고치면 해시 검증에서 막힌다.
  withDir((dir) => {
    const stored: RunCard = { ...card, outputDir: dir, approvalsDir: path.join(dir, "approvals") };
    const rehashed: RunCard = { ...stored, immutableCardPath: path.join(dir, "approvals", "cards", `${stored.cardId}.json`) };
    const written = writeRunCard(rehashed);
    const file = written.cardFile;
    const raw = JSON.parse(readFileSync(file, "utf8")) as RunCard;
    raw.approvedLimitUsd = 9_999;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const loaded = loadRunCard(file);
    assert.equal(loaded.ok, false, "수정된 카드가 통과했습니다");
    if (!loaded.ok) assert.ok(loaded.reasons.join(" ").includes("해시"), loaded.reasons.join(" / "));
  });

  // evidence가 연결되지 않은 카드는 승인 불가다.
  const noEvidence = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;
  const verdict = authorizeRunCard(noEvidence, request);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.ok(verdict.reasons.some((r) => r.includes("probe evidence")));
});

test("48. P0 attestation은 8건 전부 정상일 때만 만들어진다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;

  const goodRecords = p0Records(card, evidence);
  assert.equal(goodRecords.length, 8);
  const events = p0Events(goodRecords);

  const ok = attestP0(attestInput(card, evidence, goodRecords, events));
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reasons.join(" / "));
  if (!ok.ok) return;
  assert.equal(ok.attestation.actualRecords, 8);
  assert.equal(ok.attestation.expectedRecords, 8);
  assert.ok(ok.attestation.checks.every((c) => c.passed));

  // 부분 실행 → BLOCKED_P0_INCOMPLETE
  const partial = attestP0(attestInput(card, evidence, goodRecords.slice(0, 7), p0Events(goodRecords.slice(0, 7))));
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.status, "BLOCKED_P0_INCOMPLETE");

  // 인프라 실패 1건 → BLOCKED_P0_FAILED
  const withFailure = goodRecords.map((r, i) => (i === 0 ? { ...r, failureClass: "auth_failure" as const } : r));
  const failed = attestP0(attestInput(card, evidence, withFailure, p0Events(withFailure)));
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.status, "BLOCKED_P0_FAILED");

  // 열린 예약 1건 → attestation 없음
  const openEvent: BudgetEvent = {
    eventVersion: 2,
    type: "reservation_opened",
    at: "T",
    runId: "r",
    stage: "smoke",
    approvedLimitUsd: 30,
    cumulativeUsd: 0,
    correlationId: "leftover",
    reservedUsd: 1,
  };
  const withOpen = attestP0(attestInput(card, evidence, goodRecords, [...events, openEvent]));
  assert.equal(withOpen.ok, false);

  // ---- exact-model 검증의 근거는 **호출별 응답 envelope**뿐이다 (§2.8) ----
  //
  // 이 두 assertion은 짝이다. 예전 구현은 `returnedModelId`(= `DRAFT_RECEIVED.model`)를
  // 근거로 삼았는데, 그 값은 어댑터가 `this.modelId`를 넣은 **자기보고 값**이라 조용한 대체를
  // 절대 잡지 못했다. 이제 판정은 `providerCalls[*].providerReportedModelId`로만 한다.

  // (1) 품질 메타데이터만 바뀐 것은 **판정에 영향이 없다.**
  const metadataOnly = goodRecords.map((r) => ({ ...r, returnedModelId: "some-other-model" }));
  const stillOk = attestP0(attestInput(card, evidence, metadataOnly, p0Events(metadataOnly)));
  assert.equal(
    stillOk.ok,
    true,
    `DRAFT_RECEIVED.model이 exact-model 판정에 쓰이고 있습니다: ${stillOk.ok ? "" : stillOk.reasons.join(" / ")}`
  );

  // (2) **응답 envelope**이 다르면 attestation을 만들지 않는다.
  const substituted = goodRecords.map((r) => ({
    ...r,
    providerCalls: r.providerCalls.map((c) => ({ ...c, providerReportedModelId: "some-other-model" })),
  }));
  const wrongModel = attestP0(attestInput(card, evidence, substituted, p0Events(substituted)));
  assert.equal(wrongModel.ok, false, "응답 envelope 모델 ID가 달라도 attestation을 만들었습니다");
  if (!wrongModel.ok) {
    assert.ok(
      wrongModel.reasons.some((r) => r.includes("응답 envelope 모델 ID")),
      wrongModel.reasons.join(" / ")
    );
  }

  // (3) 응답 envelope 모델 ID가 **아예 없으면** 조용한 대체를 배제할 수 없으므로 거부한다.
  const missing = goodRecords.map((r) => ({
    ...r,
    providerCalls: r.providerCalls.map(({ providerReportedModelId: _drop, ...c }) => c),
  }));
  const noEnvelope = attestP0(attestInput(card, evidence, missing, p0Events(missing)));
  assert.equal(noEnvelope.ok, false, "응답 모델 ID가 없어도 attestation을 만들었습니다");

  // (4) **역할을 서로 바꿔 통과시키지 않는다** — reviewer 호출이 executor 모델로 응답한 경우.
  const swapped = goodRecords.map((r) => ({
    ...r,
    providerCalls: r.providerCalls.map((c) =>
      c.role === "reviewer"
        ? { ...c, providerReportedModelId: evidence.executor.providerReportedModelId }
        : c
    ),
  }));
  const roleSwap = attestP0(attestInput(card, evidence, swapped, p0Events(swapped)));
  assert.equal(roleSwap.ok, false, "reviewer가 executor 모델로 응답했는데 통과했습니다");
});

test("49. 실패한·변조된 P0 attestation으로는 P1을 승인하지 않는다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;
  const records = p0Records(card, evidence);
  const outcome = attestP0(attestInput(card, evidence, records, p0Events(records)));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  const expect = {
    probeEvidenceId: evidence.evidenceId,
    probeEvidenceHash: evidence.evidencePayloadHash,
    criteriaHash: criteriaHash(),
    protocolVersion: CRITERIA.protocolVersion,
    executorModelId: "gpt-4.1",
    reviewerModelId: "claude-sonnet-5",
  };
  assert.equal(validateP0Attestation(outcome.attestation, expect).ok, true);

  // 변조: 검사 결과를 통과로 바꾸면 해시가 깨진다.
  const tampered = {
    ...outcome.attestation,
    checks: outcome.attestation.checks.map((c) => ({ ...c, passed: true })),
    actualRecords: 1,
  };
  const tamperedVerdict = validateP0Attestation(tampered, expect);
  assert.equal(tamperedVerdict.ok, false);
  if (!tamperedVerdict.ok) assert.equal(tamperedVerdict.status, "BLOCKED_PENDING_P0_RESULT");

  // 다른 evidence를 근거로 만든 attestation은 이 실행을 보증하지 않는다.
  const otherEvidence = validateP0Attestation(outcome.attestation, { ...expect, probeEvidenceId: "probe-other" });
  assert.equal(otherEvidence.ok, false);

  // 다른 모델
  const otherModel = validateP0Attestation(outcome.attestation, { ...expect, executorModelId: "gpt-5.1" });
  assert.equal(otherModel.ok, false);
});

test("50. probe timeout이 실제 abort를 발생시키고 과금 불확실로 처리된다", async () => {
  // 시간을 주입한다 — 60초를 기다리는 테스트는 만들지 않는다.
  const fired: (() => void)[] = [];
  const timers = {
    setTimeout: (handler: () => void) => {
      fired.push(handler);
      return fired.length;
    },
    clearTimeout: () => undefined,
  };

  let sawAbort = false;
  const transport = createAdapterProbeTransport({
    timeoutMs: 1,
    timers,
    now: () => "2026-07-30T00:00:00.000Z",
    // **주입된 어댑터** — 이 테스트는 네트워크를 타지 않는다.
    adapterFactory: () => ({
      async generateDraft(_input, ctx) {
        // timeout timer를 발화시킨 뒤 abort 신호를 확인한다.
        fired.forEach((f) => f());
        if (ctx.signal.aborted) {
          sawAbort = true;
          const error = new Error("aborted") as Error & { name: string };
          error.name = "AbortError";
          throw error;
        }
        throw new Error("abort가 오지 않았습니다");
      },
      async reviewProposal() {
        throw new Error("reviewer는 호출되지 않아야 합니다");
      },
    }),
  });

  const entry = modelEntry({ modelId: "exec-1", providerId: "openai" });
  await assert.rejects(
    () => transport.probe("executor", entry),
    (error: Error) => {
      assert.equal(error.name, "ProbeTimeoutError");
      // **타임아웃은 not_dispatched가 아니다** — 응답이 생성됐지만 못 받은 것일 수 있다.
      assert.equal((error as ProviderCallFailure).dispatchState, "dispatched_no_response");
      return true;
    }
  );
  assert.equal(sawAbort, true, "AbortController가 실제로 abort되지 않았습니다");

  // 사용자 취소는 타임아웃과 구별된다.
  const controller = new AbortController();
  const cancelTransport = createAdapterProbeTransport({
    timeoutMs: 10_000,
    timers: { setTimeout: () => 1, clearTimeout: () => undefined },
    externalSignal: controller.signal,
    adapterFactory: () => ({
      async generateDraft(_input, ctx) {
        controller.abort();
        assert.equal(ctx.signal.aborted, true);
        const error = new Error("cancelled") as Error & { name: string };
        error.name = "AbortError";
        throw error;
      },
      async reviewProposal() {
        throw new Error("호출되지 않아야 합니다");
      },
    }),
  });
  await assert.rejects(
    () => cancelTransport.probe("executor", entry),
    (error: Error) => error.name === "ProbeCancelledError"
  );

  // 타임아웃 후 두 번째 역할을 부르지 않는다 (probeModels의 중단 규칙).
  const log: MockTransportLog = { calls: [] };
  const timeoutFailure = new ProviderCallFailure({
    message: "timeout",
    dispatchState: "dispatched_no_response",
    classification: { kind: "timeout", message: "t", retryable: false },
  });
  const summary = await probeModels(probeInput(mockTransport({ executor: timeoutFailure }, log)));
  assert.equal(log.calls.length, 1);
  assert.equal(summary.status, "BLOCKED_UNRESOLVED_RESERVATION");
  assert.ok(summary.unresolvedUsd > 0, "타임아웃이 과금 불확실로 처리되지 않았습니다");
});

test("51. 모든 화면에서 총 호출 상한을 쓴다 (executor-only를 최대라 부르지 않는다)", () => {
  // confirmatory: 24 fixture × 4 arm × 3회.
  const confirmatory = computeCallBudget({ fixtureCount: 24, arms: ["A", "B", "C", "D"], repetitions: 3 });
  assert.equal(confirmatory.executor, 1_152);
  assert.equal(confirmatory.reviewer, 432);
  assert.equal(confirmatory.total, 1_584, "총 상한이 executor+reviewer가 아닙니다");

  // P0 44회 / P1 528회가 **같은 함수에서** 나온다.
  assert.equal(computeCallBudget({ fixtureCount: 2, arms: ["A", "B", "C", "D"], repetitions: 1 }).total, 44);
  assert.equal(computeCallBudget({ fixtureCount: 24, arms: ["A", "B", "C", "D"], repetitions: 1 }).total, 528);

  // preflight 출력이 총 상한을 쓴다.
  const pre = preflight({
    fixtureCount: 24,
    arms: ["A", "B", "C", "D"],
    repetitions: 3,
    usingFakeProvider: true,
    msvc: { kind: "not_needed" },
  });
  const text = pre.lines.join("\n");
  assert.ok(text.includes("최대 provider 호출 수(총 상한): 1,584회"), text);
  assert.ok(text.includes("executor(초안 1 + fix loop 3): 1,152회"), text);
  assert.ok(text.includes("reviewer(검수 1 + revise 2): 432회"), text);
  // executor 수치가 단독으로 "최대 API 호출 수"라고 불리지 않는다.
  assert.ok(!/최대 API 호출 수/.test(text), text);
});

test("52. 공백·괄호·비ASCII·따옴표가 있는 Windows 경로 명령이 재현 가능하다", () => {
  // 백슬래시는 이중화해 적는다. `String.raw`는 **trailing backslash가 백틱을 escape**해서
  // 쓸 수 없다 — 그리고 trailing backslash가 정확히 이 테스트가 확인해야 하는 경우다.
  const paths = [
    "C:\\Users\\Vyper\\Documents\\Tomverse Code\\run",
    "C:\\Program Files (x86)\\Tomverse\\run",
    "C:\\사용자\\톰버스 코드\\실행",
    "C:\\temp\\trailing\\",
    "C:\\it's mine\\run",
  ];
  for (const target of paths) {
    const quoted = quotePowerShellArg(target);
    // 공백이 있으면 반드시 인용된다.
    if (/\s/.test(target)) assert.ok(quoted.startsWith("'"), `${target} → ${quoted}`);
    // 작은따옴표는 이중화된다 — PowerShell literal 문자열의 유일한 escape다.
    if (target.includes("'")) assert.ok(quoted.includes("''"), quoted);
    // 인용을 풀면 원래 경로가 그대로 나온다 (PowerShell literal 규칙).
    const unquoted = quoted.startsWith("'") ? quoted.slice(1, -1).replace(/''/g, "'") : quoted;
    assert.equal(unquoted, target, `${target} → ${quoted}`);
  }

  // 카드의 argv는 **구조**이므로 인용과 무관하게 원본 경로를 담는다.
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const spaced = "C:\\Users\\Vyper\\Documents\\Tomverse Code\\gate";
  const cards = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: spaced,
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: validEvidence(),
    joinPath: (a, b) => `${a}\\\\${b}`,
  });
  const card = cards.p0;
  const outputIndex = card.runArgv.indexOf("--output");
  assert.ok(outputIndex >= 0);
  assert.equal(card.runArgv[outputIndex + 1], `${spaced}\\\\p0-smoke`, "argv에 원본 경로가 담기지 않았습니다");
  // 사람이 읽는 문자열에서는 인용된다.
  assert.ok(card.runCommandPowerShell.includes(`'${spaced}\\\\p0-smoke'`), card.runCommandPowerShell);
  // 문자열을 다시 파싱하지 않고 argv를 비교하는 것이 요점이다.
  assert.deepEqual(card.resumeArgv, [...card.runArgv, "--resume"]);
});

test("53. 이 파일의 모든 provider 상호작용이 mock 또는 주입 어댑터다", () => {
  // `createAdapterProbeTransport`를 adapterFactory 없이 부르면 실제 어댑터가 만들어지고,
  // 그것만이 네트워크로 나간다. 이 파일에 그런 호출이 하나도 없어야 한다.
  //
  // **needle을 런타임에 조립한다.** 소스를 검사하는 테스트가 검사 대상 문자열을 그대로
  // 담고 있으면 자기 자신을 세게 되고, 그러면 개수 비교가 언제나 어긋난다.
  const needle = `createAdapterProbe${"Transport("}`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const source = readFileSync(path.join(root, "test", "safety.test.ts"), "utf8");

  const calls: string[] = [];
  let index = source.indexOf(needle);
  while (index >= 0) {
    // 호출 하나의 인자 범위를 괄호 깊이로 잘라낸다.
    let depth = 0;
    let end = index + needle.length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(index, end + 1));
    index = source.indexOf(needle, end + 1);
  }

  assert.ok(calls.length >= 2, `transport 테스트가 없습니다 (발견 ${calls.length}건)`);
  for (const call of calls) {
    assert.ok(
      call.includes("adapterFactory"),
      `주입 없이 실제 transport를 만들었습니다: ${call.slice(0, 120)}`
    );
  }
});

// ---- 공용: P0 mock 기록과 이벤트 ----

/** 카드가 요구하는 8건을 만든다. 실제 P0를 돌리지 않고 attestation 경로를 검증하기 위한 것이다. */
const TEST_RECEIPT_ID = "receipt-smoke-test";
const TEST_RECEIPT_HASH = "0".repeat(64);

/**
 * 이 카드/evidence를 승인한 것으로 간주하는 receipt. attestation 체인 검사의 상대편이다.
 *
 * **해시를 그대로 둔 판**이다. 파일로 써서 CLI가 읽는 경로를 태울 때는 이쪽을 쓴다 —
 * `readExecutionReceipts`가 `receiptHash`를 실제로 검증하므로 더미 해시는 거부된다.
 */
function signedReceiptFor(card: RunCard, evidence: ProbeEvidence): ExecutionAuthorizationReceipt {
  const facts: ReceiptFacts = {
    cardId: card.cardId,
    cardHash: card.cardHash,
    immutableCardPath: card.immutableCardPath,
    probeEvidenceId: evidence.evidenceId,
    probeEvidenceHash: evidence.evidencePayloadHash,
    immutableEvidencePath: card.probeEvidencePath!,
    requiresP0Attestation: false,
    protocolVersion: card.protocolVersion,
    criteriaHash: card.criteriaHash,
    registrySnapshotHash: evidence.registrySnapshotHash,
    adapterContractVersion: evidence.adapterContractVersion,
    stage: "smoke",
    outputDir: card.outputDir,
    fixtures: card.fixtureHashes.map((f) => ({ ...f })).sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : 1)),
    arms: [...card.stage.arms].sort(),
    repetitions: card.stage.repetitions,
    seed: card.seed,
    maxConcurrency: card.maxConcurrency,
    executor: { providerId: card.models!.executor.providerId, modelId: card.models!.executor.modelId },
    reviewer: { providerId: card.models!.reviewer.providerId, modelId: card.models!.reviewer.modelId },
    approvedLimitUsd: card.approvedLimitUsd!,
    credentialBinding: buildCredentialBinding(RECEIPT_CREDENTIAL_PURPOSE, credentialsFrom(), "b".repeat(64)),
  };
  const receipt = buildExecutionReceipt({
    facts,
    spec: {
      stage: "smoke",
      fixtureIds: card.stage.fixtureIds,
      arms: card.stage.arms,
      repetitions: card.stage.repetitions,
      maxConcurrency: card.maxConcurrency,
      seed: card.seed,
      outputDir: card.outputDir,
      approvedLimitUsd: card.approvedLimitUsd!,
      executorModelId: card.models!.executor.modelId,
      reviewerModelId: card.models!.reviewer.modelId,
      runCardPath: card.immutableCardPath,
      probeEvidencePath: card.probeEvidencePath!,
    },
    createdAt: "2026-07-30T01:00:00.000Z",
    receiptId: TEST_RECEIPT_ID,
  });
  return receipt;
}

/** 순수 `attestP0` 테스트용 — 기록의 `receiptHash`(더미)와 짝을 맞춘다. */
function receiptFor(card: RunCard, evidence: ProbeEvidence): ExecutionAuthorizationReceipt {
  return { ...signedReceiptFor(card, evidence), receiptHash: TEST_RECEIPT_HASH };
}

/** attestP0의 나머지 입력. 테스트마다 다시 적으면 검사 축이 조용히 빠진다. */
function attestInput(
  card: RunCard,
  evidence: ProbeEvidence,
  records: readonly GateRunRecord[],
  budgetEvents: readonly BudgetEvent[]
): AttestationInput {
  return {
    card,
    receipt: receiptFor(card, evidence),
    evidence,
    records,
    budgetEvents,
    currentFixtureHashes: new Map(card.fixtureHashes.map((f) => [f.fixtureId, f.hash])),
    expectedModelFor: (arm, role) =>
      modelForRole(arm, role, {
        executorModelId: card.models!.executor.modelId,
        reviewerModelId: card.models!.reviewer.modelId,
      }),
    modelIdAccepted: (modelId, reported) => {
      const entry = lookupModel(modelId);
      if (!entry) return { ok: false, reason: `레지스트리에 ${modelId} 엔트리가 없습니다` };
      return providerModelIdAccepted(entry, reported);
    },
    createdAt: "2026-07-30T02:00:00.000Z",
  };
}

function p0Records(card: RunCard, evidence: ProbeEvidence): GateRunRecord[] {
  const out: GateRunRecord[] = [];
  for (const fixtureId of card.stage.fixtureIds) {
    for (const arm of card.stage.arms) {
      const fixture = card.fixtureHashes.find((f) => f.fixtureId === fixtureId)!;
      // arm마다 역할 배정이 다르다 — Arm B는 anthropic 하나뿐이라 reviewer가 드롭되고
      // 카드의 reviewer 모델이 executor 자리에 앉는다(arms.ts `modelForRole`).
      const executorModel = modelForRole(arm, "executor", {
        executorModelId: evidence.executor.requestedModelId,
        reviewerModelId: evidence.reviewer.requestedModelId,
      })!;
      const reviewerModel = modelForRole(arm, "reviewer", {
        executorModelId: evidence.executor.requestedModelId,
        reviewerModelId: evidence.reviewer.requestedModelId,
      });
      const reported = (modelId: string): string =>
        modelId === evidence.executor.requestedModelId
          ? evidence.executor.providerReportedModelId
          : evidence.reviewer.providerReportedModelId;

      const calls: ProviderCallFact[] = [
        {
          callId: "draft:1",
          role: "executor",
          attempt: 0,
          providerId: "p",
          requestedModelId: executorModel,
          providerReportedModelId: reported(executorModel),
          dispatchState: "response_received_with_usage",
          inputTokens: 500,
          outputTokens: 100,
          costUsd: 0.01,
          status: "succeeded",
          startedAt: "2026-07-29T00:00:00Z",
        },
      ];
      if (reviewerModel !== undefined) {
        calls.push({
          callId: "review:1",
          role: "reviewer",
          attempt: 0,
          providerId: "p",
          requestedModelId: reviewerModel,
          providerReportedModelId: reported(reviewerModel),
          dispatchState: "response_received_with_usage",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          status: "succeeded",
          startedAt: "2026-07-29T00:00:01Z",
        });
      }

      out.push({
        ...sampleRecord(fixtureId, arm as "A" | "B" | "C" | "D", 1),
        fixtureHash: fixture.hash,
        category: fixture.category as GateRunRecord["category"],
        providerCallCount: calls.length,
        costUsd: 0.01,
        inputTokens: 500,
        outputTokens: 100,
        providerCalls: calls,
        eventsReadable: true,
        receiptId: TEST_RECEIPT_ID,
        receiptHash: TEST_RECEIPT_HASH,
        // 품질 메타데이터일 뿐 — exact-model 검증의 근거가 아니다(§2.8).
        returnedModelId: reported(executorModel),
        oracleVerificationPassed: true,
        publicVerificationPassed: true,
      });
    }
  }
  return out;
}

/** 각 기록에 대응하는 정상 예약 이벤트(개시 + 정산). */
function p0Events(records: readonly GateRunRecord[]): BudgetEvent[] {
  const events: BudgetEvent[] = [];
  records.forEach((record, i) => {
    const id = `${record.fixtureId}/${record.arm}/rep${record.repetition}#${i + 1}`;
    const base = {
      eventVersion: 2,
      at: "T",
      runId: "p0",
      stage: "smoke",
      approvedLimitUsd: 30,
      cumulativeUsd: 0,
      correlationId: id,
      reservedUsd: 0.5,
    } as const;
    events.push({ ...base, type: "reservation_opened" });
    events.push({
      ...base,
      type: "reservation_settled",
      actualUsd: record.costUsd ?? 0,
      usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens },
    });
  });
  return events;
}

// ---------------------------------------------------------------------------
// 54~57. CLI 수준 차단 — 종료 코드와 "기록이 없다"로 확인한다 (§11)
//
// **환경에서 실제 키를 지우고 실행한다.** 로직이 깨져도 네트워크로 나갈 수 없는 상태에서
// 종료 코드를 확인하므로, 이 테스트들이 유료 호출을 유발할 경로가 없다.
// ---------------------------------------------------------------------------

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      // 실제 키를 상속하지 않는다. PATH 등 필수만 남긴다.
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...env,
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * CLI에 넘길 **가짜** 자격증명.
 *
 * 값이 실제 키가 아니므로 이 환경으로는 공급자에 연결할 수 없다. 그런데도 넣는 이유는
 * preflight의 "자격증명 없음" 차단을 지나 **그 뒤의 게이트**(run-card, 예약 상태)를
 * 실제로 검증하기 위한 것이다.
 */
const CLI_FAKE_KEYS = { OPENAI_API_KEY: "test-openai-key-value", ANTHROPIC_API_KEY: "test-anthropic-key-value" };

/**
 * CLI 테스트가 쓰는 **TypeScript 전용** fixture.
 *
 * # 왜 Rust fixture를 쓰지 않는가
 *
 * preflight는 Rust fixture가 하나라도 있으면 MSVC 툴체인을 요구하고, 없으면 blocker로 막는다.
 * 그건 정당한 차단이지만 **run-card 게이트보다 먼저** 일어난다. Visual Studio가 없는 Windows에서
 * 이 테스트들이 "카드가 없어서 거부"가 아니라 "MSVC가 없어서 거부"로 실패했다 — 실측으로 그랬다.
 * Linux에서는 `prepareMsvcEnv`가 `not_needed`를 주므로 드러나지 않는 종류의 차이다.
 *
 * 확인하려는 것은 승인 게이트이고 네이티브 툴체인과 무관하므로, fixture를 TypeScript로 좁혀
 * 그 축을 아예 제거한다. 아래 `assertReachedGate`가 "네이티브 fixture 0개"를 확인하므로,
 * 나중에 누가 Rust fixture를 다시 넣으면 **Linux에서도** 실패한다.
 */
function typescriptFixtures(): LoadedFixture[] {
  const all = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const ts = all.filter((f) => f.manifest.language === "typescript");
  assert.ok(ts.length > 0, "TypeScript fixture가 없습니다");
  // `selectSmokeFixtures`와 같은 결정론(id 순 첫 항목)을 쓴다.
  return [...ts].sort((a, b) => a.manifest.fixtureId.localeCompare(b.manifest.fixtureId)).slice(0, 1);
}

/**
 * preflight를 지나 **승인 게이트까지 도달했는지** 확인한다.
 *
 * 이 확인이 없으면 "다른 이유로 거부됐는데 테스트는 통과"가 가능하다 — 그게 이번 Windows
 * 실패에서 드러난 문제의 반대편이다.
 */
function assertReachedGate(result: CliResult): void {
  assert.ok(
    result.stdout.includes("네이티브(Rust) fixture: 0개"),
    `Rust fixture가 섞였습니다 — MSVC 유무에 따라 결과가 달라집니다:\n${result.stdout.slice(0, 400)}`
  );
  assert.ok(
    !result.stdout.includes("MSVC 미준비"),
    `preflight의 MSVC blocker에 걸렸습니다 — 승인 게이트에 도달하지 못했습니다:\n${result.stdout.slice(0, 400)}`
  );
}

test("54. --run-card 없는 유료 pilot은 기록을 하나도 만들지 않고 거부된다", () => {
  withDir((dir) => {
    const smoke = typescriptFixtures();
    const result = runCli(
      [
        "pilot",
        "--fixtures",
        smoke.map((f) => f.manifest.fixtureId).join(","),
        "--stage",
        "smoke",
        "--max-cost-usd",
        "5",
        "--output",
        dir,
      ],
      CLI_FAKE_KEYS
    );
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assertReachedGate(result);
    assert.ok(result.stdout.includes("--run-card가 필수입니다"), result.stdout);
    assert.ok(result.stdout.includes("실제 API 호출: 0건"), result.stdout);
    // **기록이 없다** = host를 띄우지 않았다 = provider를 부르지 않았다.
    assert.equal(existsSync(path.join(dir, RECORDS_FILE)), false, "기록 파일이 생겼습니다");
    // run.json도 만들지 않는다 — 승인되지 않은 실행이 디렉터리를 건드려서는 안 된다.
    assert.equal(existsSync(path.join(dir, "run.json")), false, "승인 전에 메타 파일을 썼습니다");
  });
});

/**
 * CLI 수준 테스트가 쓰는 **완전한 승인 번들.**
 *
 * plan-pilot이 만드는 것과 같은 구조(immutable evidence + immutable card)를 만들고, 카드가
 * 출력한 실행 argv를 그대로 돌려준다. 이렇게 하면 §2.9의 round trip("카드가 출력한 명령을
 * 그대로 실행하면 그 카드의 authorization을 통과한다")이 **모든 CLI 테스트에서 자동으로**
 * 검증된다 — 인자를 손으로 조립하면 그 보장이 사라진다.
 */
function approvalBundle(
  base: string,
  options: { credentialEnv?: NodeJS.ProcessEnv; executorModel?: string; reviewerModel?: string } = {}
): { card: RunCard; evidence: ProbeEvidence; cliArgs: string[]; evidenceFile: string; runDir: string } {
  const fixtures = typescriptFixtures();
  const now = new Date().toISOString();
  const registry = new ModelRegistry(BUILTIN_MODELS);
  const models = planModels({
    credentialPresence: () => true,
    ...(options.executorModel ? { executorModel: options.executorModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
  });
  assert.ok(isModelPlan(models));
  if (!isModelPlan(models)) throw new Error("모델 계획 실패");

  const binding = computeCredentialBinding(credentialsFrom(options.credentialEnv ?? CLI_FAKE_KEYS));
  assert.ok(binding);
  const evidence = buildProbeEvidence({
    createdAt: now,
    protocolVersion: CRITERIA.protocolVersion,
    criteriaHash: criteriaHash(),
    registrySnapshotHash: registry.snapshotHash(),
    adapterContractVersion: "2",
    executor: roleEvidenceFor(models.executor.modelId, models.executor.providerId),
    reviewer: roleEvidenceFor(models.reviewer.modelId, models.reviewer.providerId),
    approvedProbeLimitUsd: 1,
    cumulativeProbeCostUsd: 0.004,
    credentialBinding: binding!,
  });
  const approvals = approvalPaths(base);
  const evidenceStore = storeApprovalArtifact(approvals.evidence, evidence.evidenceId, evidence);

  const cards = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: base,
    p0ApprovedLimitUsd: 5,
    p1ApprovedLimitUsd: 50,
    models,
    createdAt: now,
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => path.join(a, b),
  });
  assert.equal(cards.p0.status, "READY_FOR_P0_APPROVAL", cards.p0.blockers.join(" / "));
  writeRunCard(cards.p0);

  return {
    card: cards.p0,
    evidence,
    // 카드가 출력한 명령의 CLI 부분. **손으로 조립하지 않는다.**
    cliArgs: ["pilot", ...cards.p0.runArgv.slice(cards.p0.runArgv.indexOf("--") + 1)],
    evidenceFile: evidenceStore.file,
    runDir: cards.p0.outputDir,
  };
}

test("54b. 유효한 카드가 있어도 열린 예약이 있으면 provider를 부르지 않는다", () => {
  withDir((base) => {
    const bundle = approvalBundle(base);

    // 열린 예약을 남긴다 — 이전 실행이 예약 개시 후 죽은 상태.
    mkdirSync(bundle.runDir, { recursive: true });
    appendFileSync(
      path.join(bundle.runDir, "budget-events.jsonl"),
      `${JSON.stringify({
        eventVersion: 2,
        type: "reservation_opened",
        at: new Date().toISOString(),
        runId: "previous",
        stage: "smoke",
        correlationId: "prev#1",
        approvedLimitUsd: 5,
        reservedUsd: 0.5,
        cumulativeUsd: 0,
      })}\n`
    );

    const result = runCli(bundle.cliArgs, CLI_FAKE_KEYS);
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assertReachedGate(result);
    // 카드와 evidence는 통과했다 — 그래야 다음 게이트가 실제로 막았음을 알 수 있다.
    assert.ok(result.stdout.includes("실행 승인 receipt"), result.stdout);
    assert.ok(result.stdout.includes("BLOCKED_UNRESOLVED_RESERVATION"), result.stdout);
    assert.ok(result.stdout.includes("사용 가능한 예산으로 되돌리지 않습니다"), result.stdout);
    // provider를 부르지 않았다.
    assert.equal(existsSync(path.join(bundle.runDir, RECORDS_FILE)), false, "기록 파일이 생겼습니다");
    // 이벤트 파일을 고치지도 않았다.
    const events = eventsIn(bundle.runDir);
    assert.equal(events.filter((e) => e.type === "reservation_opened").length, 1);
    assert.equal(events.filter((e) => e.type === "reservation_released").length, 0);
  });
});

test("54c. evidence의 자격증명이 다르면 유효한 카드로도 실행되지 않는다", () => {
  withDir((base) => {
    // **다른 키**로 binding을 만든 evidence. 카드는 정상이지만 이 실행을 보증하지 않는다.
    const bundle = approvalBundle(base, {
      credentialEnv: { OPENAI_API_KEY: "some-other-openai-key", ANTHROPIC_API_KEY: "some-other-anthropic-key" },
    });

    const result = runCli(bundle.cliArgs, CLI_FAKE_KEYS);
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assertReachedGate(result);
    assert.ok(result.stdout.includes("BLOCKED_INVALID_PROBE_EVIDENCE"), result.stdout);
    assert.ok(result.stdout.includes("probe 당시와 다릅니다"), result.stdout);
    assert.equal(existsSync(path.join(bundle.runDir, RECORDS_FILE)), false, "기록 파일이 생겼습니다");
    // receipt도 만들지 않았다 — adapter 생성 전에 막혔다는 뜻이다.
    assert.equal(existsSync(path.join(bundle.runDir, "execution-authorizations.jsonl")), false);
  });
});


test("55. 상한 없이 유료 실행/probe를 시작할 수 없다 (종료 코드 3)", () => {
  withDir((dir) => {
    for (const command of ["pilot", "run", "probe-models"]) {
      const result = runCli([command, "--output", dir]);
      assert.equal(result.code, 3, `${command}: ${result.stdout}${result.stderr}`);
      assert.ok(result.stderr.includes("--max-cost-usd가 필수입니다"), result.stderr);
      assert.equal(existsSync(path.join(dir, RECORDS_FILE)), false);
    }
  });
});

test("56. budget-status는 읽기 전용이며 미해결 예약을 그대로 보여준다", () => {
  withDir((dir) => {
    crashAfterOpen(dir);
    const status = runCli(["budget-status", "--output", dir, "--max-cost-usd", "5"]);
    assert.equal(status.code, 2, status.stdout);
    assert.ok(status.stdout.includes("BLOCKED_UNRESOLVED_RESERVATION"), status.stdout);
    assert.ok(status.stdout.includes("미해결 예약: 1건"), status.stdout);
    assert.ok(status.stdout.includes("자동으로 정리하지 않습니다"), status.stdout);
    assert.ok(status.stdout.includes("재개 가능: 불가"), status.stdout);
    // **파일을 고치지 않는다.** 예약이 해제되거나 이벤트가 지워지지 않았다.
    const events = eventsIn(dir);
    assert.equal(events.filter((e) => e.type === "reservation_opened").length, 1);
    assert.equal(events.filter((e) => e.type === "reservation_released").length, 0);
    assert.equal(existsSync(path.join(dir, RECORDS_FILE)), false);
  });
});

test("57. dry-run 출력이 reviewer를 포함한 총 상한을 쓴다", () => {
  withDir((dir) => {
    const result = runCli(["dry-run", "--repetitions", "3", "--output", dir]);
    assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("최대 provider 호출 수(총 상한): 1,584회"), result.stdout);
    assert.ok(result.stdout.includes("reviewer(검수 1 + revise 2): 432회"), result.stdout);
    assert.ok(!/최대 API 호출 수/.test(result.stdout), "executor-only 수치를 최대라고 불렀습니다");
  });
});

// ---------------------------------------------------------------------------
// 58~72. M0.1 — 승인 아티팩트 무결성, 실행 증적 체인, 호출별 과금 사실 (§3)
//
// 이 절의 테스트들은 **하나의 결함군**을 겨냥한다: "해시가 있다"와 "해시가 지킨다"는 다르고,
// "카드가 있다"와 "그 카드로 실행됐다"는 다르며, "실패했다"와 "안 썼다"는 다르다.
// ---------------------------------------------------------------------------

test("58. canonical JSON이 중첩 key를 재귀 정렬하고 배열 순서를 보존한다", () => {
  // 같은 내용이면 key 순서와 무관하게 같은 문자열.
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  // 배열은 순서가 의미다 — 정렬하면 argv가 무의미해진다.
  assert.notEqual(canonicalJson(["a", "b"]), canonicalJson(["b", "a"]));
  // 중첩 깊이와 무관하게 값이 살아남는다(예전 array replacer가 여기서 전부 지웠다).
  assert.ok(canonicalJson({ a: { b: { c: { d: "deep" } } } }).includes("deep"));

  // 표현 불가능한 값은 **경로와 함께** 거부한다.
  for (const [label, value] of [
    ["undefined", { a: undefined }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["함수", { a: (): void => undefined }],
    ["symbol", { a: Symbol("x") }],
    ["bigint", { a: BigInt(1) }],
    ["Date(toJSON)", { a: new Date(0) }],
  ] as [string, unknown][]) {
    assert.throws(() => canonicalJson(value), CanonicalJsonError, `${label}를 통과시켰습니다`);
  }

  // 해시는 64 hex 전체다 — 잘라 쓰지 않는다.
  assert.match(artifactHash({ a: 1 }), /^[0-9a-f]{64}$/);
});

test("59. 승인 아티팩트의 모든 중첩 보안 필드 변경이 해시를 바꾼다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const evidence = validEvidence();
  const cards = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    p1ApprovedLimitUsd: 300,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  });
  const card = cards.p0;

  // **중첩 필드를 하나씩** 바꾼다. 예전 구현은 이 전부를 통과시켰다 — array replacer가
  // 중첩 객체를 `{}`로 만들었기 때문이다.
  const mutations: { label: string; mutate: (c: RunCard) => RunCard }[] = [
    {
      label: "fixtureHashes[0].hash",
      mutate: (c) => ({ ...c, fixtureHashes: c.fixtureHashes.map((f, i) => (i === 0 ? { ...f, hash: "x" } : f)) }),
    },
    {
      label: "fixtureHashes[0].category",
      mutate: (c) => ({
        ...c,
        fixtureHashes: c.fixtureHashes.map((f, i) => (i === 0 ? { ...f, category: "async_ordering" } : f)),
      }),
    },
    {
      label: "fixtureHashes[0].language",
      mutate: (c) => ({
        ...c,
        fixtureHashes: c.fixtureHashes.map((f, i) => (i === 0 ? { ...f, language: "rust" } : f)),
      }),
    },
    {
      label: "models.executor.modelId",
      mutate: (c) => ({ ...c, models: { ...c.models!, executor: { ...c.models!.executor, modelId: "other" } } }),
    },
    {
      label: "models.executor.inputPerMTok",
      mutate: (c) => ({ ...c, models: { ...c.models!, executor: { ...c.models!.executor, inputPerMTok: 999 } } }),
    },
    {
      label: "models.reviewer.modelId",
      mutate: (c) => ({ ...c, models: { ...c.models!, reviewer: { ...c.models!.reviewer, modelId: "other" } } }),
    },
    {
      label: "models.readiness[0].credentialPresent",
      mutate: (c) => ({
        ...c,
        models: {
          ...c.models!,
          readiness: c.models!.readiness.map((r, i) => (i === 0 ? { ...r, credentialPresent: !r.credentialPresent } : r)),
        },
      }),
    },
    {
      label: "models.readiness[0].liveProbe",
      mutate: (c) => ({
        ...c,
        models: {
          ...c.models!,
          readiness: c.models!.readiness.map((r, i) => (i === 0 ? { ...r, liveProbe: "failed" as const } : r)),
        },
      }),
    },
    { label: "stage.fixtureIds", mutate: (c) => ({ ...c, stage: { ...c.stage, fixtureIds: ["nope"] } }) },
    { label: "stage.repetitions", mutate: (c) => ({ ...c, stage: { ...c.stage, repetitions: 9 } }) },
    {
      label: "stage.callBudget.total",
      mutate: (c) => ({ ...c, stage: { ...c.stage, callBudget: { ...c.stage.callBudget, total: 1 } } }),
    },
    {
      label: "stage.perArmMaxCostUsd[0].maxUsd",
      mutate: (c) => ({
        ...c,
        stage: {
          ...c.stage,
          perArmMaxCostUsd: c.stage.perArmMaxCostUsd.map((a, i) => (i === 0 ? { ...a, maxUsd: 999 } : a)),
        },
      }),
    },
    {
      label: "arms[0].providers",
      mutate: (c) => ({ ...c, arms: c.arms.map((a, i) => (i === 0 ? { ...a, providers: ["evil"] } : a)) }),
    },
    {
      label: "arms[0].reviewMode",
      mutate: (c) => ({ ...c, arms: c.arms.map((a, i) => (i === 0 ? { ...a, reviewMode: "informed" } : a)) }),
    },
    {
      label: "arms[0].draftSource",
      mutate: (c) => ({ ...c, arms: c.arms.map((a, i) => (i === 0 ? { ...a, draftSource: "replay(Arm A)" } : a)) }),
    },
    { label: "runArgv", mutate: (c) => ({ ...c, runArgv: [...c.runArgv, "--evil"] }) },
    { label: "resumeArgv", mutate: (c) => ({ ...c, resumeArgv: [...c.resumeArgv, "--evil"] }) },
    { label: "approvedLimitUsd", mutate: (c) => ({ ...c, approvedLimitUsd: 9_999 }) },
    { label: "probeEvidenceHash", mutate: (c) => ({ ...c, probeEvidenceHash: "0".repeat(64) }) },
  ];

  for (const mutation of mutations) {
    const { cardHash: _drop, ...rest } = mutation.mutate(card);
    assert.notEqual(
      runCardHash(rest as Omit<RunCard, "cardHash">),
      card.cardHash,
      `${mutation.label}를 바꿔도 cardHash가 그대로입니다`
    );
  }
});

test("60. P0 attestation의 중첩 checks 변조가 해시를 바꾸고 검증에서 막힌다", () => {
  const fixtures = loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT));
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;
  const records = p0Records(card, evidence);
  const outcome = attestP0(attestInput(card, evidence, records, p0Events(records)));
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reasons.join(" / "));
  if (!outcome.ok) return;
  const attestation = outcome.attestation;

  const expect = {
    probeEvidenceId: evidence.evidenceId,
    probeEvidenceHash: evidence.evidencePayloadHash,
    criteriaHash: criteriaHash(),
    protocolVersion: CRITERIA.protocolVersion,
    executorModelId: card.models!.executor.modelId,
    reviewerModelId: card.models!.reviewer.modelId,
  };
  assert.equal(validateP0Attestation(attestation, expect).ok, true);

  // **중첩 checks 변조.** 예전 해시는 checks 배열 안을 전혀 보지 않았다 —
  // 실패한 검사를 통과로 바꾸고 해시를 그대로 둬도 통과했다.
  const mutations: { label: string; mutate: () => unknown }[] = [
    {
      label: "checks[0].passed",
      mutate: () => ({ ...attestation, checks: attestation.checks.map((c, i) => (i === 0 ? { ...c, passed: false } : c)) }),
    },
    {
      label: "checks[0].name",
      mutate: () => ({ ...attestation, checks: attestation.checks.map((c, i) => (i === 0 ? { ...c, name: "x" } : c)) }),
    },
    {
      label: "checks[0].detail",
      mutate: () => ({ ...attestation, checks: attestation.checks.map((c, i) => (i === 0 ? { ...c, detail: "x" } : c)) }),
    },
    {
      label: "attestedCalls[0].providerReportedModelId",
      mutate: () => ({
        ...attestation,
        attestedCalls: attestation.attestedCalls.map((c, i) => (i === 0 ? { ...c, providerReportedModelId: "x" } : c)),
      }),
    },
    {
      label: "fixtures[0].hash",
      mutate: () => ({ ...attestation, fixtures: attestation.fixtures.map((f, i) => (i === 0 ? { ...f, hash: "x" } : f)) }),
    },
    { label: "receiptId", mutate: () => ({ ...attestation, receiptId: "other" }) },
  ];
  for (const mutation of mutations) {
    const verdict = validateP0Attestation(mutation.mutate(), expect);
    assert.equal(verdict.ok, false, `${mutation.label}를 바꿔도 통과했습니다`);
    if (!verdict.ok) assert.ok(verdict.reasons.some((r) => r.includes("해시")), `${mutation.label}: ${verdict.reasons.join(" / ")}`);
  }
});

test("61. 승인 아티팩트는 같은 id에 다른 내용을 쓸 수 없다", () => {
  withDir((dir) => {
    const first = storeApprovalArtifact(dir, "card-1", { a: 1, nested: { b: 2 } });
    assert.equal(first.created, true);

    // 같은 내용의 재저장은 idempotent — 정상 흐름을 실패로 만들지 않는다.
    const again = storeApprovalArtifact(dir, "card-1", { nested: { b: 2 }, a: 1 });
    assert.equal(again.created, false);
    assert.equal(again.file, first.file);

    // **중첩 필드 하나만 달라도 충돌이다.**
    assert.throws(
      () => storeApprovalArtifact(dir, "card-1", { a: 1, nested: { b: 3 } }),
      ArtifactConflictError,
      "같은 id에 다른 내용을 덮어썼습니다"
    );

    // 경로를 벗어나는 id는 파일 이름이 되지 못한다.
    for (const bad of ["../escape", "a/b", "", "."]) {
      assert.throws(() => storeApprovalArtifact(dir, bad, { a: 1 }), /아티팩트 id/, `id ${JSON.stringify(bad)}`);
    }
  });
});

test("62. plan-pilot을 다시 실행해도 기존 카드가 바뀌지 않는다", () => {
  withDir((dir) => {
    const fixtures = typescriptFixtures();
    const build = (createdAt: string, limit: number): RunCard =>
      buildStagedCards({
        fixtures,
        arms: ["A", "B", "C", "D"],
        seed: 1,
        maxConcurrency: 1,
        outputRoot: dir,
        p0ApprovedLimitUsd: limit,
        models: planModels({ credentialPresence: () => true }),
        createdAt,
        credentialsPresent: true,
        probeEvidence: validEvidence(),
        joinPath: (a, b) => path.join(a, b),
      }).p0;

    const first = build("2026-07-30T00:00:00.000Z", 30);
    const firstWrite = writeRunCard(first);
    const firstBytes = readFileSync(firstWrite.cardFile, "utf8");

    // 조건을 바꿔 다시 계획하면 **새 id의 새 파일**이 생긴다.
    const second = build("2026-07-30T03:00:00.000Z", 40);
    const secondWrite = writeRunCard(second);
    assert.notEqual(second.cardId, first.cardId);
    assert.notEqual(secondWrite.cardFile, firstWrite.cardFile);

    // 원래 카드는 바이트까지 그대로다.
    assert.equal(readFileSync(firstWrite.cardFile, "utf8"), firstBytes);
    const reloaded = loadRunCard(firstWrite.cardFile);
    assert.equal(reloaded.ok, true);
    if (reloaded.ok) assert.equal(reloaded.card.approvedLimitUsd, 30);

    // 포인터는 최신을 가리키지만 **카드로 해석되지 않는다** — 승인 근거가 될 수 없다.
    const pointerLoad = loadRunCard(secondWrite.pointerFile);
    assert.equal(pointerLoad.ok, false);
    if (!pointerLoad.ok) assert.ok(pointerLoad.reasons.some((r) => r.includes("안내용 포인터")));
  });
});

test("63. 카드가 기록한 경로가 아닌 사본은 승인 근거가 되지 못한다", () => {
  withDir((dir) => {
    const card = buildStagedCards({
      fixtures: typescriptFixtures(),
      arms: ["A", "B", "C", "D"],
      seed: 1,
      maxConcurrency: 1,
      outputRoot: dir,
      p0ApprovedLimitUsd: 30,
      models: planModels({ credentialPresence: () => true }),
      createdAt: "2026-07-30T00:00:00.000Z",
      credentialsPresent: true,
      probeEvidence: validEvidence(),
      joinPath: (a, b) => path.join(a, b),
    }).p0;
    const written = writeRunCard(card);

    // 바이트가 같아도 **다른 경로**의 사본은 거부한다. 사본은 덮어쓰일 수 있다.
    const copy = path.join(dir, "copy-of-card.json");
    writeFileSync(copy, readFileSync(written.cardFile, "utf8"));
    const loaded = loadRunCard(copy);
    assert.equal(loaded.ok, false, "사본이 승인 근거로 통과했습니다");
    if (!loaded.ok) assert.ok(loaded.reasons.some((r) => r.includes("다른 경로")), loaded.reasons.join(" / "));
  });
});

test("64. 카드가 출력한 명령이 그 카드의 authorization을 통과한다 (모델 override 포함)", () => {
  const fixtures = typescriptFixtures();
  for (const override of [
    {},
    { executorModel: "gpt-5.1", reviewerModel: "claude-sonnet-5" },
  ] as { executorModel?: string; reviewerModel?: string }[]) {
    const models = planModels({ credentialPresence: () => true, ...override });
    assert.ok(isModelPlan(models));
    if (!isModelPlan(models)) continue;
    const evidence = validEvidence({
      executor: roleEvidenceFor(models.executor.modelId, models.executor.providerId),
      reviewer: roleEvidenceFor(models.reviewer.modelId, models.reviewer.providerId),
    });
    const card = buildStagedCards({
      fixtures,
      arms: ["A", "B", "C", "D"],
      seed: 7,
      maxConcurrency: 1,
      // **이 테스트만 경로를 플랫폼에 맞춘다.** 아래에서 카드의 명령을 `parseArgs`로 되읽는데,
      // 그쪽은 `--output`을 `path.resolve`하기 때문이다. POSIX 절대경로를 그대로 주면
      // Windows에서 `/tmp/run/p0-smoke` → `H:\tmp\run\p0-smoke`가 되어 카드와 요청이 갈리고,
      // 실제로는 성립하는 왕복이 실패로 보인다(실제 CLI는 `options.output`을 이미 resolve해
      // 카드를 만들므로 양쪽이 같다). 다른 테스트들은 resolve를 지나지 않아 상관없다.
      outputRoot: path.resolve("/tmp/run"),
      p0ApprovedLimitUsd: 30,
      models,
      createdAt: "2026-07-30T00:00:00.000Z",
      credentialsPresent: true,
      probeEvidence: evidence,
      joinPath: (a, b) => path.join(a, b),
    }).p0;
    assert.equal(card.status, "READY_FOR_P0_APPROVAL", card.blockers.join(" / "));

    // **카드가 출력한 명령을 그대로 파싱해** 실행 요청을 만든다. 손으로 조립하지 않는다.
    const parsed = parseArgs(["pilot", ...card.runArgv.slice(card.runArgv.indexOf("--") + 1)], "/tmp/default");
    assert.equal(parsed.executorModel, models.executor.modelId, "카드 명령에 --executor-model이 없습니다");
    assert.equal(parsed.reviewerModel, models.reviewer.modelId, "카드 명령에 --reviewer-model이 없습니다");
    assert.equal(parsed.probeEvidence, path.resolve(card.probeEvidencePath!));
    assert.equal(parsed.runCard, path.resolve(card.immutableCardPath));

    const verdict = authorizeRunCard(card, {
      stage: parsed.stage!,
      outputDir: parsed.output,
      fixtures: card.fixtureHashes.map((f) => ({ ...f })),
      arms: parsed.arms,
      repetitions: parsed.repetitions,
      maxConcurrency: parsed.maxConcurrency,
      seed: parsed.seed,
      maxCostUsd: parsed.maxCostUsd,
      executorModelId: parsed.executorModel!,
      reviewerModelId: parsed.reviewerModel!,
      runCardPath: card.immutableCardPath,
      probeEvidencePath: card.probeEvidencePath!,
      now: "2026-07-30T01:00:00.000Z",
    });
    assert.equal(
      verdict.ok,
      true,
      `override=${JSON.stringify(override)}: ${verdict.ok ? "" : verdict.reasons.join(" / ")}`
    );
  }
});

test("65. P1 카드 명령은 P0 attestation 경로를 싣는다", () => {
  const fixtures = typescriptFixtures();
  const evidence = validEvidence();
  const attestationPath = "/tmp/run/approvals/attestations/p0-abc.json";
  const cards = buildStagedCards({
    fixtures,
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    p1ApprovedLimitUsd: 300,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    p0Attestation: { attestationId: "p0-abc", attestationHash: "a".repeat(64), path: attestationPath },
    joinPath: (a, b) => `${a}/${b}`,
  });
  assert.equal(cards.p1.status, "READY_FOR_P1_APPROVAL", cards.p1.blockers.join(" / "));
  const parsed = parseArgs(["pilot", ...cards.p1.runArgv.slice(cards.p1.runArgv.indexOf("--") + 1)], "/tmp/d");
  assert.equal(parsed.p0Attestation, path.resolve(attestationPath));

  // P0 카드에는 attestation 플래그가 없다 — 요구하지 않는 단계다.
  const p0Parsed = parseArgs(["pilot", ...cards.p0.runArgv.slice(cards.p0.runArgv.indexOf("--") + 1)], "/tmp/d");
  assert.equal(p0Parsed.p0Attestation, undefined);
});

test("66. 실행 승인 receipt는 조건이 다르면 같은 디렉터리를 재사용하지 않는다", () => {
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures: typescriptFixtures(),
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;
  const receipt = receiptFor(card, evidence);
  const base = factsOf(receipt);

  // 같은 조건 → 재사용.
  assert.equal(reuseOrConflict([receipt], base).kind, "reuse");
  // 아무것도 없으면 새로 만든다.
  assert.equal(reuseOrConflict([], base).kind, "create");

  // **조건이 하나라도 다르면 충돌이다** — 예산 상향도 새 승인이다.
  const conflicts: { label: string; facts: ReceiptFacts }[] = [
    { label: "예산 상향", facts: { ...base, approvedLimitUsd: base.approvedLimitUsd + 10 } },
    {
      label: "fixture 내용 변경",
      facts: { ...base, fixtures: base.fixtures.map((f, i) => (i === 0 ? { ...f, hash: "changed" } : f)) },
    },
    { label: "seed", facts: { ...base, seed: 99 } },
    { label: "모델", facts: { ...base, executor: { ...base.executor, modelId: "other" } } },
    { label: "카드", facts: { ...base, cardId: "other-card" } },
    { label: "evidence", facts: { ...base, probeEvidenceId: "other-evidence" } },
  ];
  for (const conflict of conflicts) {
    const verdict = reuseOrConflict([receipt], conflict.facts);
    assert.equal(verdict.kind, "conflict", `${conflict.label}가 달라도 재사용했습니다`);
  }
});

test("67. receipt에 키 원문·prefix·suffix가 없고 해시가 내용을 지킨다", () => {
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures: typescriptFixtures(),
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;
  const receipt = receiptFor(card, evidence);
  const text = JSON.stringify(receipt);

  for (const key of Object.values(FAKE_KEYS)) {
    assert.ok(!text.includes(key), "receipt에 키 원문이 있습니다");
    assert.ok(!text.includes(key.slice(0, 8)), "receipt에 키 prefix가 있습니다");
    assert.ok(!text.includes(key.slice(-8)), "receipt에 키 suffix가 있습니다");
  }
  // 변수 이름은 남는다 — 그건 자격증명이 아니라 "어디서 읽었는가"다.
  assert.ok(text.includes("OPENAI_API_KEY"));

  // **HMAC 키가 API 키다**: 키가 다르면 다이제스트가 다르고, salt만 알아서는 만들 수 없다.
  const withOtherKey = buildCredentialBinding(RECEIPT_CREDENTIAL_PURPOSE, [
    { providerId: "openai", envName: "OPENAI_API_KEY", value: "a-different-key" },
  ], "b".repeat(64));
  assert.notEqual(withOtherKey.providers[0]!.digest, receipt.credentialBinding.providers[0]!.digest);
  assert.equal(
    credentialBindingMatchesResolved(receipt.credentialBinding, credentialsFrom()).ok,
    true
  );
  assert.equal(
    credentialBindingMatchesResolved(receipt.credentialBinding, [
      { providerId: "openai", envName: "OPENAI_API_KEY", value: "wrong" },
      { providerId: "anthropic", envName: "ANTHROPIC_API_KEY", value: "wrong" },
    ]).ok,
    false
  );
  // 목적 문자열이 메시지에 들어가므로 evidence용 다이제스트와 같아지지 않는다.
  assert.notEqual(
    credentialDigest({ purpose: "other", salt: "b".repeat(64), providerId: "openai", envName: "E", keyValue: "k" }),
    credentialDigest({ purpose: RECEIPT_CREDENTIAL_PURPOSE, salt: "b".repeat(64), providerId: "openai", envName: "E", keyValue: "k" })
  );
});

test("68. auth/429/5xx/timeout은 remote attempt 이후 예약을 해제하지 않는다", () => {
  const call = (dispatchState: DispatchState, costUsd?: number): ProviderCallFact => ({
    callId: "draft:1",
    role: "executor",
    attempt: 0,
    providerId: "openai",
    requestedModelId: "gpt-4.1",
    dispatchState,
    ...(costUsd !== undefined ? { costUsd } : {}),
    status: costUsd === undefined ? "failed" : "succeeded",
    startedAt: "T",
  });

  // **핵심 회귀**: 호출이 시작된 흔적이 없어도 HTTP 분류만으로 not_dispatched를 추론하지 않는다.
  for (const failureClass of ["rate_limit", "provider_5xx", "network_timeout", "host_crash"]) {
    assert.equal(
      classifyDispatch({ providerCalls: [], eventsReadable: true, failureClass }),
      "dispatched_no_response",
      `${failureClass}를 not_dispatched로 판정했습니다`
    );
  }
  // 호출 이전 단계의 실패만 해제 근거다.
  for (const failureClass of ["auth_failure", "fixture_setup_failure", "toolchain_unavailable"]) {
    assert.equal(classifyDispatch({ providerCalls: [], eventsReadable: true, failureClass }), "not_dispatched");
  }
  // 이벤트를 못 읽었으면 "모른다" — 절대 해제하지 않는다.
  assert.equal(
    classifyDispatch({ providerCalls: [], eventsReadable: false, failureClass: "auth_failure" }),
    "dispatched_no_response"
  );
  // 개시만 있고 종결이 없는 호출(crash)도 불확실이다.
  assert.equal(
    classifyDispatch({ providerCalls: [call("dispatched_no_response")], eventsReadable: true }),
    "dispatched_no_response"
  );
  // 전부 정상이면 정산 가능.
  assert.equal(
    classifyDispatch({
      providerCalls: [call("response_received_with_usage", 0.01)],
      eventsReadable: true,
      costUsd: 0.01,
    }),
    "response_received_with_usage"
  );
});

test("69. executor 성공 + reviewer 실패에서 확정 비용을 잃지 않는다", () => {
  const executorCall: ProviderCallFact = {
    callId: "draft:1",
    role: "executor",
    attempt: 0,
    providerId: "openai",
    requestedModelId: "gpt-4.1",
    providerReportedModelId: "gpt-4.1",
    dispatchState: "response_received_with_usage",
    inputTokens: 1_000,
    outputTokens: 200,
    costUsd: 0.02,
    status: "succeeded",
    startedAt: "T1",
  };
  const reviewerFailure: ProviderCallFact = {
    callId: "review:1",
    role: "reviewer",
    attempt: 0,
    providerId: "anthropic",
    requestedModelId: "claude-sonnet-5",
    dispatchState: "dispatched_no_response",
    errorKind: "transient",
    status: "failed",
    startedAt: "T2",
  };
  const record = { providerCalls: [executorCall, reviewerFailure], eventsReadable: true, costUsd: 0.02 };

  // 판정은 "불확실"이지만 **확정분이 있다**는 사실이 함께 보존된다.
  assert.equal(classifyDispatch(record), "dispatched_no_response");
  const split = partitionSettlement(record);
  assert.equal(split.measuredUsd, 0.02);
  assert.equal(split.measuredCalls, 1);
  assert.equal(split.uncertainCalls, 1);

  // 원장은 확정분을 누적하고 나머지를 미해결로 남긴다 — **전액 해제하지 않는다.**
  const events: BudgetEvent[] = [];
  const ledger = createBudgetLedger(10, { runId: "r", stage: "smoke", onEvent: (e) => events.push(e), now: () => "T" });
  const reservation = ledger.reserve({ maxUsd: 0.5, basis: "b" }, "rec");
  assert.ok(reservation.ok);
  if (!reservation.ok) return;
  const outcome = reservation.reservation.settlePartial({
    measured: {
      cost: { measured: true, usd: split.measuredUsd },
      usage: { measured: true, inputTokens: 1_000, outputTokens: 200 },
      providerKind: "real",
      requestedModelId: "gpt-4.1",
      providerReportedModelId: "gpt-4.1",
      dispatchState: "response_received_with_usage",
    },
    unresolved: { dispatchState: "dispatched_no_response", reason: "reviewer 5xx" },
  });
  assert.equal(outcome.ok, true);

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.sessionCommittedUsd, 0.02, "확정된 executor 비용이 사라졌습니다");
  assert.equal(snapshot.unresolvedUsd, 0.48, "남은 예약이 미해결로 남지 않았습니다");
  assert.equal(snapshot.reservationsReleased, 0, "예약을 해제했습니다");
  assert.equal(snapshot.state, "UNRESOLVED_RESERVATION");

  // 상태 머신도 같은 사실을 말한다: 알려진 지출과 최대 미해결 노출이 **따로** 보인다.
  const analysis = analyzeBudgetEvents(events);
  assert.equal(analysis.settledUsd, 0.02);
  assert.equal(analysis.unresolvedUsd, 0.48);
  assert.equal(analysis.reservations[0]!.outcome, "partially_settled");
  // 그리고 이 디렉터리는 자동 재개가 불가능하다.
  assert.equal(reconcileBudget({ recordsUsd: 0.02, events }).ok, false);

  const rendered = renderBudgetStatus(
    budgetStatus({ runDir: "/tmp/x", records: [], eventRead: { ok: true, events, truncatedLastLine: false } })
  ).join("\n");
  assert.ok(rendered.includes("알려진 지출"), rendered);
  assert.ok(rendered.includes("최대 미해결 노출"), rendered);
});

test("70. 재시도한 모든 attempt의 dispatch 사실이 보존된다", async () => {
  const attempts: number[] = [];
  const failure = (attempt: number): ProviderCallFailure =>
    new ProviderCallFailure({
      message: `attempt ${attempt} 실패`,
      // 첫 시도는 usage까지 받았다(=과금됐다). 재시도는 응답을 못 받았다.
      dispatchState: attempt === 0 ? "response_received_with_usage" : "dispatched_no_response",
      classification: { kind: "transient", message: "5xx", retryable: true },
      ...(attempt === 0 ? { usage: { inputTokens: 100, outputTokens: 10 }, providerReportedModelId: "gpt-4.1" } : {}),
    });

  await assert.rejects(
    async () =>
      callWithRetry(
        async (attempt) => {
          attempts.push(attempt);
          throw failure(attempt);
        },
        { maxRetries: 1, rateLimitBaseMs: 0, rateLimitCapMs: 0, transientBaseMs: 0, transientCapMs: 0 },
        { sleep: async () => undefined }
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCallFailed);
      const failed = error as ProviderCallFailed;
      // **모든 attempt의 사실이 남는다.** 마지막만 보면 첫 시도의 과금이 보이지 않는다.
      assert.equal(failed.facts.length, 2, JSON.stringify(failed.facts));
      assert.equal(failed.facts[0]!.dispatchState, "response_received_with_usage");
      assert.equal(failed.facts[0]!.usage?.inputTokens, 100);
      assert.equal(failed.facts[0]!.providerReportedModelId, "gpt-4.1");
      assert.equal(failed.facts[1]!.dispatchState, "dispatched_no_response");
      return true;
    }
  );

  // 평범한 Error는 dispatch를 **모르므로** 불확실이 기본이다.
  assert.equal(attemptFacts(0, new Error("plain"), "unknown").dispatchState, "dispatched_no_response");
});

test("71. credential resolver가 별칭 하나는 허용하고 충돌은 차단한다", () => {
  const primary = { OPENAI_API_KEY: "value-1" };
  const alias = { TOMVERSE_OPENAI_API_KEY: "value-1" };
  const same = { OPENAI_API_KEY: "value-1", TOMVERSE_OPENAI_API_KEY: "value-1" };
  const conflicting = { OPENAI_API_KEY: "value-1", TOMVERSE_OPENAI_API_KEY: "value-2" };

  const resolvedPrimary = resolveCredential("openai", "OPENAI_API_KEY", primary);
  assert.equal(resolvedPrimary.ok, true);
  if (resolvedPrimary.ok) assert.equal(resolvedPrimary.envName, "OPENAI_API_KEY");

  // **별칭만 있어도 실행할 수 있어야 한다** — preflight가 인정하던 것을 factory도 인정한다.
  const resolvedAlias = resolveCredential("openai", "OPENAI_API_KEY", alias);
  assert.equal(resolvedAlias.ok, true);
  if (resolvedAlias.ok) assert.equal(resolvedAlias.envName, "TOMVERSE_OPENAI_API_KEY");

  // 값이 같으면 정본 이름을 쓴다.
  const resolvedSame = resolveCredential("openai", "OPENAI_API_KEY", same);
  assert.equal(resolvedSame.ok, true);
  if (resolvedSame.ok) assert.deepEqual(resolvedSame.duplicates, ["TOMVERSE_OPENAI_API_KEY"]);

  // **값이 다르면 조용히 고르지 않는다.**
  const ambiguous = resolveCredential("openai", "OPENAI_API_KEY", conflicting);
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.kind, "ambiguous");
    assert.ok(ambiguous.reason.includes("서로 다른 값"));
    // 사유에 키 값이 들어가면 안 된다.
    assert.ok(!ambiguous.reason.includes("value-1") && !ambiguous.reason.includes("value-2"));
  }

  // 없으면 **확인한 이름 전부**를 알려준다.
  const missing = resolveCredential("openai", "OPENAI_API_KEY", {});
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.kind, "missing");
    assert.deepEqual(missing.checked, ["OPENAI_API_KEY", "TOMVERSE_OPENAI_API_KEY"]);
  }

  // preflight도 같은 판정을 쓴다 — "있지만 쓸 수 없다"를 "있다"로 보고하지 않는다.
  assert.equal(credentialPresent("openai", alias), true);
  assert.equal(credentialPresent("openai", conflicting), false);
  assert.ok(credentialProblem("openai", conflicting)?.includes("서로 다른 값"));

  // adapter factory도 같은 resolver를 지난다.
  const entry = lookupModel("gpt-4.1")!;
  assert.throws(
    () => createAdapter(entry, { role: "executor", modelId: entry.modelId, providerId: entry.providerId, reason: "test" }, { env: conflicting }),
    (error: unknown) => {
      assert.ok(error instanceof MissingCredentialError);
      assert.equal((error as MissingCredentialError).kind, "ambiguous");
      return true;
    },
    "factory가 충돌하는 별칭 중 하나를 조용히 골랐습니다"
  );
});

test("72. v1 승인 아티팩트는 fail-closed로 거부되고 다시 만들라고 안내한다", () => {
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures: typescriptFixtures(),
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;

  withDir((dir) => {
    // v1로 표기된 카드 — 자동 마이그레이션하지 않는다.
    const file = path.join(dir, "old-card.json");
    writeFileSync(file, JSON.stringify({ ...card, cardSchemaVersion: 1 }, null, 2));
    const loaded = loadRunCard(file);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.ok(loaded.reasons.some((r) => r.includes("스키마 버전")), loaded.reasons.join(" / "));
      assert.ok(loaded.reasons.some((r) => r.includes("plan-pilot")), "다시 만드는 방법을 알려주지 않습니다");
    }
  });

  const oldEvidence = validateProbeEvidence(
    { ...evidence, schemaVersion: 1 },
    {
      now: "2026-07-30T01:00:00.000Z",
      ...EVIDENCE_BINDING,
      executorModelId: "gpt-4.1",
      reviewerModelId: "claude-sonnet-5",
      credentials: credentialsFrom(),
    }
  );
  assert.equal(oldEvidence.ok, false);
  if (!oldEvidence.ok) assert.ok(oldEvidence.reasons.some((r) => r.includes("probe-models")));

  // 32자리로 잘린 예전 해시는 형식 검사에서 먼저 걸린다.
  const truncated = verifyArtifactHash({ ...card, cardHash: card.cardHash.slice(0, 32) }, "cardHash");
  assert.equal(truncated.ok, false);
  if (!truncated.ok) assert.ok(truncated.reason.includes("64자리"));
});

test("73. 서로 다른 실행 승인을 섞은 기록으로는 attestation을 만들지 않는다", () => {
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures: loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT)),
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;
  const records = p0Records(card, evidence);

  // 한 기록만 다른 승인을 가리킨다 — 두 승인의 결과가 한 디렉터리에 섞인 상태.
  const mixed = records.map((r, i) => (i === 0 ? { ...r, receiptId: "other-receipt" } : r));
  const verdict = attestP0(attestInput(card, evidence, mixed, p0Events(mixed)));
  assert.equal(verdict.ok, false, "서로 다른 승인의 기록을 섞었는데 attestation을 만들었습니다");
  if (!verdict.ok) {
    assert.ok(
      verdict.reasons.some((r) => r.includes("같은 실행 승인")),
      verdict.reasons.join(" / ")
    );
  }

  // receipt를 아예 달지 않은 기록도 마찬가지다 — "어느 승인으로 실행됐는지" 말할 수 없다.
  const unlinked = records.map(({ receiptId: _a, receiptHash: _b, ...r }) => r);
  assert.equal(attestP0(attestInput(card, evidence, unlinked, p0Events(unlinked))).ok, false);
});

test("74. P1은 카드가 가리키는 attestation이 바뀌면 실행 직전에 막힌다", () => {
  const evidence = validEvidence();
  const card = buildStagedCards({
    fixtures: loadAllFixtures(FIXTURES_ROOT, listFixtureIds(FIXTURES_ROOT)),
    arms: ["A", "B", "C", "D"],
    seed: 1,
    maxConcurrency: 1,
    outputRoot: "/tmp/run",
    p0ApprovedLimitUsd: 30,
    models: planModels({ credentialPresence: () => true }),
    createdAt: "2026-07-30T00:00:00.000Z",
    credentialsPresent: true,
    probeEvidence: evidence,
    joinPath: (a, b) => `${a}/${b}`,
  }).p0;
  const records = p0Records(card, evidence);
  const made = attestP0(attestInput(card, evidence, records, p0Events(records)));
  assert.ok(made.ok, made.ok ? "" : made.reasons.join(" / "));
  if (!made.ok) return;
  const attestation = made.attestation;

  const baseExpect = {
    probeEvidenceId: evidence.evidenceId,
    probeEvidenceHash: evidence.evidencePayloadHash,
    criteriaHash: criteriaHash(),
    protocolVersion: CRITERIA.protocolVersion,
    executorModelId: card.models!.executor.modelId,
    reviewerModelId: card.models!.reviewer.modelId,
  };

  // P1 카드가 기록한 id/hash와 같으면 통과.
  assert.equal(
    validateP0Attestation(attestation, {
      ...baseExpect,
      attestationId: attestation.attestationId,
      attestationHash: attestation.attestationHash,
    }).ok,
    true
  );

  // **카드를 만든 뒤 다른 attestation으로 바뀌었다면** 카드 해시로는 드러나지 않는다.
  // 그래서 실행 직전에 id/hash를 다시 대조한다.
  for (const drift of [
    { attestationId: "p0-someone-else", attestationHash: attestation.attestationHash },
    { attestationId: attestation.attestationId, attestationHash: "f".repeat(64) },
    { receiptId: "other-receipt" },
  ]) {
    const verdict = validateP0Attestation(attestation, { ...baseExpect, ...drift });
    assert.equal(verdict.ok, false, `${JSON.stringify(drift)}로도 통과했습니다`);
  }

  // 확인한 provider 호출이 0건인 attestation은 실행 경로를 증명하지 못한다.
  // 해시까지 다시 계산해 둔다 — 해시 검사가 아니라 **내용 검사**가 막는지 확인하기 위해서다.
  const { attestationHash: _drop, ...emptyCalls } = { ...attestation, attestedCalls: [] };
  const rehashed = { ...emptyCalls, attestationHash: artifactHash(emptyCalls) };
  const verdict = validateP0Attestation(rehashed, baseExpect);
  assert.equal(verdict.ok, false, "확인한 호출이 0건인 attestation을 통과시켰습니다");
  if (!verdict.ok) assert.ok(verdict.reasons.some((r) => r.includes("호출이 0건")), verdict.reasons.join(" / "));
});

// ---------------------------------------------------------------------------
// 75. attest-p0가 attestation을 **어디에** 쓰는가 (§10.10)
//
// `attest-p0 --output`은 P0 **실행** 디렉터리다 — records.jsonl이 거기 있기 때문이다.
// 그런데 승인 번들(cards/evidence/attestations)은 단계 디렉터리의 **형제**여야 한다.
// approvalStore.ts가 그 이유를 적어두었다: "P0와 P1이 같은 번들을 공유한다 — evidence 하나가
// 두 단계의 근거이고, P1 카드가 P0 attestation을 가리키기 때문이다."
//
// 실행 디렉터리로 번들 위치를 계산하면 attestation이 `<run-dir>/approvals/`에 떨어지고,
// P1 카드를 만드는 `plan-pilot --output <root>`은 `<root>/approvals/attestations/`를 보므로
// 그것을 **찾지 못한다.** 증상이 고약한 이유: attest-p0는 성공(exit 0)을 보고하고 파일도
// 실제로 만들어지므로, 사라진 것은 결과가 아니라 **다음 단계와의 연결**이다.
// ---------------------------------------------------------------------------

test("75. attest-p0는 카드가 지정한 승인 번들에 attestation을 쓴다", () => {
  withDir((base) => {
    const bundle = approvalBundle(base);
    const card = bundle.card;

    // 카드가 요구한 기록 전부 + 그것을 승인한 receipt를 P0 실행 디렉터리에 놓는다.
    // receipt는 **해시를 그대로 둔 판**이어야 한다 — CLI가 읽으면서 검증한다.
    const receipt = signedReceiptFor(card, bundle.evidence);
    const records = p0Records(card, bundle.evidence).map((r) => ({
      ...r,
      receiptId: receipt.receiptId,
      receiptHash: receipt.receiptHash,
    }));
    mkdirSync(card.outputDir, { recursive: true });
    const jsonl = (rows: readonly unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    writeFileSync(path.join(card.outputDir, "records.jsonl"), jsonl(records));
    writeFileSync(path.join(card.outputDir, "budget-events.jsonl"), jsonl(p0Events(records)));
    writeFileSync(path.join(card.outputDir, "execution-authorizations.jsonl"), jsonl([receipt]));

    const result = runCli(["attest-p0", "--output", card.outputDir], CLI_FAKE_KEYS);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    // 카드·evidence와 **같은 번들**에 있어야 한다. 그래야 plan-pilot이 찾는다.
    const attestations = approvalPaths(base).attestations;
    assert.ok(existsSync(attestations), `승인 번들에 attestation이 없습니다:\n${result.stdout}`);
    assert.equal(readdirSync(attestations).filter((f) => f.endsWith(".json")).length, 1, result.stdout);
    assert.equal(attestations, path.join(card.approvalsDir, "attestations"));

    // 실행 디렉터리 아래에 두 번째 번들이 생기지 않는다.
    assert.equal(
      existsSync(path.join(card.outputDir, "approvals")),
      false,
      `승인 번들이 단계 디렉터리 아래로 갈라졌습니다:\n${result.stdout}`
    );
  });
});
