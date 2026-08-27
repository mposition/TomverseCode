import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { armExecutionOrder, ARMS, armSpec } from "../src/arms.js";
import { artifactsPresent, HOST_BIN, REPO_ROOT, resolveProviderArgs } from "../src/host.js";
import { loadAllFixtures, loadFixture, listFixtureIds } from "../src/manifest.js";
import { openRecordStore } from "../src/records.js";
import { budgetStop, fillReviewerContributions, runExperiment } from "../src/runner.js";
import { evaluateGate } from "../src/stats.js";
import { renderMarkdown, writeReports } from "../src/report.js";
import { preflight } from "../src/preflight.js";
import { classifyOracleFailure, runVerification } from "../src/oracle.js";
import { applyReferencePatch, changedFilesSince, injectOracle, materialize } from "../src/workspace.js";
import { isInfrastructureFailure, type GateRunRecord } from "../src/types.js";
import { hostBinaryPath, withMsvcEnv } from "@tomverse/toolchain";

/**
 * 하네스 자체를 **실제 구성요소로** 검증한다 (§16).
 *
 * 여기서 진짜인 것: 실제 `tomverse-host` 프로세스, 실제 Policy Gate, 실제 Tool Runtime,
 * 실제 파일 시스템, 실제 oracle 실행.
 * 가짜인 것: **LLM 응답 하나뿐**이다.
 *
 * 이 테스트들은 실제 API를 부르지 않으므로 `npm test`에서 항상 돈다.
 * 그리고 그렇게 만든 기록은 `providerKind: "fake"`로 남아 **가설 판정에 쓰이지 않는다** —
 * 그 사실 자체를 아래에서 검증한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures");

/**
 * 임시 디렉터리 안에서 실행하고 **끝난 뒤에** 지운다.
 *
 * 동기 버전(`try { return fn(dir) } finally { rm() }`)을 비동기 콜백에 쓰면 `finally`가
 * 첫 `await` 직후 바로 돌아 **작업 도중에 디렉터리가 사라진다.** 실제로 그 버그 때문에
 * resume 테스트가 "이미 끝난 조합을 다시 실행"으로 잘못 실패했다.
 */
function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-harness-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-harness-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- fixture 격리와 oracle 비노출 ----

