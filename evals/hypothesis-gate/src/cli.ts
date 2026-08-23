import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBudgetLedger } from "@tomverse/sidecar/budget";
import { BUILTIN_MODELS, ModelRegistry } from "@tomverse/sidecar/registry";
import {
  approvalCoversHistorical,
  budgetEventsPath,
  budgetStatus,
  createBudgetEventSink,
  readBudgetEvents,
  reconcileBudget,
  recoverSpendFromRecords,
  renderBudgetStatus,
} from "./budgetRecovery.js";
import { computeCallBudget, describeCallBudget } from "./callBudget.js";
import { criteriaHash, CRITERIA, describeCriteria } from "./criteria.js";
import { prepareMsvcEnv } from "@tomverse/toolchain";
import { artifactsPresent, REPO_ROOT } from "./host.js";
import { loadAllFixtures, listFixtureIds } from "./manifest.js";
import { credentialPresent, preflight } from "./preflight.js";
import { estimateRecordCost, lookupModel, maxCallsPerRecord, planModels, isModelPlan } from "./models.js";
import { OptionError, parseArgs, requireCostLimitForPaidRun, type CliOptions } from "./options.js";
import {
  attestP0,
  loadP0Attestation,
  p0AttestationPath,
  renderAttestation,
  validateP0Attestation,
  writeP0Attestation,
} from "./p0Attestation.js";
import {
  loadProbeEvidence,
  probeEvidencePath,
  validateProbeEvidence,
  writeProbeEvidence,
  type ProbeEvidence,
} from "./probeEvidence.js";
import {
  bindingForRoles,
  PROBE_BUDGET_EVENTS_FILE,
  probeModels,
  renderProbeSummary,
  writeProbeResults,
} from "./probeModels.js";
import { ADAPTER_CONTRACT_VERSION, createAdapterProbeTransport } from "./probeTransport.js";
import { openRecordStore } from "./records.js";
import {
  authorizeRunCard,
  buildStagedCards,
  cardFileFor,
  loadRunCard,
  renderRunCard,
  writeRunCard,
  type Stage,
} from "./runCard.js";
import { checkCompatibility, META_VERSION, readMeta, runDirPaths, withApproval, writeMeta } from "./runDir.js";
import { ARMS } from "./arms.js";
import { writeReports } from "./report.js";
import { fillReviewerContributions, runExperiment } from "./runner.js";
import { evaluateGate } from "./stats.js";
import { loadEasyTasks, loadHardTasks, observeTriage, renderCalibration, summarize } from "./triageCalibration.js";
import { validateAll } from "./validate.js";
import type { ArmId } from "./types.js";

