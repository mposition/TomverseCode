import { randomUUID } from "node:crypto";
import type { BudgetLedger } from "@tomverse/sidecar/budget";
import { armExecutionOrder, armSpec, ARMS } from "./arms.js";
import { criteriaHash } from "./criteria.js";
import { allPayloads, lastPayload, readEvents, runHost, type HostRunResult } from "./host.js";
import { promptVersionHash, type LoadedFixture } from "./manifest.js";
import { appendChecked, type RecordStore } from "./records.js";
import { classifyContribution } from "./stats.js";
import { classifyOracleFailure, runVerification } from "./oracle.js";
import { seededShuffle } from "./stats.js";
import {
  RECORD_SCHEMA_VERSION,
  type ArmId,
  type FailureClass,
  type GateRunRecord,
} from "./types.js";
import {
  changedFilesSince,
  injectOracle,
  materialize,
  touchedForbiddenPaths,
} from "./workspace.js";

/**
 * 실험 실행기.
 *
 * # 공정성 규칙 (§7)
 *
 * - arm/반복마다 fixture를 **새 임시 디렉터리로 복사**한다. 상태가 새어나가지 않는다.
 * - 같은 fixture는 arm 전체가 **글자 그대로 같은 prompt**를 받는다.
 * - fixture 실행 순서는 seed로 무작위화한다. arm 순서는 초안 의존성 때문에 위상 고정이다
 *   (A가 C/D보다 먼저여야 한다) — 그 사실을 리포트에 명시한다.
 * - 이미 완료된 (fixture, arm, repetition)은 다시 호출하지 않는다(`--resume`).
 * - 예산이 소진되면 **새 API 호출을 시작하지 않고** 지금까지의 결과를 남긴다.
 */

export interface RunnerOptions {
  fixtures: LoadedFixture[];
  arms: ArmId[];
  repetitions: number;
  seed: number;
  store: RecordStore;
  runId: string;
  maxCostUsd?: number;
  /**
   * 예산 ledger — 있으면 **호출 전에 예약**하고, 예약할 수 없으면 그 기록을 실행하지 않는다.
   * 없으면(fake/dry-run) 예산 강제가 없다.
   */
  ledger?: BudgetLedger;
  /** 한 기록의 보수적 최대 비용. ledger가 있으면 필수다 — 없으면 예약할 금액을 모른다. */
  estimateRecordCostUsd?: (arm: ArmId) => { maxUsd: number; basis: string } | undefined;
  /** 실제 공급자 실행인가. true면 비용을 잴 수 없는 기록에서 남은 유료 호출을 중단한다. */
  realProvider?: boolean;
  /** fake provider 스크립트 — 하네스 자동 테스트 전용. 있으면 기록이 `providerKind: "fake"`가 된다. */
  fakeScript?: unknown;
  executorModel?: string;
  reviewerModel?: string;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunnerResult {
  planned: number;
  executed: number;
  skippedResume: number;
  budgetExhausted: boolean;
  spentUsd: number;
  /** 비용을 잴 수 없어 중단했는가 — 이건 경고가 아니라 실행 차단 사유다. */
  unmeasurableCostAbort: boolean;
  /** 중단 사유(있으면). 리포트와 종료 메시지에 그대로 나간다. */
  abortReason?: string;
  dryRunPlan?: { fixtureId: string; arm: ArmId; repetition: number }[];
}

/**
 * 예산 소진 판정. 순수 함수로 떼어둔 이유: 이 결정이 틀리면 실제 돈이 새므로
 * fake provider(단가 0) 없이도 경계값을 직접 검증할 수 있어야 한다.
 */
export function budgetStop(spentUsd: number, maxCostUsd: number | undefined): boolean {
  if (maxCostUsd === undefined) return false;
  return spentUsd >= maxCostUsd;
}

/** 초안 캐시 키 — 같은 fixture/반복이면 같은 초안을 공유한다. */
function draftKey(fixtureId: string, repetition: number): string {
  return `${fixtureId}::${repetition}`;
}

export async function runExperiment(options: RunnerOptions): Promise<RunnerResult> {
  const armOrder = armExecutionOrder(options.arms);
  const orderedFixtures = seededShuffle(options.fixtures, options.seed);
  const log = options.onProgress ?? (() => undefined);
  const hash = criteriaHash();

  const plan: { fixture: LoadedFixture; arm: ArmId; repetition: number }[] = [];
  for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    // 반복마다 fixture 순서를 다시 섞는다 — 시간에 따른 공급자 상태 변화(rate limit, 캐시)가
    // 특정 fixture에 계통적으로 몰리지 않게 한다.
    for (const fixture of seededShuffle(orderedFixtures, options.seed + repetition)) {
      for (const arm of armOrder) {
        plan.push({ fixture, arm, repetition });
      }
    }
  }

