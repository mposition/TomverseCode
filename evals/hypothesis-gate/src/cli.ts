import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS } from "./arms.js";
import { criteriaHash, describeCriteria } from "./criteria.js";
import { prepareMsvcEnv } from "@tomverse/toolchain";
import { REPO_ROOT } from "./host.js";
import { loadAllFixtures, listFixtureIds } from "./manifest.js";
import { preflight } from "./preflight.js";
import { openRecordStore } from "./records.js";
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

interface CliOptions {
  command: string;
  fixtures: string[];
  arms: ArmId[];
  repetitions: number;
  seed: number;
  maxCostUsd?: number;
  maxConcurrency: number;
  resume: boolean;
  output: string;
  executorModel?: string;
  reviewerModel?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: argv[0] ?? "help",
    fixtures: [],
    arms: ARMS.map((a) => a.arm),
    repetitions: 3,
    seed: 1,
    // 동시 실행은 기본 1이다. 여러 fixture를 동시에 돌리면 rate limit과 머신 부하가
    // 지연 측정을 오염시킨다 — p95 지연이 판정 기준에 있으므로 기본은 순차다.
    maxConcurrency: 1,
    resume: false,
    output: REPORTS_ROOT,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag}에 값이 필요합니다`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--fixtures":
        options.fixtures = next().split(",").map((f) => f.trim()).filter(Boolean);
        break;
      case "--arms":
        options.arms = next().split(",").map((a) => a.trim().toUpperCase() as ArmId).filter(Boolean);
        break;
      case "--repetitions":
        options.repetitions = Number.parseInt(next(), 10);
        break;
      case "--seed":
        options.seed = Number.parseInt(next(), 10);
        break;
      case "--max-cost-usd":
        options.maxCostUsd = Number.parseFloat(next());
        break;
      case "--max-concurrency":
        options.maxConcurrency = Number.parseInt(next(), 10);
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--output":
        options.output = path.resolve(next());
        break;
      case "--executor-model":
        options.executorModel = next();
        break;
      case "--reviewer-model":
        options.reviewerModel = next();
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${flag}`);
    }
  }
  if (!Number.isFinite(options.repetitions) || options.repetitions < 1) {
    throw new Error("--repetitions는 1 이상의 정수여야 합니다");
  }
  if (options.maxConcurrency > 1) {
    // 명시적으로 거부하지 않고 경고만 한다 — 사용자가 지연 측정을 포기하고 속도를 택할 수 있다.
    process.stderr.write(
      `[경고] --max-concurrency ${options.maxConcurrency}: 동시 실행은 지연 측정을 오염시킵니다. ` +
        `p95 지연이 판정 기준에 있으므로 confirmatory 실행에서는 1을 권장합니다.\n`
    );
  }
  return options;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "help") {
    log("usage: gate <validate|dry-run|pilot|run|report> [옵션]");
    log("");
    log("옵션: --fixtures a,b --arms A,B,C,D --repetitions N --seed N");
    log("      --max-cost-usd N --max-concurrency N --resume --output <dir>");
    log("      --executor-model <id> --reviewer-model <id>");
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

  const usingFake = process.env.TOMVERSE_FAKE_SCRIPT !== undefined || process.env.GATE_FAKE === "1";
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
  const recordsPath = path.join(options.output, options.resume ? "records.jsonl" : `${runId}.jsonl`);
  const store = openRecordStore(options.resume ? path.join(options.output, "records.jsonl") : recordsPath);

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
    ...(options.executorModel ? { executorModel: options.executorModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    onProgress: log,
  });

  log("");
  log(`실행 ${result.executed}건 / 재개로 건너뜀 ${result.skippedResume}건 / 계획 ${result.planned}건`);
  log(`누적 비용: $${result.spentUsd.toFixed(4)}`);
  if (result.budgetExhausted) {
    log("**예산 상한에 도달해 중단했습니다.** 지금까지의 결과는 저장되었고 판정은 INCONCLUSIVE입니다.");
  }

  return finalizeAndReport(store.all(), options, runId, true);
}

async function reportOnly(options: CliOptions): Promise<number> {
  const store = openRecordStore(path.join(options.output, "records.jsonl"));
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