/**
 * CLI (§14).
 *
 * 하위 명령:
 *   validate  — fixture 품질 검증 (모델 호출 없음)
 *   triage-calibration — TRIAGE 규칙을 난이도 라벨이 붙은 태스크에 태워 임계값 표를 만든다 (모델 호출 없음)
 *   dry-run   — 실행 계획과 preflight만 출력 (API 호출 없음)
 *   plan-pilot   — 단계별(P0/P1) 승인 카드 (API 호출 없음)
 *   probe-models — 역할당 최소 요청 1회로 모델을 실제 확인한다 (비용 상한 필수)
 *   pilot     — 반복 1회. 하네스/fixture/비용/실패 분류를 확인한다. **판정하지 않는다.**
 *   run       — confirmatory 실행 (기본 반복 3회)
 *   report    — 기존 기록으로 리포트만 다시 생성
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_ROOT = path.join(PACKAGE_ROOT, "fixtures");
/** Phase 0 스파이크 fixture — **읽기만 한다.** 쉬운 라벨의 출처다. */
const SPIKE_FIXTURES_ROOT = path.join(REPO_ROOT, "spike", "fixtures");
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
    log(
      "usage: gate <validate|triage-calibration|dry-run|plan-pilot|probe-models|budget-status|attest-p0|pilot|run|report> [옵션]"
    );
    log("");
    log("옵션: --fixtures a,b --arms A,B,C,D --repetitions N --seed N");
    log("      --max-cost-usd N --max-concurrency 1 --resume --output <run-dir>");
    log("      --stage smoke|pilot|confirmatory --executor-model <id> --reviewer-model <id>");
    log("      plan-pilot 전용: --p0-max-cost-usd N --p1-max-cost-usd N");
    log("      유료 실행 필수: --run-card <path>   (선택: --probe-evidence <path>)");
    log("");
    log("--max-cost-usd는 실제 공급자를 쓰는 pilot/run에 **필수**입니다 (우회 옵션 없음).");
    log("--max-concurrency는 1만 허용합니다 — protocol v1은 순차 실행만 지원합니다.");
    log("--output은 하나의 실행 디렉터리이며 최초 실행과 재개가 같은 records.jsonl을 씁니다.");
    log("재개 시 records.jsonl에서 이미 쓴 금액을 복원하므로 재시작이 승인 상한을 늘리지 않습니다.");
    log("열린 예약(개시만 있고 종결이 없는 예약)이 있으면 재개하지 않습니다 — 그 요청은 과금됐을 수 있습니다.");
    log("유료 pilot/run은 --run-card가 필수입니다 (우회 옵션 없음).");
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

  // ---- triage-calibration ----
  // **유료 호출이 없다.** TRIAGE는 모델을 부르지 않으므로(13.2절), 규칙의 판정은 fake 공급자로도
  // 그대로 관측된다 — 그 사실을 주장하지 않고 이벤트 순서로 증명한다(triageCalibration.ts).
  if (options.command === "triage-calibration") {
    const artifacts = artifactsPresent();
    if (!artifacts.ok) {
      log("실행 산출물이 없습니다 — TRIAGE 규칙을 production 경로로 태울 수 없습니다.");
      log("");
      log(artifacts.detail);
      return 4;
    }

    const hard = loadHardTasks(FIXTURES_ROOT, options.fixtures);
    const easy = loadEasyTasks(SPIKE_FIXTURES_ROOT);
    const tasks = [...hard, ...easy];
    log(`난이도 라벨이 붙은 태스크 ${tasks.length}개에 TRIAGE 규칙을 태웁니다 (어려움 ${hard.length} · 쉬움 ${easy.length}).`);
    log("공급자는 레지스트리의 fake 항목입니다 — local:// 주소라 네트워크로 나가지 않습니다.");
    log("");

    const observations = tasks.map((task) => {
      const observed = observeTriage(task);
      log(
        `  ${observed.tier ?? "관측 실패"}  ${task.label === "hard" ? "어려움" : "쉬움  "}  ${task.id}` +
          (observed.evidence ? ` (작업 파일 ${observed.evidence.workFileCount}개)` : "")
      );
      return observed;
    });
    log("");
    for (const line of renderCalibration(summarize(observations))) log(line);
    // **판정하지 않는다.** 이건 사람이 교환비를 정하기 위한 표이지 게이트가 아니다.
    return 0;
  }

  // ---- plan-pilot ----
  // **실제 API를 부르지 않는다.** 사용자가 승인할 수 있는 실행 계획서를 만든다.
  if (options.command === "plan-pilot") {
    const models = planModels({
      ...(options.executorModel ? { executorModel: options.executorModel } : {}),
      ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
      allowZeroPricing: usingFake,
      credentialPresence: credentialPresent,
    });
    const extra: string[] = [];
    if (usingFake) {
      extra.push("fake provider 모드입니다 — 이 카드로 유료 실행을 승인할 수 없습니다");
    }

    // ---- probe evidence 읽기 (§3) ----
    // 예전에는 probe 결과를 아무도 다시 읽지 않았다. 그래서 probe에 성공해도 카드는 계속
    // READY_FOR_MODEL_PROBE였고, 반대로 pilot은 자격증명 존재만으로 실행 경로에 들어갔다.
    const evidenceFile = options.probeEvidence ?? probeEvidencePath(path.join(options.output, "model-probe"));
    const now = new Date().toISOString();
    const loaded = loadProbeEvidence(evidenceFile);
    let evidence: ProbeEvidence | undefined;
    const evidenceProblems: string[] = [];
    if (!loaded.found) {
      log(`probe evidence가 없습니다: ${evidenceFile}`);
    } else if (loaded.raw === undefined) {
      evidenceProblems.push(`probe evidence를 읽을 수 없습니다: ${loaded.parseError ?? "알 수 없는 오류"}`);
    } else if (isModelPlan(models)) {
      const verdict = validateProbeEvidence(loaded.raw, {
        now,
        protocolVersion: CRITERIA.protocolVersion,
        criteriaHash: criteriaHash(),
        registrySnapshotHash: new ModelRegistry(BUILTIN_MODELS).snapshotHash(),
        adapterContractVersion: ADAPTER_CONTRACT_VERSION,
        executorModelId: models.executor.modelId,
        reviewerModelId: models.reviewer.modelId,
        env: process.env,
      });
      if (verdict.ok) evidence = verdict.evidence;
      else evidenceProblems.push(...verdict.reasons);
    }

    // ---- P0 attestation 읽기 (§5) ----
    const attestationFile = p0AttestationPath(path.join(options.output, "p0-smoke"));
    const attestationLoad = loadP0Attestation(attestationFile);
    let p0Attestation: { attestationId: string; attestationHash: string } | undefined;
    const p0Problems: string[] = [];
    if (attestationLoad.found && attestationLoad.raw !== undefined && evidence && isModelPlan(models)) {
      const verdict = validateP0Attestation(attestationLoad.raw, {
        probeEvidenceId: evidence.evidenceId,
        probeEvidenceHash: evidence.evidencePayloadHash,
        criteriaHash: criteriaHash(),
        protocolVersion: CRITERIA.protocolVersion,
        executorModelId: models.executor.modelId,
        reviewerModelId: models.reviewer.modelId,
      });
      if (verdict.ok) {
        p0Attestation = {
          attestationId: verdict.attestation.attestationId,
          attestationHash: verdict.attestation.attestationHash,
        };
      } else {
        p0Problems.push(...verdict.reasons);
      }
    } else if (attestationLoad.found && attestationLoad.parseError) {
      p0Problems.push(`P0 attestation을 읽을 수 없습니다: ${attestationLoad.parseError}`);
    }

    const credentialsPresent = isModelPlan(models)
      ? [models.executor.providerId, models.reviewer.providerId].every((p) => credentialPresent(p))
      : false;

    // **단계마다 카드 한 장.** 승인 하나가 P0와 P1을 함께 덮으면 "P0가 정상일 때만 P1"이
    // 절차로 성립하지 않는다. 단계별 상한을 따로 받는 것이 그 절차의 다른 절반이다.
    const cards = buildStagedCards({
      fixtures,
      arms: options.arms,
      seed: options.seed,
      maxConcurrency: options.maxConcurrency,
      outputRoot: options.output,
      ...(options.p0MaxCostUsd !== undefined ? { p0ApprovedLimitUsd: options.p0MaxCostUsd } : {}),
      ...(options.p1MaxCostUsd !== undefined ? { p1ApprovedLimitUsd: options.p1MaxCostUsd } : {}),
      models,
      extraBlockers: extra,
      createdAt: now,
      credentialsPresent,
      ...(evidence ? { probeEvidence: evidence } : {}),
      ...(evidenceProblems.length > 0 ? { probeEvidenceProblems: evidenceProblems } : {}),
      ...(p0Attestation ? { p0Attestation } : {}),
      ...(p0Problems.length > 0 ? { p0AttestationProblems: p0Problems } : {}),
      joinPath: (a, b) => path.join(a, b),
    });

    for (const card of [cards.p0, cards.p1]) {
      for (const line of renderRunCard(card)) log(line);
      // **카드를 파일로 남긴다.** 실행이 이 파일을 요구하므로, 출력만 하고 끝나면
      // 승인 절차가 강제되지 않는다.
      const file = writeRunCard(card);
      log("");
      log(`카드 파일: ${file}`);
      log("");
      log("─".repeat(72));
      log("");
    }
    if (options.p0MaxCostUsd === undefined || options.p1MaxCostUsd === undefined) {
      log("단계별 승인 금액을 지정하세요 (하나의 상한이 두 단계를 덮지 않게 따로 받습니다):");
      log("  npm run gate:g:plan-pilot -- --p0-max-cost-usd <P0 금액> --p1-max-cost-usd <P1 금액> \\");
      log(`      --output ${options.output}`);
      log("");
    }
    log("진행 순서: probe-models → P0 카드 승인 → P0 실행 → P0 attestation → P1 카드 승인 → P1 실행");
    log("유료 실행에는 --run-card가 필수입니다 (우회 옵션 없음).");
    // 승인 대상이므로 blocker가 있어도 카드는 출력한다. 종료 코드로 상태를 구별한다.
    const approvable = ["READY_FOR_P0_APPROVAL", "READY_FOR_P1_APPROVAL"];
    const bothReady = [cards.p0, cards.p1].every((c) => approvable.includes(c.status));
    return bothReady ? 0 : 2;
  }

  // ---- probe-models ----
  // **역할당 최소 요청 1회만** 보낸다. 재시도도 fallback도 없다.
  if (options.command === "probe-models") {
    const models = planModels({
      ...(options.executorModel ? { executorModel: options.executorModel } : {}),
      ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
      allowZeroPricing: usingFake,
      credentialPresence: credentialPresent,
    });
    if (!isModelPlan(models)) {
      log("모델을 확정할 수 없어 probe를 보내지 않았습니다:");
      for (const blocker of models.blockers) log(`  - ${blocker}`);
      log("→ 상태: BLOCKED / 실제 API 호출: 0건");
      return 2;
    }
    const executorEntry = lookupModel(models.executor.modelId);
    const reviewerEntry = lookupModel(models.reviewer.modelId);
    if (!executorEntry || !reviewerEntry) {
      log("레지스트리에서 모델 엔트리를 찾을 수 없습니다 — probe를 보내지 않았습니다.");
      return 3;
    }

    const roles = [
      { role: "executor" as const, entry: executorEntry, readiness: models.readiness[0]! },
      { role: "reviewer" as const, entry: reviewerEntry, readiness: models.readiness[1]! },
    ];
    // 자격증명 binding은 **키 값을 읽지 않고** 존재와 동일성만 확인할 수 있는 형태로 만든다.
    const binding = bindingForRoles(roles, process.env);
    if (!binding) {
      log("공급자 자격증명이 없어 probe를 보내지 않았습니다.");
      log("→ 상태: BLOCKED_MISSING_CREDENTIALS / 실제 API 호출: 0건");
      return 2;
    }

    const registry = new ModelRegistry(BUILTIN_MODELS);
    const probeDir = path.join(options.output, "model-probe");
    const summary = await probeModels({
      roles,
      ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
      maxConcurrency: options.maxConcurrency,
      // production 어댑터를 그대로 태운다 — probe 전용 호출을 만들면 "probe는 통과했는데
      // 실제 실행은 실패"가 가능해진다.
      transport: createAdapterProbeTransport(),
      costOfUsage: (modelId, usage) => registry.costUsd(modelId, usage),
      onEvent: createBudgetEventSink(probeDir, PROBE_BUDGET_EVENTS_FILE),
      onProgress: log,
      evidenceBinding: {
        protocolVersion: CRITERIA.protocolVersion,
        criteriaHash: criteriaHash(),
        registrySnapshotHash: registry.snapshotHash(),
        adapterContractVersion: ADAPTER_CONTRACT_VERSION,
        credentialBinding: binding,
      },
    });

    for (const line of renderProbeSummary(summary)) log(line);
    if (summary.requestsSent > 0 || summary.records.length > 0) {
      const written = writeProbeResults(probeDir, summary);
      log("");
      log(`probe 기록: ${written.records}`);
      log(`probe 요약: ${written.summary}`);
      log("이 파일들은 게이트 기록(records.jsonl)과 분리되어 있습니다 — probe는 실험 표본이 아닙니다.");
    }
    if (summary.evidence) {
      const file = writeProbeEvidence(probeDir, summary.evidence);
      log(`probe evidence: ${file}`);
      log("이제 plan-pilot이 이 evidence를 읽어 P0 승인 카드를 만듭니다.");
    }
    return summary.status === "READY_FOR_PAID_RUN" ? 0 : 2;
  }

  // ---- budget-status ----
  // **읽기 전용.** API를 부르지 않고, 파일을 고치지도 않는다.
  if (options.command === "budget-status") {
    const store = openRecordStore(runDirPaths(options.output).records);
    const report = budgetStatus({
      runDir: options.output,
      records: store.all(),
      eventRead: readBudgetEvents(options.output),
      ...(options.maxCostUsd !== undefined ? { approvedLimitUsd: options.maxCostUsd } : {}),
    });
    for (const line of renderBudgetStatus(report)) log(line);
    return report.resumable ? 0 : 2;
  }

  // ---- attest-p0 ----
  // P0 실행 결과를 검사해 attestation을 만든다. **API를 부르지 않는다.**
  if (options.command === "attest-p0") {
    const cardFile = options.runCard ?? path.join(options.output, cardFileFor("smoke"));
    const loadedCard = loadRunCard(cardFile);
    if (!loadedCard.ok) {
      log(`P0 Run Card를 읽을 수 없습니다: ${cardFile}`);
      for (const reason of loadedCard.reasons) log(`  - ${reason}`);
      return 2;
    }
    const evidenceFile = options.probeEvidence ?? probeEvidencePath(path.join(path.dirname(options.output), "model-probe"));
    const loadedEvidence = loadProbeEvidence(evidenceFile);
    if (!loadedEvidence.found || loadedEvidence.raw === undefined) {
      log(`probe evidence를 읽을 수 없습니다: ${evidenceFile}`);
      log("→ 상태: BLOCKED_INVALID_PROBE_EVIDENCE");
      return 2;
    }
    const store = openRecordStore(runDirPaths(options.output).records);
    const events = readBudgetEvents(options.output);
    if (!events.ok) {
      log("예산 이벤트를 해석할 수 없어 attestation을 만들지 않았습니다:");
      for (const reason of events.reasons) log(`  - ${reason}`);
      return 2;
    }
    const outcome = attestP0({
      card: loadedCard.card,
      evidence: loadedEvidence.raw as ProbeEvidence,
      records: store.all(),
      budgetEvents: events.events,
      createdAt: new Date().toISOString(),
    });
    for (const line of renderAttestation(outcome)) log(line);
    if (!outcome.ok) {
      log("");
      log(`→ 상태: ${outcome.status}`);
      return 2;
    }
    const file = writeP0Attestation(options.output, outcome.attestation);
    log("");
    log(`attestation: ${file}`);
    log("이제 plan-pilot이 이 attestation을 읽어 P1 승인 카드를 만듭니다.");
    return 0;
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
    // **공용 계산기를 쓴다.** 예전에는 preflight가 executor 호출만 세고 그것을
    // "최대 API 호출 수"로 표시했다 — confirmatory에서 1,152 vs 실제 1,584였다.
    for (const line of describeCallBudget(
      computeCallBudget({ fixtureCount: fixtures.length, arms: options.arms, repetitions: options.repetitions })
    )) {
      log(line);
    }
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
  const requestedStage: Stage = options.stage ?? (isPilot ? "pilot" : "confirmatory");

  // ---- Run Card 게이트 (§4) ----
  // **어댑터를 만들기 전에** 확인한다. fake 실행은 면제한다 — 단가 0이고 승인 대상이 아니다.
  // 우회 플래그는 없다: 유료 실행은 카드 없이 시작할 수 없다.
  if (!usingFake) {
    if (options.runCard === undefined) {
      log(`${options.command}는 실제 공급자를 호출하므로 --run-card가 필수입니다 (우회 옵션 없음).`);
      log("");
      log("먼저 카드를 만드세요:");
      log("  npm run gate:g:plan-pilot -- --p0-max-cost-usd <금액> --p1-max-cost-usd <금액> --output <dir>");
      log("");
      log("→ 상태: BLOCKED_MISSING_RUN_CARD / 실제 API 호출: 0건");
      return 2;
    }
    const loadedCard = loadRunCard(options.runCard);
    if (!loadedCard.ok) {
      log(`Run Card를 쓸 수 없습니다: ${options.runCard}`);
      for (const reason of loadedCard.reasons) log(`  - ${reason}`);
      log("→ 상태: BLOCKED_INVALID_RUN_CARD / 실제 API 호출: 0건");
      return 2;
    }
    const plannedModels = planModels({
      ...(options.executorModel ? { executorModel: options.executorModel } : {}),
      ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
      credentialPresence: credentialPresent,
    });
    if (!isModelPlan(plannedModels)) {
      log("모델 계획을 확정할 수 없어 카드를 검증할 수 없습니다:");
      for (const blocker of plannedModels.blockers) log(`  - ${blocker}`);
      return 2;
    }
    const verdict = authorizeRunCard(loadedCard.card, {
      stage: requestedStage,
      outputDir: options.output,
      fixtureIds: fixtures.map((f) => f.manifest.fixtureId),
      arms: options.arms,
      repetitions: isPilot ? 1 : options.repetitions,
      seed: options.seed,
      ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
      executorModelId: plannedModels.executor.modelId,
      reviewerModelId: plannedModels.reviewer.modelId,
      now: new Date().toISOString(),
    });
    if (!verdict.ok) {
      log(`Run Card가 이 실행을 승인하지 않습니다: ${options.runCard}`);
      for (const reason of verdict.reasons) log(`  - ${reason}`);
      log("");
      log("카드와 다른 조건으로 실행하지 않습니다. 카드를 다시 만들거나 인수를 카드에 맞추세요.");
      log(`→ 상태: ${verdict.status} / 실제 API 호출: 0건`);
      return 2;
    }
    // evidence의 자격증명 binding까지 여기서 확인한다 — 카드가 가리키는 evidence가
    // **지금 쓰는 키**로 얻어진 것이어야 한다.
    const evidenceFile =
      options.probeEvidence ?? probeEvidencePath(path.join(path.dirname(options.output), "model-probe"));
    const loadedEvidence = loadProbeEvidence(evidenceFile);
    if (!loadedEvidence.found || loadedEvidence.raw === undefined) {
      log(`카드가 가리키는 probe evidence를 읽을 수 없습니다: ${evidenceFile}`);
      log("→ 상태: BLOCKED_INVALID_PROBE_EVIDENCE / 실제 API 호출: 0건");
      return 2;
    }
    const evidenceVerdict = validateProbeEvidence(loadedEvidence.raw, {
      now: new Date().toISOString(),
      protocolVersion: CRITERIA.protocolVersion,
      criteriaHash: criteriaHash(),
      registrySnapshotHash: new ModelRegistry(BUILTIN_MODELS).snapshotHash(),
      adapterContractVersion: ADAPTER_CONTRACT_VERSION,
      executorModelId: plannedModels.executor.modelId,
      reviewerModelId: plannedModels.reviewer.modelId,
      env: process.env,
    });
    if (!evidenceVerdict.ok) {
      log("probe evidence가 이 실행을 보증하지 않습니다:");
      for (const reason of evidenceVerdict.reasons) log(`  - ${reason}`);
      log(`→ 상태: ${evidenceVerdict.status} / 실제 API 호출: 0건`);
      return 2;
    }
    if (
      loadedCard.card.probeEvidenceId !== evidenceVerdict.evidence.evidenceId ||
      loadedCard.card.probeEvidenceHash !== evidenceVerdict.evidence.evidencePayloadHash
    ) {
      log("Run Card가 가리키는 evidence와 현재 evidence 파일이 다릅니다 — 카드를 다시 만드세요.");
      log("→ 상태: BLOCKED_INVALID_PROBE_EVIDENCE / 실제 API 호출: 0건");
      return 2;
    }
    log(`Run Card 승인 확인: ${loadedCard.card.cardId} (${loadedCard.card.cardHash})`);
    log(`probe evidence 확인: ${evidenceVerdict.evidence.evidenceId}`);
    log("");
  }

  // ---- 실행 디렉터리 계약 (§5) ----
  // 최초 실행과 재개가 **같은 파일**을 쓴다. 예전에는 최초가 <uuid>.jsonl, 재개가
  // records.jsonl이어서 `--resume`만 붙이면 처음부터 다시 돌았다.
  const { records: recordsPath } = runDirPaths(options.output);
  const store = openRecordStore(recordsPath);

  // ---- 이미 쓴 돈 복원 (§1) ----
  // 예전에는 여기서 `reduce((s, r) => s + (r.costUsd ?? 0), 0)`으로 합만 냈고, ledger는
  // 그 값을 **모르는 채로** 새로 만들어졌다. 그래서 재개할 때마다 상한이 처음부터 다시
  // 주어졌다. 합계를 내는 것보다 중요한 것은 **합계를 신뢰할 수 있는지 판정하는 것**이다.
  const recovery = recoverSpendFromRecords(store.all());
  if (!recovery.ok) {
    log(`기존 기록에서 이미 쓴 금액을 복원할 수 없습니다: ${recordsPath}`);
    for (const reason of recovery.reasons) log(`  - ${reason}`);
    log("");
    log("얼마를 썼는지 모르는 상태로는 승인 상한을 강제할 수 없으므로 재개하지 않습니다.");
    log("→ 상태: BLOCKED / 유료 호출: 없음");
    return 2;
  }
  const spentSoFar = recovery.spend.historicalUsd;

  // ---- 이벤트 원장과의 대조 (§1, §7) ----
  // **합계만 비교하지 않는다.** 열린 예약(개시만 있고 종결이 없는 예약)은 어떤 합계에도
  // 나타나지 않지만, 그 요청은 공급자가 처리하고 과금했을 수 있다.
  const eventRead = readBudgetEvents(options.output);
  if (!eventRead.ok) {
    log(`예산 이벤트를 해석할 수 없습니다: ${options.output}`);
    for (const reason of eventRead.reasons) log(`  - ${reason}`);
    log(`→ 상태: ${eventRead.status} / 유료 호출: 없음`);
    return 2;
  }
  const agreement = reconcileBudget({
    recordsUsd: spentSoFar,
    events: eventRead.events,
    truncatedLastLine: eventRead.truncatedLastLine,
  });
  if (!agreement.ok) {
    log(`예산 원장을 신뢰할 수 없어 재개하지 않습니다: ${options.output}`);
    for (const reason of agreement.reasons) log(`  - ${reason}`);
    for (const open of agreement.analysis.reservations.filter(
      (r) => r.outcome === "open" || r.outcome === "unresolved"
    )) {
      log("");
      log(`미해결 예약: ${open.correlationId}`);
      log(`  예약액 $${open.reservedUsd.toFixed(6)} / 상태 ${open.outcome}`);
      log(`  실행 ${open.runId} / 단계 ${open.stage} / 개시 ${open.openedAt}`);
    }
    log("");
    log("이 예약액은 사용 가능한 예산으로 되돌리지 않습니다. 기록과 이벤트를 고치지도 않았습니다.");
    log(`자세한 상태: npm run gate:g:budget-status -- --output ${options.output}`);
    log(`→ 상태: ${agreement.status} / 유료 호출: 없음`);
    return 2;
  }
  if (store.count() > 0) {
    log(
      `복원한 이전 지출: $${spentSoFar.toFixed(4)} (유료 기록 ${recovery.spend.countedRecords}건, ` +
        `fake 기록 ${recovery.spend.fakeRecords}건, 예산 이벤트 ${eventRead.events.length}건)`
    );
  }

  // 승인 상한이 이미 쓴 금액 이하면 **기존 실행 디렉터리가 없어도** 새 호출을 할 수 없다.
  // 이 검사를 메타 호환성 안쪽에만 두면 run.json이 없는 디렉터리에서 빠져나간다.
  const coverage = approvalCoversHistorical(options.maxCostUsd, spentSoFar);
  if (!coverage.ok) {
    log(coverage.reason);
    log("→ 상태: BLOCKED / 유료 호출: 없음");
    return 2;
  }

  const models = planModels({
    ...(options.executorModel ? { executorModel: options.executorModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    allowZeroPricing: usingFake,
    credentialPresence: credentialPresent,
  });
  if (!usingFake && !isModelPlan(models)) {
    log("모델 계획을 확정할 수 없습니다:");
    for (const blocker of models.blockers) log(`  - ${blocker}`);
    return 2;
  }

  const incomingMeta = {
    stage: options.stage ?? (isPilot ? "pilot" : "confirmatory"),
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
  let approvalRaisedTo: number | undefined;
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
    if (compat.budgetRaised && options.maxCostUsd !== undefined) {
      log(`예산 상한을 올렸습니다 — 새 사용자 승인으로 기록합니다: $${options.maxCostUsd}`);
      writeMeta(options.output, withApproval(existingMeta, options.maxCostUsd, now, "상한 상향"));
      approvalRaisedTo = options.maxCostUsd;
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
  //
  // **`initialCommittedUsd`가 핵심이다.** 이걸 넘기지 않으면 원장이 0에서 시작하므로
  // 재개할 때마다 승인 상한이 새로 주어진다(§1의 P0 결함). 이벤트 sink도 여기서 붙인다 —
  // 예산 결정이 프로세스 메모리에만 있으면 재시작 후 아무것도 설명할 수 없다.
  const ledger =
    !usingFake && options.maxCostUsd !== undefined
      ? createBudgetLedger(options.maxCostUsd, {
          initialCommittedUsd: spentSoFar,
          runId,
          stage: incomingMeta.stage,
          onEvent: createBudgetEventSink(options.output),
        })
      : undefined;
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
    // 승인 상향은 감사 추적에도 남긴다 — run.json만 보면 "언제 어느 실행에서" 올렸는지 모른다.
    if (approvalRaisedTo !== undefined) ledger.recordApprovalRaised(approvalRaisedTo, "사용자가 --max-cost-usd를 올렸습니다");
    log(
      `예산 ledger: 승인 상한 $${ledger.approvedLimitUsd} / 이전 실행 확정 $${ledger
        .historicalCommittedUsd()
        .toFixed(4)} / 이번 실행에 쓸 수 있는 금액 $${ledger.availableUsd().toFixed(4)}`
    );
    log("각 기록의 최대 비용을 **호출 전에 예약**합니다. 예약할 수 없으면 호출하지 않습니다.");
    log(`예산 이벤트: ${budgetEventsPath(options.output)}`);
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
    historicalSpentUsd: spentSoFar,
    ...(ledger ? { ledger } : {}),
    ...(estimateRecordCostUsd ? { estimateRecordCostUsd } : {}),
    realProvider: !usingFake,
    ...(options.executorModel ? { executorModel: options.executorModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    onProgress: log,
  });

  log("");
  log(`실행 ${result.executed}건 / 재개로 건너뜀 ${result.skippedResume}건 / 계획 ${result.planned}건`);
  // "누적 비용"이라는 한 줄로 뭉치지 않는다 — 재개한 실행에서 그 숫자가 session인지 전체인지
  // 모르면 상한을 지켰는지 판단할 수 없다.
  log(`이전 실행 확정: $${result.historicalSpentUsd.toFixed(4)}`);
  log(`이번 실행 확정: $${result.sessionSpentUsd.toFixed(4)}`);
  log(`전체 누적(승인 상한과 비교되는 값): $${result.cumulativeSpentUsd.toFixed(4)}`);
  log(
    result.availableUsd === undefined
      ? "남은 예산: (승인 상한이 없어 계산하지 않습니다)"
      : `남은 예산: $${result.availableUsd.toFixed(4)}`
  );
  if (ledger) {
    const snapshot = ledger.snapshot();
    log(
      `ledger: 이전 $${snapshot.historicalCommittedUsd.toFixed(4)} + 이번 ` +
        `$${snapshot.sessionCommittedUsd.toFixed(4)} = 누적 $${snapshot.cumulativeCommittedUsd.toFixed(4)} / ` +
        `예약 $${snapshot.reservedUsd.toFixed(4)} / 남음 $${snapshot.availableUsd.toFixed(4)} ` +
        `(예약 ${snapshot.reservationsOpened}건, 정산 ${snapshot.reservationsSettled}건, ` +
        `해제 ${snapshot.reservationsReleased}건)`
    );
    if (snapshot.estimateBreached) {
      log("**추정 초과(BUDGET_ESTIMATE_BREACH)가 발생했습니다** — 이후 유료 호출은 차단되었습니다.");
    }
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
    // 옵션 오류는 **사용법 문제**다. 스택을 보여주면 정작 읽어야 하는 사용법이 묻힌다.
    if (error instanceof OptionError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
    process.exit(3);
  });