  if (options.dryRun) {
    return {
      planned: plan.length,
      executed: 0,
      skippedResume: 0,
      budgetExhausted: false,
      spentUsd: 0,
      unmeasurableCostAbort: false,
      dryRunPlan: plan.map((p) => ({ fixtureId: p.fixture.manifest.fixtureId, arm: p.arm, repetition: p.repetition })),
    };
  }

  /** Arm A가 만든 초안을 Arm C/D가 재생하기 위한 캐시. */
  const drafts = new Map<string, unknown>();
  let spentUsd = 0;
  let executed = 0;
  let skippedResume = 0;
  let budgetExhausted = false;
  let unmeasurableCostAbort = false;
  let abortReason: string | undefined;

  for (const item of plan) {
    const { fixture, arm, repetition } = item;
    const fixtureId = fixture.manifest.fixtureId;

    if (options.store.isDone(fixtureId, arm, repetition)) {
      skippedResume += 1;
      // 재개 시에도 초안 공유가 성립해야 한다. 이미 저장된 Arm A 기록에서 초안을 복구한다.
      if (armSpec(arm).draftSource === "generate" && !drafts.has(draftKey(fixtureId, repetition))) {
        const restored = restoreDraftFromRecords(options.store, fixtureId, repetition, arm);
        if (restored) drafts.set(draftKey(fixtureId, repetition), restored);
      }
      continue;
    }

    if (budgetStop(spentUsd, options.maxCostUsd)) {
      // **새 API 호출을 시작하지 않는다.** 예산을 넘겨 쓰지 않는 것이 이 분기의 요점이다.
      budgetExhausted = true;
      log(`예산 상한 $${options.maxCostUsd} 소진 — 남은 ${plan.length - executed - skippedResume}건을 실행하지 않습니다`);
      break;
    }

    const spec = armSpec(arm);
    let replayDraft: unknown;
    if (spec.draftSource === "replay") {
      const source = spec.draftSourceArm!;
      replayDraft = drafts.get(draftKey(fixtureId, repetition));
      if (replayDraft === undefined) {
        // Arm A가 초안을 만들지 못한 경우(실패/인프라 오류). 새 초안을 만들어 대체하면
        // "같은 초안 공유"라는 전제가 깨지므로 **이 arm은 건너뛴다** — 조용히 다르게 돌리지 않는다.
        log(`${fixtureId} rep${repetition} Arm ${arm}: Arm ${source}의 초안이 없어 건너뜁니다`);
        appendChecked(
          options.store,
          skippedRecord(options, fixture, arm, repetition, hash, "fixture_setup_failure",
            `Arm ${source}의 초안을 얻지 못해 실행하지 않음`)
        );
        continue;
      }
    }

    // **유료 호출 전에 예약한다.** 사후 검사만으로는 마지막 한 건의 비용만큼 상한을 넘길 수 있다.
    let reservation: ReturnType<BudgetLedger["reserve"]> | undefined;
    if (options.ledger) {
      const estimate = options.estimateRecordCostUsd?.(arm);
      if (estimate === undefined) {
        abortReason =
          `${fixtureId} rep${repetition} Arm ${arm}: 예상 비용을 계산할 수 없어 유료 호출을 시작하지 않습니다`;
        unmeasurableCostAbort = true;
        log(abortReason);
        break;
      }
      reservation = options.ledger.reserve(estimate, `${fixtureId}/${arm}/rep${repetition}`);
      if (!reservation.ok) {
        budgetExhausted = true;
        abortReason = reservation.reason;
        log(`예약 실패 — 남은 ${plan.length - executed - skippedResume}건을 실행하지 않습니다`);
        log(`  ${reservation.reason}`);
        break;
      }
    }

    log(`${fixtureId} rep${repetition} Arm ${arm} 실행 중...`);
    let record: RecordWithDraft;
    try {
      record = executeOne({ ...options, fixture, arm, repetition, replayDraft, criteriaHashValue: hash });
    } catch (error) {
      // 예외로 빠져나가도 ledger가 예약을 물고 있으면 남은 예산이 영영 줄어든 채로 남는다.
      if (reservation?.ok) reservation.reservation.release();
      throw error;
    }

    // **실제 공급자인데 비용을 잴 수 없으면 남은 유료 호출을 중단한다.**
    // 예전에는 경고만 하고 계속 돌았는데, 그러면 예산 상한이 아무것도 막지 못하는 상태로
    // 몇 시간 동안 돈을 쓰게 된다. 0으로 대체하지도 않는다 — 0은 fake에만 참이다.
    const costUnmeasurable = options.realProvider === true && record.costUsd === undefined;
    if (costUnmeasurable) {
      record.failureClass = "cost_unmeasurable";
    }

    appendChecked(options.store, record);
    executed += 1;
    spentUsd += record.costUsd ?? 0;
    if (reservation?.ok) {
      // 실제 사용량으로 정산한다. 비용을 모르면 예약을 해제하되(과금 여부를 모르므로 확정하지 않는다)
      // 바로 다음에서 중단하므로 더 이상 유료 호출은 없다.
      if (record.costUsd === undefined) reservation.reservation.release();
      else reservation.reservation.settle(record.costUsd);
    }

    if (costUnmeasurable) {
      unmeasurableCostAbort = true;
      abortReason =
        `${fixtureId} rep${repetition} Arm ${arm}: 실제 응답에 usage가 없거나 비용을 계산할 수 없습니다. ` +
        `예산 상한을 강제할 수 없으므로 남은 유료 호출을 중단합니다 (기록은 보존되며 --resume으로 이어받을 수 있습니다).`;
      log(abortReason);
      break;
    }

    if (spec.draftSource === "generate" && record.draftProposal !== undefined) {
      drafts.set(draftKey(fixtureId, repetition), record.draftProposal);
    }
  }