test("arm마다 격리된 workspace에서 시작한다", () => {
  const fixture = loadFixture(FIXTURES, "stm-01-loop-bound");
  const a = materialize(fixture, "iso-a");
  const b = materialize(fixture, "iso-b");
  try {
    assert.notEqual(a.root, b.root);
    // 한쪽을 바꿔도 다른 쪽은 최초 상태다.
    writeFileSync(path.join(a.root, "loop.js"), "// 오염\n");
    assert.equal(changedFilesSince(fixture, a.root).length, 1);
    assert.deepEqual(changedFilesSince(fixture, b.root), [], "arm 간 상태가 새어나갔습니다");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("oracle은 실행 전 workspace에 없고, 주입해야 나타난다", () => {
  const fixture = loadFixture(FIXTURES, "stm-01-loop-bound");
  const ws = materialize(fixture, "oracle-visibility");
  try {
    assert.equal(existsSync(path.join(ws.root, "oracle.test.js")), false, "모델이 정답 테스트를 볼 수 있습니다");
    injectOracle(fixture, ws.root);
    assert.equal(existsSync(path.join(ws.root, "oracle.test.js")), true);
  } finally {
    ws.cleanup();
  }
});

test("초기 상태는 oracle 실패, 참조 patch 적용 후 통과", () => {
  const fixture = loadFixture(FIXTURES, "stm-01-loop-bound");
  const before = materialize(fixture, "ref-before");
  try {
    injectOracle(fixture, before.root);
    assert.equal(
      runVerification(fixture.manifest.oracleVerificationCommands, before.root, 60_000).passed,
      false
    );
  } finally {
    before.cleanup();
  }

  const after = materialize(fixture, "ref-after");
  try {
    applyReferencePatch(fixture, after.root);
    injectOracle(fixture, after.root);
    assert.equal(runVerification(fixture.manifest.oracleVerificationCommands, after.root, 60_000).passed, true);
  } finally {
    after.cleanup();
  }
});

// ---- arm 구성 ----

test("초안을 재생하는 arm은 초안을 만드는 arm 뒤에 온다", () => {
  const order = armExecutionOrder(["C", "D", "A", "B"]);
  assert.ok(order.indexOf("A") < order.indexOf("C"), "Arm C가 Arm A보다 먼저 실행됩니다");
  assert.ok(order.indexOf("A") < order.indexOf("D"));
});

test("초안 제공 arm 없이 재생 arm만 고르면 거부한다", () => {
  assert.throws(() => armExecutionOrder(["C"]), /같은 초안을 공유해야/);
});

test("Arm C와 D는 같은 초안을 공유하도록 정의되어 있다", () => {
  const c = armSpec("C");
  const d = armSpec("D");
  assert.equal(c.draftSource, "replay");
  assert.equal(d.draftSource, "replay");
  assert.equal(c.draftSourceArm, d.draftSourceArm, "C와 D가 다른 초안을 씁니다 — review mode 비교가 성립하지 않습니다");
  assert.notEqual(c.reviewMode, d.reviewMode, "C와 D의 review mode가 같으면 비교할 것이 없습니다");
});

test("단독 arm은 공급자를 하나만 갖는다 (라우터가 reviewer를 스스로 드롭한다)", () => {
  assert.deepEqual(armSpec("A").providers, ["openai"]);
  assert.deepEqual(armSpec("B").providers, ["anthropic"]);
  assert.equal(armSpec("C").providers.length, 2);
});

// ---- dry-run과 예산 ----

test("dry-run은 API를 부르지 않고 계획만 만든다", async () => {
  await withDirAsync(async (dir) => {
    const fixtures = loadAllFixtures(FIXTURES).slice(0, 3);
    const store = openRecordStore(path.join(dir, "records.jsonl"));
    const result = await runExperiment({
      fixtures,
      arms: ["A", "C"],
      repetitions: 2,
      seed: 7,
      store,
      runId: "dry",
      dryRun: true,
    });
    assert.equal(result.planned, 3 * 2 * 2);
    assert.equal(result.executed, 0);
    assert.equal(store.count(), 0, "dry-run이 기록을 남겼습니다");
    // 계획에도 초안 의존성이 지켜져야 한다.
    const firstFixture = result.dryRunPlan![0]!.fixtureId;
    const forFixture = result.dryRunPlan!.filter((p) => p.fixtureId === firstFixture && p.repetition === 1);
    assert.ok(forFixture.findIndex((p) => p.arm === "A") < forFixture.findIndex((p) => p.arm === "C"));
  });
});

test("같은 seed는 같은 실행 순서를 만든다", async () => {
  await withDirAsync(async (dir) => {
    const fixtures = loadAllFixtures(FIXTURES).slice(0, 5);
    const plan = async (seed: number): Promise<string> => {
      const store = openRecordStore(path.join(dir, `r-${seed}-${Math.random()}.jsonl`));
      const result = await runExperiment({
        fixtures, arms: ["A", "C"], repetitions: 2, seed, store, runId: "p", dryRun: true,
      });
      return result.dryRunPlan!.map((p) => `${p.fixtureId}:${p.arm}:${p.repetition}`).join("|");
    };
    assert.equal(await plan(11), await plan(11));
    assert.notEqual(await plan(11), await plan(12), "seed가 달라도 순서가 같습니다 — 무작위화가 동작하지 않습니다");
  });
});

// ---- 실제 host를 태우는 통합 (fake LLM) ----

const FIXED_PATCH = [
  "--- a/loop.js",
  "+++ b/loop.js",
  "@@ -1,1 +1,1 @@",
  "-// 작업이 성공할 때까지 재시도한다. 상한이 있어야 한다.",
  "+// 수정 시도 (fake provider)",
  "",
].join("\n");

test("실제 tomverse-host를 태워 기록이 채워진다 (LLM만 fake)", async () => {
  const artifacts = artifactsPresent();
  assert.ok(artifacts.ok, `e2e 산출물이 없습니다.\n${artifacts.detail}`);

  await withDirAsync(async (dir) => {
    const fixtures = [loadFixture(FIXTURES, "stm-01-loop-bound")];
    const store = openRecordStore(path.join(dir, "records.jsonl"));
    const result = await runExperiment({
      fixtures,
      arms: ["A"],
      repetitions: 1,
      seed: 3,
      store,
      runId: "fake-run",
      fakeScript: { defaultPatch: FIXED_PATCH },
      onProgress: () => undefined,
    });

    assert.equal(result.executed, 1);
    const record = store.all()[0]!;
    // **fake 기록임이 남아야 한다** — 이게 없으면 가설 판정에서 걸러낼 수 없다.
    assert.equal(record.providerKind, "fake");
    assert.equal(record.arm, "A");
    assert.equal(record.fixtureId, "stm-01-loop-bound");
    assert.ok(record.latencyMs > 0, "지연이 기록되지 않았습니다");
    assert.ok(record.startedAt <= record.completedAt);
    assert.ok(record.criteriaHash.length > 0);
    // 이 patch로는 실제 버그가 고쳐지지 않으므로 oracle은 실패해야 한다.
    assert.equal(record.oracleVerificationPassed, false, "주석만 바꿨는데 oracle이 통과했습니다");
    assert.ok(record.failureClass !== undefined, "실패 분류가 없습니다");
  });
});

test("resume은 완료된 조합을 다시 실행하지 않는다", async () => {
  assert.ok(artifactsPresent().ok);
  await withDirAsync(async (dir) => {
    const fixtures = [loadFixture(FIXTURES, "stm-01-loop-bound")];
    const file = path.join(dir, "records.jsonl");

    const first = await runExperiment({
      fixtures, arms: ["A"], repetitions: 1, seed: 3,
      store: openRecordStore(file), runId: "r1",
      fakeScript: { defaultPatch: FIXED_PATCH },
    });
    assert.equal(first.executed, 1);

    const second = await runExperiment({
      fixtures, arms: ["A"], repetitions: 1, seed: 3,
      store: openRecordStore(file), runId: "r2",
      fakeScript: { defaultPatch: FIXED_PATCH },
    });
    assert.equal(second.executed, 0, "이미 끝난 조합을 다시 실행했습니다");
    assert.equal(second.skippedResume, 1);
    assert.equal(openRecordStore(file).count(), 1, "중복 기록이 생겼습니다");
  });
});

test("예산 소진 판정이 경계에서 정확하다", () => {
  // fake provider는 단가가 0이라 예산을 소진시킬 수 없다. 그래서 이 결정은 순수 함수로
  // 떼어내 직접 검증한다 — 실제 돈이 걸린 분기를 "우연히 안 돌았다"로 남겨두지 않는다.
  assert.equal(budgetStop(0, undefined), false, "상한이 없으면 멈추지 않는다");
  assert.equal(budgetStop(999, undefined), false);
  assert.equal(budgetStop(0, 1), false);
  assert.equal(budgetStop(0.99, 1), false);
  assert.equal(budgetStop(1, 1), true, "정확히 상한에 도달하면 새 호출을 시작하지 않는다");
  assert.equal(budgetStop(1.5, 1), true);
});

test("fake 실행은 실제 공급자에 닿지 않는다", () => {
  // 이 검사가 순수 함수인 이유: 키가 없는 기계에서는 실제 공급자가 후보에 없어 어떤 통합
  // 테스트든 통과한다. 그러면 **키가 있을 때만 나는 결함**을 잡지 못한다 — 실제로 그래서
  // 오래 살아남았다. 실행 결과가 아니라 "무엇을 요청하는가"를 직접 본다.
  assert.deepEqual(resolveProviderArgs(["openai"], true), ["fake-a"]);
  assert.deepEqual(resolveProviderArgs(["anthropic"], true), ["fake-b"]);
  assert.deepEqual(resolveProviderArgs(["openai", "anthropic"], true), ["fake-a", "fake-b"]);

  // 실제 실행은 그대로 실제 공급자로 간다.
  assert.deepEqual(resolveProviderArgs(["openai", "anthropic"], false), ["openai", "anthropic"]);

  // 이미 가짜인 이름은 건드리지 않는다 (triageCalibration이 그렇게 넘긴다).
  assert.deepEqual(resolveProviderArgs(["fake-a", "fake-b"], true), ["fake-a", "fake-b"]);

  // **개수가 보존되어야 arm의 의미가 유지된다** — 단독 arm은 reviewer가 드롭되고
  // 교차검증 arm은 독립 reviewer가 배정되는데, 그 판단이 공급자 개수로 이뤄지기 때문이다.
  for (const spec of ARMS) {
    const mapped = resolveProviderArgs(spec.providers, true);
    assert.equal(mapped.length, spec.providers.length, `Arm ${spec.arm}의 공급자 개수가 바뀌었습니다`);
    assert.equal(new Set(mapped).size, mapped.length, `Arm ${spec.arm}에 중복 공급자가 생겼습니다`);
    for (const provider of mapped) {
      assert.ok(provider.startsWith("fake-"), `Arm ${spec.arm}이 fake 실행에서 실제 공급자 ${provider}를 요청합니다`);
    }
  }
});

test("fake 실행은 비용을 잴 수 없어도 중단하지 않는다", async () => {
  // 예전에는 여기서 "경고만 하고 계속" 도는 것을 확인했다. 지금은 **실제 공급자**일 때만
  // 중단하고(safety.test.ts 5번), fake는 단가 0이 정상이므로 끝까지 돈다.
  // 두 경로를 구별하지 못하면 fake 하네스 테스트가 매번 중단되거나, 유료 실행이 계속 돌게 된다.
  assert.ok(artifactsPresent().ok);
  await withDirAsync(async (dir) => {
    const fixtures = [loadFixture(FIXTURES, "stm-01-loop-bound")];
    const store = openRecordStore(path.join(dir, "records.jsonl"));
    const result = await runExperiment({
      fixtures,
      arms: ["A"],
      repetitions: 1,
      seed: 3,
      store,
      runId: "budget-warn",
      maxCostUsd: 10,
      fakeScript: { defaultPatch: FIXED_PATCH },
      // realProvider를 켜지 않는다 — fake 실행이다.
    });
    assert.equal(result.unmeasurableCostAbort, false, "fake 실행인데 비용 미측정으로 중단했습니다");
    assert.equal(result.executed, 1);
    const record = store.all()[0]!;
    assert.notEqual(record.failureClass, "cost_unmeasurable");
    if (record.costUsd !== undefined) {
      assert.equal(record.costUsd, 0, "fake 모델의 단가는 0이어야 합니다");
    }
  });
});

// ---- counterfactual 분류 ----

test("초안/검수 후 결과로 correction과 harm이 채워진다", () => {
  const base = (fixtureId: string, arm: "A" | "C", oraclePassed: boolean): GateRunRecord =>
    ({
      schemaVersion: 1, runId: "r", fixtureId, fixtureHash: "h", category: "multi_file_contract",
      repetition: 1, arm, seed: 1, taskId: "t", providerId: "p", requestedModelId: "m",
      publicVerificationPassed: true, oracleVerificationPassed: oraclePassed,
      inputTokens: 0, outputTokens: 0, providerCallCount: 0, retryCount: 0, latencyMs: 1,
      providerCalls: [], eventsReadable: true,
      changedFiles: [], policyDenials: [], promptVersionHash: "p",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z",
      providerKind: "fake", criteriaHash: "h",
    }) as GateRunRecord;

  const records = fillReviewerContributions([
    base("a", "A", false), base("a", "C", true),   // correction
    base("b", "A", true), base("b", "C", false),   // harm
    base("c", "A", true), base("c", "C", true),    // no_measurable_correction
    base("d", "A", false), base("d", "C", false),  // ineffective
  ]);
  const byFixture = (id: string) => records.find((r) => r.fixtureId === id && r.arm === "C")!;
  assert.equal(byFixture("a").reviewerContribution, "correction");
  assert.equal(byFixture("b").reviewerContribution, "harm");
  assert.equal(byFixture("c").reviewerContribution, "no_measurable_correction");
  assert.equal(byFixture("d").reviewerContribution, "ineffective");
  assert.equal(byFixture("a").draftOraclePassed, false);
  assert.equal(byFixture("a").reviewedOraclePassed, true);
});

// ---- fake 결과가 판정으로 오인되지 않는다 ----

test("fake 기록으로는 절대 PASS가 나오지 않는다", async () => {
  assert.ok(artifactsPresent().ok);
  await withDirAsync(async (dir) => {
    const fixtures = [loadFixture(FIXTURES, "stm-01-loop-bound")];
    const store = openRecordStore(path.join(dir, "records.jsonl"));
    await runExperiment({
      fixtures, arms: ["A"], repetitions: 1, seed: 3, store, runId: "fake",
      fakeScript: { defaultPatch: FIXED_PATCH },
    });
    const evaluation = evaluateGate(store.all(), { seed: 3 });
    assert.equal(evaluation.verdict, "INCONCLUSIVE");
    assert.ok(evaluation.reasons.some((r) => r.includes("fake")), evaluation.reasons.join(" / "));
  });
});

// ---- preflight와 리포트 ----

test("자격증명이 없으면 실제 실험을 돌릴 수 없다고 보고한다", () => {
  const saved = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TOMVERSE_OPENAI_API_KEY;
    delete process.env.TOMVERSE_ANTHROPIC_API_KEY;
    const report = preflight({ fixtureCount: 24, arms: ["A", "B", "C", "D"], repetitions: 3, usingFakeProvider: false });
    assert.equal(report.canRunRealExperiment, false);
    assert.ok(report.blockers.some((b) => b.includes("OPENAI")));
    assert.ok(report.blockers.some((b) => b.includes("ANTHROPIC")));
    // 값이 아니라 존재 여부만 보고한다.
    assert.ok(report.lines.every((l) => !l.includes("sk-")));
  } finally {
    if (saved.openai) process.env.OPENAI_API_KEY = saved.openai;
    if (saved.anthropic) process.env.ANTHROPIC_API_KEY = saved.anthropic;
  }
});

test("리포트가 실제 API 미실행을 명시한다", () => {
  withDir((dir) => {
    const evaluation = evaluateGate([], { seed: 1 });
    const markdown = renderMarkdown(evaluation, [], {
      runId: "r", seed: 1, generatedAt: "2026-01-01T00:00:00.000Z", realApiExecuted: false,
    });
    assert.ok(markdown.includes("INCONCLUSIVE"));
    assert.ok(markdown.includes("실제 API 실험이 실행되지 않았습니다"));

    const paths = writeReports(dir, evaluation, [], {
      runId: "r", seed: 1, generatedAt: "2026-01-01T00:00:00.000Z", realApiExecuted: false,
    });
    for (const file of Object.values(paths)) assert.ok(existsSync(file), `${file}이 생성되지 않았습니다`);
    const summary = JSON.parse(readFileSync(paths.summaryJson, "utf8"));
    assert.equal(summary.verdict, "INCONCLUSIVE");
    assert.equal(summary.meta.realApiExecuted, false);
    assert.ok(summary.meta.pricingSnapshotDate);
  });
});

test("모든 arm 정의가 리포트에 문서화된다", () => {
  const markdown = renderMarkdown(evaluateGate([], { seed: 1 }), [], {
    runId: "r", seed: 1, generatedAt: "t", realApiExecuted: false,
  });
  for (const arm of ARMS) assert.ok(markdown.includes(arm.label), `${arm.arm} 설명이 리포트에 없습니다`);
});

test("fixture 목록이 비어 있지 않다", () => {
  assert.ok(listFixtureIds(FIXTURES).length >= 24);
});

// ---- Windows 툴체인 안정화 회귀 (Gate 쪽) ----

test("툴체인 준비 실패는 모델 실패와 다른 분류가 된다", () => {
  // 이 둘을 뭉개면 "Rust fixture에서 모델이 약하다"는 잘못된 결론이 나온다.
  const toolchain = classifyOracleFailure({
    passed: false,
    commands: [],
    toolchainError: "MSVC 빌드 도구를 준비하지 못했습니다 (종료 코드 1).",
  });
  assert.equal(toolchain, "toolchain_unavailable");
  assert.equal(isInfrastructureFailure(toolchain), true, "툴체인 실패가 모델 실패로 집계됩니다");

  const modelFailure = classifyOracleFailure({
    passed: false,
    commands: [
      {
        command: "node --test oracle.test.js",
        exitCode: 1,
        passed: false,
        timedOut: false,
        output: "AssertionError: expected 1 to equal 2",
        durationMs: 10,
      },
    ],
  });
  assert.equal(modelFailure, "requirement_unmet");
  assert.equal(isInfrastructureFailure(modelFailure), false, "모델 실패가 인프라 실패로 빠졌습니다");
});

test("툴체인 실패는 성공률 분모에서 빠진다", () => {
  const make = (failureClass: string | undefined): GateRunRecord =>
    ({
      schemaVersion: 1, runId: "r", fixtureId: "f", fixtureHash: "h", category: "multi_file_contract",
      repetition: 1, arm: "A", seed: 1, taskId: "t", providerId: "p", requestedModelId: "m",
      publicVerificationPassed: false, oracleVerificationPassed: false,
      inputTokens: 0, outputTokens: 0, providerCallCount: 0, retryCount: 0, latencyMs: 1,
      providerCalls: [], eventsReadable: true,
      changedFiles: [], policyDenials: [], promptVersionHash: "p",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z",
      providerKind: "real", criteriaHash: "h",
      ...(failureClass ? { failureClass } : {}),
    }) as GateRunRecord;

  const evaluation = evaluateGate([make("toolchain_unavailable"), make(undefined)], { seed: 1 });
  const armA = evaluation.arms.find((a) => a.arm === "A")!;
  assert.equal(armA.runs, 2);
  assert.equal(armA.evaluableRuns, 1, "툴체인 실패가 유효 실행으로 세어졌습니다");
  assert.equal(armA.infraFailures, 1);
});

test("preflight가 Rust fixture와 MSVC 미준비를 함께 보고한다", () => {
  const report = preflight({
    fixtureCount: 24,
    nativeFixtureCount: 6,
    arms: ["A", "B", "C", "D"],
    repetitions: 3,
    usingFakeProvider: false,
    msvc: { kind: "unavailable", exitCode: 1, message: "MSVC 빌드 도구를 찾지 못했습니다." },
  });
  assert.equal(report.canRunRealExperiment, false);
  assert.ok(report.blockers.some((b) => b.includes("MSVC")), report.blockers.join(" / "));
  assert.ok(report.lines.some((l) => l.includes("네이티브(Rust) fixture: 6개")));
});

test("Rust fixture가 없으면 MSVC 미준비가 차단 요인이 아니다", () => {
  const report = preflight({
    fixtureCount: 18,
    nativeFixtureCount: 0,
    arms: ["A"],
    repetitions: 1,
    usingFakeProvider: false,
    msvc: { kind: "unavailable", exitCode: 1, message: "없음" },
  });
  assert.equal(report.blockers.some((b) => b.includes("MSVC")), false);
});

test("preflight 출력에 자격증명 값이 나타나지 않는다", () => {
  const saved = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  try {
    process.env.OPENAI_API_KEY = "sk-preflight-must-not-appear-0123456789";
    process.env.ANTHROPIC_API_KEY = "sk-ant-preflight-must-not-appear";
    const report = preflight({
      fixtureCount: 24,
      nativeFixtureCount: 6,
      arms: ["A", "B", "C", "D"],
      repetitions: 3,
      usingFakeProvider: false,
      msvc: { kind: "ready", env: { INCLUDE: "C:\\i", LIB: "C:\\l" } },
    });
    const all = [...report.lines, ...report.blockers].join("\n");
    assert.ok(!all.includes("sk-"), `preflight 출력에 자격증명이 있습니다:\n${all}`);
    // 존재 여부는 알려줘야 한다 — 값만 숨기는 것이지 사실을 숨기는 것이 아니다.
    assert.ok(all.includes("OpenAI 자격증명: 있음"));
  } finally {
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.openai;
    if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.anthropic;
  }
});

test("MSVC 준비 결과가 자격증명을 담지 않는다", () => {
  // 준비된 환경을 그대로 자식에게 넘기므로, 여기에 키가 섞이면 oracle 출력으로 샐 수 있다.
  const merged = withMsvcEnv({ SAFE: "1" }, { kind: "ready", env: { INCLUDE: "C:\\i", LIB: "C:\\l" } });
  assert.ok(!JSON.stringify(merged).includes("sk-"));
  assert.equal(merged.SAFE, "1");
});

test("호스트 경로가 공용 helper와 일치한다", () => {
  // gate와 sidecar e2e가 서로 다른 경로를 보면 한쪽만 Windows에서 깨진다.
  assert.equal(HOST_BIN, hostBinaryPath(REPO_ROOT, process.platform));
  if (process.platform === "win32") assert.ok(HOST_BIN.endsWith(".exe"));
  else assert.ok(!HOST_BIN.endsWith(".exe"));
});
