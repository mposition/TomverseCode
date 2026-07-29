import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBudgetLedger } from "@tomverse/sidecar/budget";
import { criteriaHash, CRITERIA, describeCriteria } from "./criteria.js";
import { prepareMsvcEnv } from "@tomverse/toolchain";
import { REPO_ROOT } from "./host.js";
import { loadAllFixtures, listFixtureIds } from "./manifest.js";
import { preflight } from "./preflight.js";
import { estimateRecordCost, lookupModel, maxCallsPerRecord, planModels, isModelPlan } from "./models.js";
import { OptionError, parseArgs, requireCostLimitForPaidRun, type CliOptions } from "./options.js";
import { openRecordStore } from "./records.js";
import { buildRunCard, renderRunCard, selectSmokeFixtures } from "./runCard.js";
import { checkCompatibility, META_VERSION, readMeta, runDirPaths, withApproval, writeMeta } from "./runDir.js";
import { ARMS } from "./arms.js";
import { writeReports } from "./report.js";
import { fillReviewerContributions, runExperiment } from "./runner.js";
import { evaluateGate } from "./stats.js";
import { validateAll } from "./validate.js";
import type { ArmId } from "./types.js";

/**
 * CLI (§14).
 *
 * 하위 명령:
 *   validate  — fixture 품질 검증 (모델 호출 없음)
 *   dry-run   — 실행 계획과 preflight만 출력 (API 호출 없음)
 *   pilot     — 반복 1회. 하네스/fixture/비용/실패 분류를 확인한다. **판정하지 않는다.**
 *   run       — confirmatory 실행 (기본 반복 3회)
 *   report    — 기존 기록으로 리포트만 다시 생성
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_ROOT = path.join(PACKAGE_ROOT, "fixtures");
const REPORTS_ROOT = path.join(PACKAGE_ROOT, "reports");

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2), REPORTS_ROOT);
  const usingFake = process.env.TOMVERSE_FAKE_SCRIPT !== undefined || process.env.GATE_FAKE === "1";
  // **API를 부르기 전에** 유료 실행의 전제를 확인한다.
  requireCostLimitForPaidRun(options, usingFake);

  if (options.command === "help") {
    log("usage: gate <validate|dry-run|plan-pilot|pilot|run|report> [옵션]");
    log("");
    log("옵션: --fixtures a,b --arms A,B,C,D --repetitions N --seed N");
    log("      --max-cost-usd N --max-concurrency 1 --resume --output <run-dir>");
    log("      --executor-model <id> --reviewer-model <id>");
    log("");
    log("--max-cost-usd는 실제 공급자를 쓰는 pilot/run에 **필수**입니다 (우회 옵션 없음).");
    log("--max-concurrency는 1만 허용합니다 — protocol v1은 순차 실행만 지원합니다.");
    log("--output은 하나의 실행 디렉터리이며 최초 실행과 재개가 같은 records.jsonl을 씁니다.");
    log("");
    log("종료 코드: 0=PASS  1=FAIL  2=INCONCLUSIVE  3=하네스 오류  4=툴체인 미준비");
    log("");
    log("사전 등록된 판정 기준:");
    for (const line of describeCriteria()) log(`  - ${line}`);
    return 0;
  }

  const ids = options.fixtures.length > 0 ? options.fixtures : listFixtureIds(FIXTURES_ROOT);
  if (ids.length === 0) {
    log(`fixture가 없습니다: ${FIXTURES_ROOT}`);
    return 1;
  }
  const fixtures = loadAllFixtures(FIXTURES_ROOT, ids);

  // ---- validate ----
  if (options.command === "validate") {
    // Rust fixture가 있으면 **먼저** 툴체인을 확인한다. 없으면 24개를 전부 돌린 뒤
    // LNK1104 네 번을 보는 대신, 무엇을 설치해야 하는지 한 번 알려준다.
    const nativeFixtures = fixtures.filter((f) => f.manifest.language === "rust");
    const msvc = prepareMsvcEnv(REPO_ROOT, process.platform);
    if (nativeFixtures.length > 0 && msvc.kind === "unavailable") {
      log("네이티브 툴체인이 준비되지 않았습니다.");
      log("");
      log(msvc.message);
      log("");
      log(`Rust fixture ${nativeFixtures.length}개를 검증할 수 없습니다:`);
      for (const fixture of nativeFixtures) log(`  - ${fixture.manifest.fixtureId}`);
      log("");
      log("TypeScript fixture만 검증하려면:");
      log(`  npm run gate:g:validate -- --fixtures ${fixtures
        .filter((f) => f.manifest.language !== "rust")
        .map((f) => f.manifest.fixtureId)
        .slice(0, 3)
        .join(",")},...`);
      // 툴체인 문제와 fixture 결함을 다른 종료 코드로 구별한다.
      return 4;
    }

    log(`fixture ${fixtures.length}개 검증 중 (모델 호출 없음)...`);
    if (msvc.kind === "ready") log("MSVC 툴체인: 준비됨");
    log("");
    const results = validateAll(fixtures);
    let failed = 0;
    for (const result of results) {
      const bad = result.checks.filter((c) => !c.passed);
      if (bad.length === 0) {
        log(`  ✓ ${result.fixtureId} (${result.category})`);
        continue;
      }
      failed += 1;
      log(`  ✗ ${result.fixtureId} (${result.category})`);
      for (const check of bad) log(`      - ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
    }
    log("");
    log(`${results.length - failed}/${results.length} 통과`);
    return failed === 0 ? 0 : 1;
  }

  // ---- plan-pilot ----
  // **실제 API를 부르지 않는다.** 사용자가 승인할 수 있는 실행 계획서를 만든다.
  if (options.command === "plan-pilot") {
    const models = planModels({
      ...(options.executorModel ? { executorModel: options.executorModel } : {}),
      ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
      allowZeroPricing: usingFake,
    });
    const extra: string[] = [];
    if (usingFake) {
      extra.push("fake provider 모드입니다 — 이 카드로 유료 실행을 승인할 수 없습니다");
    }
    const card = buildRunCard({
      fixtures,
      arms: options.arms,
      seed: options.seed,
      maxConcurrency: options.maxConcurrency,
      outputDir: options.output,
      ...(options.maxCostUsd !== undefined ? { approvedLimitUsd: options.maxCostUsd } : {}),
      models,
      extraBlockers: extra,
      generatedAt: new Date().toISOString(),
    });
    for (const line of renderRunCard(card)) log(line);
    log("");
    log("P0 smoke 실행 명령:");
    log(
      `  npm run gate:g:pilot -- --fixtures ${selectSmokeFixtures(fixtures)
        .map((f) => f.manifest.fixtureId)
        .join(",")} --repetitions 1 --max-concurrency 1 --seed ${options.seed} \\`
    );
    log(`      --output ${path.join(options.output, "p0-smoke")} --max-cost-usd <P0 승인 금액>`);
    log("");
    log("P1 전체 pilot 실행 명령 (P0가 완전히 정상일 때만):");
    log(`  npm run gate:g:pilot -- --repetitions 1 --max-concurrency 1 --seed ${options.seed} \\`);
    log(`      --output ${path.join(options.output, "p1-pilot")} --max-cost-usd <P1 승인 금액>`);
    // 승인 대상이므로 blocker가 있어도 카드는 출력한다. 종료 코드로 상태를 구별한다.
    return card.status === "READY_FOR_APPROVAL" ? 0 : 2;
  }

  const pre = preflight({
    fixtureCount: fixtures.length,
    nativeFixtureCount: fixtures.filter((f) => f.manifest.language === "rust").length,
    arms: options.arms,
    repetitions: options.command === "pilot" ? 1 : options.repetitions,
    ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
    ...(options.executorModel ? { executorModel: options.executorModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    usingFakeProvider: usingFake,
  });
  for (const line of pre.lines) log(line);
  log("");

  // ---- dry-run ----
  if (options.command === "dry-run") {
    const store = openRecordStore(path.join(options.output, "dry-run-records.jsonl"));
    const result = await runExperiment({
      fixtures,
      arms: options.arms,
      repetitions: options.repetitions,
      seed: options.seed,
      store,
      runId: `dry-${randomUUID()}`,
      dryRun: true,
    });
    log(`실행 계획: ${result.planned}건`);
    log("");
    log("처음 12건:");
    for (const item of (result.dryRunPlan ?? []).slice(0, 12)) {
      log(`  ${item.fixtureId} rep${item.repetition} Arm ${item.arm}`);
    }
    if (pre.blockers.length > 0) {
      log("");
      log("실제 실행을 막는 요인:");
      for (const blocker of pre.blockers) log(`  - ${blocker}`);
      log("");
      log("→ 실제 API 실험: NOT_RUN / 게이트 판정: INCONCLUSIVE");
    }
    // dry-run은 계획을 보여주는 것이 목적이므로 blocker가 있어도 성공으로 끝난다.
    return 0;
  }

  // ---- pilot / run ----
  if (options.command !== "pilot" && options.command !== "run") {
    if (options.command === "report") return await reportOnly(options);
    log(`알 수 없는 명령: ${options.command}`);
    return 1;
  }

  if (pre.blockers.length > 0) {
    log("실행할 수 없습니다:");
    for (const blocker of pre.blockers) log(`  - ${blocker}`);
    log("");
    log("실제 API 실험: NOT_RUN");
    log("게이트 판정: INCONCLUSIVE — 실제 API 실험이 실행되지 않았습니다");
    // 성공률이나 비용을 지어내지 않는다. 여기서 끝낸다.
    return 2;
  }

  const isPilot = options.command === "pilot";
  const runId = `${isPilot ? "pilot" : "run"}-${randomUUID()}`;

  // ---- 실행 디렉터리 계약 (§5) ----
  // 최초 실행과 재개가 **같은 파일**을 쓴다. 예전에는 최초가 <uuid>.jsonl, 재개가
  // records.jsonl이어서 `--resume`만 붙이면 처음부터 다시 돌았다.
  const { records: recordsPath } = runDirPaths(options.output);
  const store = openRecordStore(recordsPath);
  const spentSoFar = store.all().reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  const models = planModels({
    ...(options.executorModel ? { executorModel: options.executorModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    allowZeroPricing: usingFake,
  });
  if (!usingFake && !isModelPlan(models)) {
    log("모델 계획을 확정할 수 없습니다:");
    for (const blocker of models.blockers) log(`  - ${blocker}`);
    return 2;
  }

  const incomingMeta = {
    stage: isPilot ? "pilot" : "confirmatory",
    protocolVersion: CRITERIA.protocolVersion,
    criteriaHash: criteriaHash(),
    fixtureHashes: Object.fromEntries(fixtures.map((f) => [f.manifest.fixtureId, f.fixtureHash])),
    arms: options.arms.map(String),
    repetitions: isPilot ? 1 : options.repetitions,
    seed: options.seed,
    executorModelId: isModelPlan(models) ? models.executor.modelId : (options.executorModel ?? "(fake)"),
    reviewerModelId: isModelPlan(models) ? models.reviewer.modelId : (options.reviewerModel ?? "(fake)"),
  };

  const existingMeta = readMeta(options.output);
  const now = new Date().toISOString();
  if (existingMeta) {
    const compat = checkCompatibility(existingMeta, incomingMeta, {
      approvedLimitUsd: options.maxCostUsd ?? Number.POSITIVE_INFINITY,
      alreadySpentUsd: spentSoFar,
    });
    if (compat.conflicts.length > 0) {
      log(`기존 실행 디렉터리와 조건이 다릅니다: ${options.output}`);
      for (const conflict of compat.conflicts) log(`  - ${conflict}`);
      log("");
      log("다른 실험의 결과를 같은 디렉터리에 섞지 않습니다. --output에 새 디렉터리를 지정하세요.");
      return 3;
    }
    if (compat.budgetBelowSpent) {
      log(
        `승인 상한 $${options.maxCostUsd}가 이미 쓴 금액 $${spentSoFar.toFixed(4)} 이하입니다 — ` +
          `새 호출을 할 수 없으므로 여기서 멈춥니다.`
      );
      return 2;
    }
    if (compat.budgetRaised && options.maxCostUsd !== undefined) {
      log(`예산 상한을 올렸습니다 — 새 사용자 승인으로 기록합니다: $${options.maxCostUsd}`);
      writeMeta(options.output, withApproval(existingMeta, options.maxCostUsd, now, "상한 상향"));
    }
    log(`기존 기록 ${store.count()}건을 이어받습니다 (${recordsPath})`);
  } else {
    writeMeta(options.output, {
      metaVersion: META_VERSION,
      ...incomingMeta,
      approvals:
        options.maxCostUsd !== undefined
          ? [{ approvedLimitUsd: options.maxCostUsd, at: now, note: "최초 승인" }]
          : [],
      createdAt: now,
    });
  }

  // ---- 예산 ledger ----
  // 유료 실행에서만 만든다. fake는 단가 0이므로 예약이 의미가 없다.
  const ledger = !usingFake && options.maxCostUsd !== undefined ? createBudgetLedger(options.maxCostUsd) : undefined;
  const estimateRecordCostUsd = ((): ((arm: ArmId) => { maxUsd: number; basis: string } | undefined) | undefined => {
    if (!ledger || !isModelPlan(models)) return undefined;
    const executorEntry = lookupModel(models.executor.modelId);
    const reviewerEntry = lookupModel(models.reviewer.modelId);
    return (arm: ArmId) => {
      const spec = ARMS.find((a) => a.arm === arm);
      if (!spec || !executorEntry) return undefined;
      // Arm B는 anthropic이 executor 자리다.
      const actingExecutor = spec.providers[0] === "anthropic" ? reviewerEntry : executorEntry;
      if (!actingExecutor) return undefined;
      const estimate = estimateRecordCost(
        actingExecutor,
        reviewerEntry,
        maxCallsPerRecord(arm, spec.providers.length)
      );
      return estimate === undefined ? undefined : { maxUsd: estimate.maxUsd, basis: estimate.basis };
    };
  })();

  if (ledger) {
    log(`예산 ledger: 승인 상한 $${ledger.approvedLimitUsd} / 이미 쓴 금액 $${spentSoFar.toFixed(4)}`);
    log("각 기록의 최대 비용을 **호출 전에 예약**합니다. 예약할 수 없으면 호출하지 않습니다.");
    log("");
  }

  if (isPilot) {
    log("**Pilot 실행** — 하네스·fixture·비용·실패 분류를 확인합니다.");
    log("Pilot 결과만으로는 PASS를 내지 않습니다 (반복 부족 → INCONCLUSIVE).");
    log("");
  }

  const result = await runExperiment({
    fixtures,
    arms: options.arms,
    repetitions: isPilot ? 1 : options.repetitions,
    seed: options.seed,
    store,
    runId,
    ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
    ...(ledger ? { ledger } : {}),
    ...(estimateRecordCostUsd ? { estimateRecordCostUsd } : {}),
    realProvider: !usingFake,
    ...(options.executorModel ? { executorModel: options.executorModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    onProgress: log,
  });

  log("");
  log(`실행 ${result.executed}건 / 재개로 건너뜀 ${result.skippedResume}건 / 계획 ${result.planned}건`);
  log(`누적 비용: $${result.spentUsd.toFixed(4)}`);
  if (ledger) {
    const snapshot = ledger.snapshot();
    log(
      `ledger: 확정 $${snapshot.committedUsd.toFixed(4)} / 예약 $${snapshot.reservedUsd.toFixed(4)} / ` +
        `남음 $${snapshot.availableUsd.toFixed(4)} (예약 ${snapshot.reservationsOpened}건, ` +
        `정산 ${snapshot.reservationsSettled}건, 해제 ${snapshot.reservationsReleased}건)`
    );
  }
  if (result.budgetExhausted) {
    log("**예산 상한에 도달해 중단했습니다.** 지금까지의 결과는 저장되었고 판정은 INCONCLUSIVE입니다.");
  }
  if (result.unmeasurableCostAbort) {
    log("**비용을 확인할 수 없어 중단했습니다.** 예산 상한을 강제할 수 없는 상태로는 유료 호출을 계속하지 않습니다.");
  }
  if (result.abortReason) log(`중단 사유: ${result.abortReason}`);

  return finalizeAndReport(store.all(), options, runId, true);
}

async function reportOnly(options: CliOptions): Promise<number> {
  const store = openRecordStore(runDirPaths(options.output).records);
  if (store.count() === 0) {
    log("기록이 없습니다. 먼저 pilot 또는 run을 실행하세요.");
    return 1;
  }
  const realApiExecuted = store.all().some((r) => r.providerKind === "real");
  return finalizeAndReport(store.all(), options, "report-only", realApiExecuted);
}

function finalizeAndReport(
  rawRecords: ReturnType<ReturnType<typeof openRecordStore>["all"]>,
  options: CliOptions,
  runId: string,
  realApiExecuted: boolean
): number {
  const records = fillReviewerContributions(rawRecords);
  const evaluation = evaluateGate(records, { seed: options.seed });
  const paths = writeReports(options.output, evaluation, records, {
    runId,
    seed: options.seed,
    generatedAt: new Date().toISOString(),
    realApiExecuted: realApiExecuted && evaluation.realApiRuns > 0,
  });

  log("");
  log(`판정 기준 해시: ${criteriaHash()}`);
  log(`판정: ${evaluation.verdict}`);
  for (const reason of evaluation.reasons) log(`  - ${reason}`);
  log("");
  log(`리포트: ${paths.markdown}`);
  log(`요약 JSON: ${paths.summaryJson}`);
  log(`arm CSV: ${paths.armCsv}`);
  log(`paired CSV: ${paths.pairedCsv}`);

  // 종료 코드로도 구별할 수 있게 한다: 0=PASS, 1=FAIL, 2=INCONCLUSIVE.
  return evaluation.verdict === "PASS" ? 0 : evaluation.verdict === "FAIL" ? 1 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
    process.exit(3);
  });