  return {
    planned: plan.length,
    executed,
    skippedResume,
    budgetExhausted,
    spentUsd,
    unmeasurableCostAbort,
    ...(abortReason !== undefined ? { abortReason } : {}),
  };
}

/** 저장된 Arm A 기록에서 초안을 복구한다 — resume 후에도 C/D가 같은 초안을 쓸 수 있어야 한다. */
function restoreDraftFromRecords(
  store: RecordStore,
  fixtureId: string,
  repetition: number,
  arm: ArmId
): unknown | undefined {
  const record = store
    .all()
    .find((r) => r.fixtureId === fixtureId && r.arm === arm && r.repetition === repetition) as
    | (GateRunRecord & { draftProposal?: unknown })
    | undefined;
  return record?.draftProposal;
}

interface ExecuteOneOptions extends RunnerOptions {
  fixture: LoadedFixture;
  arm: ArmId;
  repetition: number;
  replayDraft?: unknown;
  criteriaHashValue: string;
}

/** 기록에 초안을 함께 실어 나른다(재개 시 복구용). JSONL에는 그대로 저장된다. */
type RecordWithDraft = GateRunRecord & { draftProposal?: unknown };

function executeOne(options: ExecuteOneOptions): RecordWithDraft {
  const { fixture, arm, repetition } = options;
  const manifest = fixture.manifest;
  const spec = armSpec(arm);
  const taskId = `gate-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const workspace = materialize(fixture, `${manifest.fixtureId}-${arm}-${repetition}`);

  const base: RecordWithDraft = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId: options.runId,
    fixtureId: manifest.fixtureId,
    fixtureHash: fixture.fixtureHash,
    category: manifest.category,
    repetition,
    arm,
    seed: options.seed,
    taskId,
    providerId: spec.providers.join("+"),
    requestedModelId: options.executorModel ?? "(registry default)",
    publicVerificationPassed: false,
    oracleVerificationPassed: false,
    inputTokens: 0,
    outputTokens: 0,
    providerCallCount: 0,
    retryCount: 0,
    latencyMs: 0,
    changedFiles: [],
    policyDenials: [],
    promptVersionHash: promptVersionHash(manifest),
    startedAt,
    completedAt: startedAt,
    providerKind: options.fakeScript !== undefined ? "fake" : "real",
    criteriaHash: options.criteriaHashValue,
  };
  if (spec.reviewMode) base.reviewMode = spec.reviewMode;

  try {
    const hostResult = runHost({
      workspaceRoot: workspace.root,
      taskPrompt: manifest.taskPrompt,
      arm: spec,
      taskId,
      timeoutMs: manifest.timeoutMs,
      ...(options.replayDraft !== undefined ? { replayDraft: options.replayDraft } : {}),
      ...(options.fakeScript !== undefined ? { fakeScript: options.fakeScript } : {}),
      ...(options.executorModel ? { executorModel: options.executorModel } : {}),
      ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    });

    base.latencyMs = hostResult.wallClockMs;
    base.taskId = hostResult.taskId;

    const infraFailure = classifyInfrastructureFailure(hostResult);
    if (infraFailure) {
      base.failureClass = infraFailure;
      base.completedAt = new Date().toISOString();
      return base;
    }

    const events = readEvents(hostResult.dbPath, workspace.root, hostResult.taskId);
    applyEventDerivedFields(base, events);

    // ---- 변경 파일과 금지 경로 ----
    base.changedFiles = changedFilesSince(fixture, workspace.root);
    const forbidden = touchedForbiddenPaths(manifest.forbiddenPaths, base.changedFiles);

    // ---- 공개 검증 (모델이 볼 수 있었던 것) ----
    const publicOutcome = runVerification(manifest.publicVerificationCommands, workspace.root, manifest.timeoutMs);
    base.publicVerificationPassed = publicOutcome.passed;

    // ---- oracle 주입 후 진짜 판정 ----
    // 모델의 실행이 완전히 끝난 **뒤에만** 넣는다.
    const { collisions } = injectOracle(fixture, workspace.root);
    const oracleOutcome = runVerification(manifest.oracleVerificationCommands, workspace.root, manifest.timeoutMs);
    base.oracleVerificationPassed = oracleOutcome.passed && forbidden.length === 0;

    if (forbidden.length > 0) {
      base.failureClass = "forbidden_path_touched";
    } else if (collisions.length > 0 && !oracleOutcome.passed) {
      // 모델이 oracle 파일 이름을 맞춰 만들어 두었다 — 정상 수정이 아니다.
      base.failureClass = "wrong_patch";
    } else if (!oracleOutcome.passed) {
      base.failureClass = (classifyOracleFailure(oracleOutcome) as FailureClass) ?? "incomplete_fix";
    } else if (base.changedFiles.length === 0) {
      // oracle이 통과했는데 바뀐 파일이 없다면 fixture가 처음부터 통과한 것이다 — fixture 결함이다.
      base.failureClass = "fixture_setup_failure";
      base.oracleVerificationPassed = false;
    }

    if (hostResult.status !== "completed" && base.failureClass === undefined) {
      base.failureClass = hostResult.status === "rejected" ? "requirement_unmet" : "incomplete_fix";
    }

    base.completedAt = new Date().toISOString();
    return base;
  } catch (error) {
    // 하네스 자체의 예외는 **인프라 실패**다. 모델 실패로 세면 결과가 왜곡된다.
    base.failureClass = "oracle_harness_failure";
    base.completedAt = new Date().toISOString();
    base.policyDenials = [`harness error: ${String(error).slice(0, 300)}`];
    return base;
  } finally {
    workspace.cleanup();
  }
}

/** 프로세스를 띄우지 못했거나 공급자 인증/한도 문제인가. */
function classifyInfrastructureFailure(result: HostRunResult): FailureClass | undefined {
  if (result.spawnError) return "host_crash";
  if (result.failureReason === "provider_config_error") return "auth_failure";
  const stderr = result.stderr;
  if (/rate.?limit|429/i.test(stderr)) return "rate_limit";
  if (/\b5\d\d\b|internal server error|overloaded/i.test(stderr)) return "provider_5xx";
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(stderr)) return "network_timeout";
  return undefined;
}

/** DB 이벤트에서 usage/verdict/초안을 뽑아 기록을 채운다. */
function applyEventDerivedFields(record: RecordWithDraft, events: ReturnType<typeof readEvents>): void {
  for (const usage of allPayloads(events, "PROVIDER_USAGE")) {
    const u = usage as { usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number };
    record.inputTokens += u.usage?.inputTokens ?? 0;
    record.outputTokens += u.usage?.outputTokens ?? 0;
    record.costUsd = (record.costUsd ?? 0) + (u.costUsd ?? 0);
    record.providerCallCount += 1;
  }
  record.retryCount = allPayloads(events, "PROVIDER_RETRY").length;

  const routing = lastPayload(events, "ROUTING_DECIDED") as
    | { assignments?: { role: string; modelId: string; providerId: string }[] }
    | undefined;
  const executor = routing?.assignments?.find((a) => a.role === "executor");
  if (executor) {
    record.requestedModelId = executor.modelId;
    record.providerId = routing!.assignments!.map((a) => `${a.role}=${a.providerId}`).join(",");
  }

  const draft = lastPayload(events, "DRAFT_RECEIVED") as
    | { patch?: string | null; plan?: unknown; model?: string; proposalId?: string; interpretation?: string;
        risks?: string[]; uncertainties?: string[]; draftSource?: string }
    | undefined;
  if (draft) {
    record.returnedModelId = draft.model;
    if (draft.draftSource === "replayed" || draft.draftSource === "generated") {
      record.draftSource = draft.draftSource;
    }
    // 재생용으로 보관 — DraftProposal의 필수 형태를 갖춘 경우에만.
    if (draft.proposalId && typeof draft.patch === "string") {
      record.draftProposal = {
        taskId: record.taskId,
        proposalId: draft.proposalId,
        interpretation: draft.interpretation ?? "",
        relevantFiles: [],
        plan: Array.isArray(draft.plan) ? draft.plan : [],
        patch: draft.patch,
        risks: draft.risks ?? [],
        requiredTests: [],
        uncertainties: draft.uncertainties ?? [],
        doneCriteria: [],
        model: draft.model ?? "",
        createdAt: record.startedAt,
      };
    }
  }

  const review = lastPayload(events, "REVIEW_RECEIVED") as
    | { verdict?: string; reviewMode?: "blind" | "informed" }
    | undefined;
  if (review?.verdict) record.reviewerVerdict = review.verdict;
  if (review?.reviewMode) record.reviewMode = review.reviewMode;

  record.policyDenials = allPayloads(events, "POLICY_DECIDED")
    .filter((p) => (p as { decision?: string }).decision === "deny")
    .map((p) => {
      const d = p as { normalizedTarget?: string; matchedRule?: string };
      return `${d.matchedRule ?? "?"}:${d.normalizedTarget ?? "?"}`;
    });
}

function skippedRecord(
  options: RunnerOptions,
  fixture: LoadedFixture,
  arm: ArmId,
  repetition: number,
  hash: string,
  failureClass: FailureClass,
  note: string
): GateRunRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId: options.runId,
    fixtureId: fixture.manifest.fixtureId,
    fixtureHash: fixture.fixtureHash,
    category: fixture.manifest.category,
    repetition,
    arm,
    seed: options.seed,
    taskId: `skipped-${randomUUID()}`,
    providerId: armSpec(arm).providers.join("+"),
    requestedModelId: "(not called)",
    publicVerificationPassed: false,
    oracleVerificationPassed: false,
    inputTokens: 0,
    outputTokens: 0,
    providerCallCount: 0,
    retryCount: 0,
    latencyMs: 0,
    failureClass,
    changedFiles: [],
    policyDenials: [note],
    promptVersionHash: promptVersionHash(fixture.manifest),
    startedAt: now,
    completedAt: now,
    providerKind: options.fakeScript !== undefined ? "fake" : "real",
    criteriaHash: hash,
  };
}

/**
 * counterfactual 채우기 — Arm A(초안만)와 Arm C/D(검수 후)를 fixture/반복으로 짝지어
 * reviewer 기여를 분류한다.
 *
 * 실행이 전부 끝난 뒤에 한 번에 계산한다: Arm A의 결과를 알아야 Arm C의 기여를 말할 수 있는데,
 * 실행 순서상 A가 먼저이므로 실행 중에도 가능하지만, **재개된 실행에서도 같은 값이 나오도록**
 * 기록 전체를 보고 계산하는 편이 안전하다.
 */
export function fillReviewerContributions(records: GateRunRecord[]): GateRunRecord[] {
  const byKey = new Map<string, GateRunRecord>();
  for (const record of records) {
    byKey.set(`${record.fixtureId}::${record.arm}::${record.repetition}`, record);
  }
  for (const record of records) {
    const spec = ARMS.find((a) => a.arm === record.arm);
    if (!spec || spec.draftSource !== "replay" || !spec.draftSourceArm) continue;
    const draftRun = byKey.get(`${record.fixtureId}::${spec.draftSourceArm}::${record.repetition}`);
    if (!draftRun) continue;
    record.draftOraclePassed = draftRun.oracleVerificationPassed;
    record.reviewedOraclePassed = record.oracleVerificationPassed;
    record.reviewerContribution = classifyContribution(
      draftRun.oracleVerificationPassed,
      record.oracleVerificationPassed
    );
  }
  return records;
}
