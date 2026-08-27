import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { BudgetLedger, DispatchState } from "@tomverse/sidecar/budget";
import { armExecutionOrder, armSpec, ARMS } from "./arms.js";
import { criteriaHash } from "./criteria.js";
import {
  allPayloads,
  lastDraftProposalPayload,
  lastPayload,
  readEvents,
  runHost,
  type HostRunResult,
} from "./host.js";
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
  type ProviderCallFact,
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
   * **이전 실행들에서 이미 확정된 비용.** 재개할 때 복원해서 넘긴다.
   *
   * 이 값이 없으면 `budgetStop`이 이번 프로세스의 지출만 보므로, 재개할 때마다 승인 상한이
   * 처음부터 다시 주어진다 — $25 한도에서 $20을 쓰고 재개하면 $25를 더 쓸 수 있었다.
   * 상한과 비교해야 하는 값은 session이 아니라 **cumulative**다.
   */
  historicalSpentUsd?: number;
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
  /** 공급자 호출 1회 타임아웃(ms). 게이트는 이걸 명시적으로 넘긴다 (host.ts 참조). */
  providerTimeoutMs?: number;
  /** 호스트 바이너리 override — 하네스 자동 테스트 전용 (host.ts 참조). */
  hostBin?: string;
  executorModel?: string;
  reviewerModel?: string;
  /** 이 실행을 승인한 receipt. 모든 기록에 그대로 실린다 (§2.3). */
  receiptId?: string;
  receiptHash?: string;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunnerResult {
  planned: number;
  executed: number;
  skippedResume: number;
  budgetExhausted: boolean;
  /**
   * 지출 세 가지를 **이름으로 구별한다.**
   *
   * 예전에는 `spentUsd` 하나였고 그것이 "이번 프로세스의 지출"이었는데 로그에는
   * "누적 비용"으로 찍혔다. 재개한 실행에서 그 숫자를 보고 "$3밖에 안 썼네"라고 읽으면
   * 실제로는 $23을 쓴 상태일 수 있다. 승인 상한과 비교되는 값은 cumulative뿐이다.
   */
  historicalSpentUsd: number;
  sessionSpentUsd: number;
  cumulativeSpentUsd: number;
  /** 승인 상한이 있을 때 남은 금액. 상한이 없으면 `undefined`(0으로 적지 않는다). */
  availableUsd?: number;
  /** 비용을 잴 수 없어 중단했는가 — 이건 경고가 아니라 실행 차단 사유다. */
  unmeasurableCostAbort: boolean;
  /** 중단 사유(있으면). 리포트와 종료 메시지에 그대로 나간다. */
  abortReason?: string;
  dryRunPlan?: { fixtureId: string; arm: ArmId; repetition: number }[];
}

/**
 * 예산 소진 판정. 순수 함수로 떼어둔 이유: 이 결정이 틀리면 실제 돈이 새므로
 * fake provider(단가 0) 없이도 경계값을 직접 검증할 수 있어야 한다.
 *
 * 인자 이름이 `cumulativeSpentUsd`인 것이 중요하다 — **이전 실행분을 포함한 값**이어야 한다.
 * session 지출을 넘기면 재개 횟수만큼 상한이 늘어난다.
 */
export function budgetStop(cumulativeSpentUsd: number, maxCostUsd: number | undefined): boolean {
  if (maxCostUsd === undefined) return false;
  return cumulativeSpentUsd >= maxCostUsd;
}

/**
 * 이 기록의 provider 요청이 실제로 나갔는가 (§2.6, §2.7).
 *
 * # 무엇을 고쳤나 — 실측 시나리오
 *
 * 예전 판정은 이랬다: `providerCallCount === 0`이고 `failureClass !== "network_timeout"`이면
 * `not_dispatched` → **예약 전액 해제.** 그런데 `providerCallCount`는 `PROVIDER_USAGE` 이벤트를
 * 센 값이고, 그 이벤트는 host 실패 분류 **이후에** 읽혔다. 그래서 다음이 가능했다:
 *
 * 1. executor 호출 성공, 과금 발생, `PROVIDER_USAGE` 기록됨
 * 2. reviewer 호출이 5xx로 실패 → host가 실패로 종료
 * 3. runner가 `classifyInfrastructureFailure`에서 곧바로 반환 → **DB를 읽지 않음**
 * 4. `providerCallCount = 0`, `costUsd = undefined` → `not_dispatched`
 * 5. 예약 전액 해제 → **이미 쓴 executor 비용이 승인 예산에서 사라짐**
 *
 * # 새 규칙
 *
 * `auth_failure`·`rate_limit`·`provider_5xx`는 **HTTP 분류일 뿐 dispatch 사실이 아니다.**
 * 429나 5xx를 받았다는 것은 요청이 공급자에게 **도달했다**는 뜻이고, 그 앞 호출이 과금됐을 수
 * 있다. 그래서 해제의 근거가 되지 못한다.
 *
 * 해제(`not_dispatched`)는 **적극적 증거**가 있을 때만이다:
 * 이벤트를 읽을 수 있었고, `PROVIDER_CALL_STARTED`가 하나도 없으며, 실패가 호출 이전 단계에서
 * 났을 때. 자격증명 없음, fixture 준비 실패, 툴체인 미준비가 그것이다.
 *
 * 이벤트를 읽지 못했으면 `dispatched_no_response`다 — "모른다"를 "안 썼다"로 읽지 않는다.
 */

/**
 * 401/403이 **연속** 몇 번이면 그 공급자를 끊는가.
 *
 * 1회로 끊지 않는 이유: 일시적인 경우가 있고, 그때 끊으면 멀쩡한 공급자의 표본을 잃는다.
 * 2회로 두는 이유: 자격증명·권한 문제는 재시도로 풀리지 않으므로 두 번이면 충분히 확실하고,
 * 더 기다리면 같은 실패에 시간과 (429가 아닌 이상 0원이지만) 호출을 계속 쓴다.
 */
const AUTH_CIRCUIT_THRESHOLD = 2;

/** 호출 이전 단계에서만 날 수 있는 실패. 이 목록에 HTTP 분류를 넣지 말 것. */
const PRE_DISPATCH_FAILURES: ReadonlySet<string> = new Set([
  "auth_failure",
  // 추론 전 반려 — 비용이 없다는 것이 실측으로 확인된 유일한 4xx 계열이다.
  "invalid_request",
  "fixture_setup_failure",
  "toolchain_unavailable",
]);

export function classifyDispatch(record: {
  providerCalls: readonly { dispatchState: DispatchState; costUsd?: number }[];
  eventsReadable: boolean;
  costUsd?: number;
  failureClass?: string;
}): DispatchState {
  // 이벤트를 읽지 못했으면 아무것도 단정할 수 없다. **가장 보수적인 쪽**으로 간다.
  if (!record.eventsReadable) return "dispatched_no_response";

  if (record.providerCalls.length === 0) {
    // 호출이 시작된 흔적이 없다. 그래도 해제하려면 실패가 호출 **이전**이어야 한다.
    if (record.failureClass !== undefined && PRE_DISPATCH_FAILURES.has(record.failureClass)) {
      return "not_dispatched";
    }
    if (record.failureClass === undefined) return "not_dispatched";
    // rate_limit / provider_5xx / network_timeout / host_crash 등: 요청이 나갔을 수 있다.
    return "dispatched_no_response";
  }

  const uncertain = record.providerCalls.filter(
    (c) => c.dispatchState === "dispatched_no_response" || c.dispatchState === "response_received_without_usage"
  );
  const measured = record.providerCalls.filter((c) => c.dispatchState === "response_received_with_usage");

  if (uncertain.length > 0) {
    // 측정된 비용과 불확실한 attempt가 **동시에** 있을 수 있다. 그 구별은 호출자가
    // `partialSettlement`으로 처리한다 — 여기서는 "불확실한 것이 있다"만 말한다.
    return uncertain.some((c) => c.dispatchState === "response_received_without_usage")
      ? "response_received_without_usage"
      : "dispatched_no_response";
  }
  if (measured.length > 0) {
    return record.costUsd === undefined ? "response_received_without_usage" : "response_received_with_usage";
  }
  // 전부 not_dispatched로 기록된 호출들.
  return "not_dispatched";
}

/**
 * 이 기록에서 **확정된 비용**과 **불확실한 attempt**를 분리한다 (§2.7).
 *
 * 한 record에 둘이 함께 있으면 전액 해제도 전액 정산도 옳지 않다. 확정분은 보존하고 나머지는
 * 미해결로 남긴다 — "전체 reservation을 release해서는 안 된다".
 */
export function partitionSettlement(record: {
  providerCalls: readonly { dispatchState: DispatchState; costUsd?: number }[];
}): { measuredUsd: number; measuredCalls: number; uncertainCalls: number } {
  let measuredUsd = 0;
  let measuredCalls = 0;
  let uncertainCalls = 0;
  for (const call of record.providerCalls) {
    if (call.dispatchState === "response_received_with_usage" && typeof call.costUsd === "number") {
      measuredUsd += call.costUsd;
      measuredCalls += 1;
      continue;
    }
    if (call.dispatchState !== "not_dispatched") uncertainCalls += 1;
  }
  return { measuredUsd, measuredCalls, uncertainCalls };
}

/**
 * 정산 이벤트에 실을 **응답 envelope 모델 ID.**
 *
 * `record.returnedModelId`(= `DRAFT_RECEIVED.model`)를 쓰지 않는다 — 그건 어댑터가 자기
 * 요청 ID를 채운 자기보고 값이므로, 그것으로 "요청한 모델이 왔다"를 감사할 수 없다(§2.8).
 * 성공한 호출들이 하나의 값에 동의할 때만 적고, 갈리면 적지 않는다.
 */
function envelopeModelId(record: { providerCalls: readonly ProviderCallFact[] }): string | undefined {
  const reported = new Set(
    record.providerCalls
      .filter((c) => c.status === "succeeded")
      .map((c) => c.providerReportedModelId)
      .filter((m): m is string => typeof m === "string")
  );
  return reported.size === 1 ? [...reported][0] : undefined;
}

/**
 * 초안 캐시 키 — **초안을 만든 arm까지 포함한다.**
 *
 * 예전에는 `fixture::repetition`뿐이었다. 그런데 초안을 생성하는 arm은 하나가 아니다 —
 * A(OpenAI)와 B(Anthropic)가 **둘 다** `draftSource: "generate"`이므로, 나중에 도는 B가
 * A의 초안을 덮어썼다. 그러면 A의 초안을 재생해야 하는 C/D가 **B의 초안**을 받는다.
 *
 * 조용히 실험을 무너뜨리는 종류다. A↔C 차이는 "같은 초안에 검수를 붙인 순효과"여야 하는데,
 * C가 다른 모델의 초안을 검수하면 그 차이는 초안 모델의 차이와 검수 효과가 섞인 값이 된다.
 * 게다가 초안 저자가 검수자와 같은 공급자가 되어 라우터의 13.3절 절충이 발동하고, **검수자가
 * executor 모델로 바뀐다** — 실측(P0, 2026-08-27)에서 `asy-03`의 C/D가 그렇게 됐고
 * attestation의 "응답 envelope 모델 ID 일치" 검사가 그것을 잡아 P1을 막았다.
 *
 * 더 나쁜 것은 **순서 의존이라 절반만 틀린다**는 점이다: A의 초안이 살아남는 fixture와
 * 덮어써지는 fixture가 섞여 있었다(같은 실행에서 `amb-01`은 A, `asy-03`은 B였다).
 */
function draftKey(fixtureId: string, repetition: number, arm: ArmId): string {
  return `${fixtureId}::${arm}::${repetition}`;
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

  // 재개로 복원한 이전 지출. ledger가 있으면 그 값이 정본이다 — 두 곳에서 따로 세면 갈라진다.
  const historicalSpentUsd = options.ledger?.historicalCommittedUsd() ?? options.historicalSpentUsd ?? 0;
  const remaining = (cumulative: number): number | undefined =>
    options.maxCostUsd === undefined ? undefined : options.maxCostUsd - cumulative;

  if (options.dryRun) {
    return {
      planned: plan.length,
      executed: 0,
      skippedResume: 0,
      budgetExhausted: false,
      historicalSpentUsd,
      sessionSpentUsd: 0,
      cumulativeSpentUsd: historicalSpentUsd,
      ...(remaining(historicalSpentUsd) !== undefined ? { availableUsd: remaining(historicalSpentUsd)! } : {}),
      unmeasurableCostAbort: false,
      dryRunPlan: plan.map((p) => ({ fixtureId: p.fixture.manifest.fixtureId, arm: p.arm, repetition: p.repetition })),
    };
  }

  /** Arm A가 만든 초안을 Arm C/D가 재생하기 위한 캐시. */
  const drafts = new Map<string, unknown>();
  let sessionSpentUsd = 0;
  let executed = 0;
  let skippedResume = 0;
  let budgetExhausted = false;
  let unmeasurableCostAbort = false;
  let abortReason: string | undefined;
  /** 공급자별 **연속** 인증/권한 실패 횟수. 성공이 끼면 되돌린다. */
  const consecutiveAuthFailures = new Map<string, number>();
  /** circuit이 열린 공급자 — 이 공급자를 쓰는 arm만 건너뛴다. */
  const openCircuits = new Set<string>();

  for (const item of plan) {
    const { fixture, arm, repetition } = item;
    const fixtureId = fixture.manifest.fixtureId;

    if (options.store.isDone(fixtureId, arm, repetition)) {
      skippedResume += 1;
      // 재개 시에도 초안 공유가 성립해야 한다. 이미 저장된 Arm A 기록에서 초안을 복구한다.
      if (armSpec(arm).draftSource === "generate" && !drafts.has(draftKey(fixtureId, repetition, arm))) {
        const restored = restoreDraftFromRecords(options.store, fixtureId, repetition, arm);
        if (restored) drafts.set(draftKey(fixtureId, repetition, arm), restored);
      }
      continue;
    }

    // **cumulative로 비교한다.** session만 보면 재개 횟수만큼 상한이 늘어난다.
    if (budgetStop(historicalSpentUsd + sessionSpentUsd, options.maxCostUsd)) {
      // **새 API 호출을 시작하지 않는다.** 예산을 넘겨 쓰지 않는 것이 이 분기의 요점이다.
      budgetExhausted = true;
      log(
        `예산 상한 $${options.maxCostUsd} 소진 (누적 $${(historicalSpentUsd + sessionSpentUsd).toFixed(4)} = ` +
          `이전 $${historicalSpentUsd.toFixed(4)} + 이번 $${sessionSpentUsd.toFixed(4)}) — ` +
          `남은 ${plan.length - executed - skippedResume}건을 실행하지 않습니다`
      );
      break;
    }

    const spec = armSpec(arm);

    /**
     * circuit이 열린 공급자를 쓰는 arm은 건너뛴다 — **실험 전체는 계속한다.**
     *
     * 기록은 남긴다. 남기지 않으면 그 arm의 표본이 왜 비어 있는지 집계가 설명하지 못하고,
     * "모델이 못 풀었다"와 "돌려보지도 못했다"가 같은 빈칸이 된다.
     */
    const blockedBy = spec.providers.filter((providerId) => openCircuits.has(providerId));
    if (blockedBy.length > 0) {
      log(`${fixtureId} rep${repetition} Arm ${arm}: ${blockedBy.join(", ")}의 circuit이 열려 건너뜁니다`);
      appendChecked(
        options.store,
        skippedRecord(options, fixture, arm, repetition, hash, "auth_failure",
          `circuit_open:${blockedBy.join(",")} — 인증/권한 실패가 연속되어 이 공급자를 쓰는 arm을 중단함`)
      );
      executed += 1;
      continue;
    }

    let replayDraft: unknown;
    if (spec.draftSource === "replay") {
      const source = spec.draftSourceArm!;
      replayDraft = drafts.get(draftKey(fixtureId, repetition, source));
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
      // 예외로 빠져나가면 **요청이 나갔는지 알 수 없다.** 해제하면 과금됐을 수 있는 돈을
      // 안 쓴 것으로 만드는 것이므로, 미해결로 남기고 사람이 확인하게 한다.
      if (reservation?.ok) {
        reservation.reservation.markUnresolved({
          dispatchState: "dispatched_no_response",
          reason: `하네스 예외로 중단되어 provider 호출 여부를 확인할 수 없습니다: ${String(error).slice(0, 200)}`,
        });
      }
      throw error;
    }

    // **실제 공급자인데 비용을 잴 수 없으면 남은 유료 호출을 중단한다.**
    // 예전에는 경고만 하고 계속 돌았는데, 그러면 예산 상한이 아무것도 막지 못하는 상태로
    // 몇 시간 동안 돈을 쓰게 된다. 0으로 대체하지도 않는다 — 0은 fake에만 참이다.
    const costUnmeasurable = options.realProvider === true && record.costUsd === undefined;
    if (costUnmeasurable) {
      /**
       * **타임아웃을 `cost_unmeasurable`로 뭉개지 않는다.**
       *
       * 둘 다 "비용을 못 쟀다"로 끝나지만 고칠 곳이 다르다. usage가 없는 응답은 어댑터나
       * 단가표의 문제이고, 타임아웃은 **우리가 정한 실행 예산**의 문제다. 하나로 적으면
       * 원인을 알아내려고 매번 호출 시각을 손으로 빼봐야 한다.
       *
       * 그리고 모델 품질과도 섞이면 안 된다 — 둘 다 인프라 실패로 분모에서 빠지지만,
       * 실패율을 읽는 사람에게 "모델이 못 풀었다"와 "우리가 기다려주지 않았다"는 다른 소식이다.
       */
      const timedOut = record.providerCalls.some((call) => call.errorKind === "timeout");
      /**
       * **추론 전 반려는 비용 미측정이 아니라 비용 0이다.**
       *
       * 429·401·403이 아닌 4xx는 공급자가 생성을 시작하기 전에 요청을 반려한 것이므로
       * 과금되지 않는다 — 이 저장소에서 실측으로 확인했다(strict 스키마 400 거절이 공급자
       * 청구 내역에 없었다). `cost_unmeasurable`로 두면 "얼마인지 모른다"가 되어 예약을
       * 정산할 수도 해제할 수도 없고, **그 한 건이 96건 전체를 멈춘다.**
       *
       * 그 일이 실제로 반복됐다(P1이 네 번 멈췄고 매번 다른 원인이었다). 비용을 아는 경우를
       * 모르는 것으로 적으면 예산 보호가 아니라 실행 불가가 된다.
       */
      const rejected =
        record.providerCalls.some((call) => call.errorKind === "rejected") &&
        !record.providerCalls.some((call) => call.dispatchState === "response_received_with_usage");
      if (rejected) {
        record.failureClass = "invalid_request";
        record.costUsd = 0;
      } else {
        record.failureClass = timedOut ? "provider_timeout" : "cost_unmeasurable";
      }
    }

    appendChecked(options.store, record);
    executed += 1;
    sessionSpentUsd += record.costUsd ?? 0;
    if (reservation?.ok) {
      const dispatch = classifyDispatch(record);
      const split = partitionSettlement(record);

      if (dispatch === "response_received_with_usage" && record.costUsd !== undefined) {
        const outcome = reservation.reservation.settle({
          cost: { measured: true, usd: record.costUsd },
          usage: { measured: true, inputTokens: record.inputTokens, outputTokens: record.outputTokens },
          providerKind: record.providerKind,
          requestedModelId: record.requestedModelId,
          ...(envelopeModelId(record) ? { providerReportedModelId: envelopeModelId(record)! } : {}),
          dispatchState: dispatch,
        });
        if (!outcome.ok) {
          // 수치 검증 실패 — 원장이 차단 상태가 됐다. 남은 유료 호출을 시작하지 않는다.
          unmeasurableCostAbort = true;
          abortReason = `${fixtureId} rep${repetition} Arm ${arm}: ${outcome.reason} (원장 상태 ${outcome.state})`;
          log(abortReason);
          break;
        }
      } else if (dispatch === "not_dispatched") {
        reservation.reservation.release({
          dispatchState: "not_dispatched",
          reason: `provider 호출 없이 끝난 기록입니다 (${record.failureClass ?? "사유 없음"})`,
        });
      } else if (split.measuredCalls > 0 && split.measuredUsd > 0) {
        // **확정된 비용과 불확실한 attempt가 함께 있다** (§2.7).
        //
        // 전액 해제하면 executor가 실제로 쓴 돈이 사라지고, 전액 정산하면 불확실한 attempt의
        // 과금 가능성이 승인 예산에서 사라진다. 확정분은 세고 나머지는 미해결로 남긴다 —
        // 그러면 이 디렉터리는 재개 불가가 되고 사람이 청구 내역으로 확인하게 된다.
        const outcome = reservation.reservation.settlePartial({
          measured: {
            cost: { measured: true, usd: split.measuredUsd },
            usage: { measured: true, inputTokens: record.inputTokens, outputTokens: record.outputTokens },
            providerKind: record.providerKind,
            requestedModelId: record.requestedModelId,
            ...(envelopeModelId(record) ? { providerReportedModelId: envelopeModelId(record)! } : {}),
            dispatchState: "response_received_with_usage",
          },
          unresolved: {
            dispatchState: dispatch,
            reason:
              `호출 ${split.measuredCalls}건은 비용이 확정됐고 ${split.uncertainCalls}건은 과금 여부가 ` +
              `불확실합니다 (${record.failureClass ?? "사유 없음"}). 확정분만 반영하고 나머지는 미해결로 남깁니다.`,
          },
        });
        unmeasurableCostAbort = true;
        abortReason =
          `${fixtureId} rep${repetition} Arm ${arm}: 확정 $${split.measuredUsd.toFixed(6)} + ` +
          `불확실 ${split.uncertainCalls}건 — 남은 유료 호출을 중단합니다` +
          (outcome.ok ? "" : ` (${outcome.reason})`);
        log(abortReason);
        break;
      } else {
        // **과금 여부를 모른다.** 해제하지 않고 미해결로 남긴다.
        reservation.reservation.markUnresolved({
          dispatchState: dispatch,
          reason:
            `${dispatch}: 요청이 나갔을 수 있으나 비용을 확정할 수 없습니다 ` +
            `(${record.failureClass ?? "사유 없음"}, provider 호출 ${record.providerCalls.length}건, ` +
            `이벤트 읽기 ${record.eventsReadable ? "성공" : "실패"})`,
        });
      }
    }

    // **반려는 멈출 이유가 아니다.** 비용을 아는(0인) 실패이므로 예산 상한은 여전히 강제된다.
    if (costUnmeasurable && record.failureClass !== "invalid_request") {
      unmeasurableCostAbort = true;
      abortReason =
        `${fixtureId} rep${repetition} Arm ${arm}: 실제 응답에 usage가 없거나 비용을 계산할 수 없습니다. ` +
        `예산 상한을 강제할 수 없으므로 남은 유료 호출을 중단합니다 (기록은 보존되며 --resume으로 이어받을 수 있습니다).`;
      log(abortReason);
      break;
    }

    /**
     * **401/403 circuit breaker — 공급자 단위로 끊고 실험은 계속한다.**
     *
     * 자격증명이나 권한 문제는 재시도로 풀리지 않고, 그 공급자를 쓰는 arm은 전부 같은 실패를
     * 반복한다. 그렇다고 실행 전체를 멈추면 **그 공급자와 무관한 arm의 데이터까지 잃는다** —
     * Arm B(anthropic 단독)는 openai가 죽어도 멀쩡히 돌 수 있다.
     *
     * **연속**으로 셈하는 이유: 한 번은 일시적일 수 있다. 중간에 성공이 끼면 자격증명 문제가
     * 아니므로 계수를 되돌린다.
     */
    for (const providerId of new Set(record.providerCalls.map((call) => call.providerId))) {
      const calls = record.providerCalls.filter((call) => call.providerId === providerId);
      const authFailed = calls.some((call) => call.errorKind === "auth");
      const anySucceeded = calls.some((call) => call.status === "succeeded");
      if (authFailed && !anySucceeded) {
        const next = (consecutiveAuthFailures.get(providerId) ?? 0) + 1;
        consecutiveAuthFailures.set(providerId, next);
        if (next >= AUTH_CIRCUIT_THRESHOLD && !openCircuits.has(providerId)) {
          openCircuits.add(providerId);
          log(
            `${providerId}: 인증/권한 실패가 연속 ${next}회 — 이 공급자를 쓰는 arm을 중단합니다. ` +
              `나머지 arm은 계속 실행합니다.`
          );
        }
      } else if (anySucceeded) {
        consecutiveAuthFailures.set(providerId, 0);
      }
    }

    if (spec.draftSource === "generate" && record.draftProposal !== undefined) {
      drafts.set(draftKey(fixtureId, repetition, arm), record.draftProposal);
    }
  }

  const cumulativeSpentUsd = historicalSpentUsd + sessionSpentUsd;
  const availableUsd = options.ledger ? options.ledger.availableUsd() : remaining(cumulativeSpentUsd);
  return {
    planned: plan.length,
    executed,
    skippedResume,
    budgetExhausted,
    historicalSpentUsd,
    sessionSpentUsd,
    cumulativeSpentUsd,
    ...(availableUsd !== undefined ? { availableUsd } : {}),
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

const DISPATCH_STATES: ReadonlySet<string> = new Set([
  "not_dispatched",
  "dispatched_no_response",
  "response_received_with_usage",
  "response_received_without_usage",
]);

function isDispatchState(value: unknown): value is DispatchState {
  return typeof value === "string" && DISPATCH_STATES.has(value);
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
    ...(options.receiptId ? { receiptId: options.receiptId } : {}),
    ...(options.receiptHash ? { receiptHash: options.receiptHash } : {}),
    providerCalls: [],
    // 이벤트를 읽기 전에는 **읽을 수 없었다**가 기본값이다. 낙관적 기본값을 두면 예외 경로에서
    // "호출 0회"로 읽혀 예약이 해제된다.
    eventsReadable: false,
  };
  if (spec.reviewMode) base.reviewMode = spec.reviewMode;

  try {
    const hostResult = runHost({
      workspaceRoot: workspace.root,
      taskPrompt: manifest.taskPrompt,
      providers: spec.providers,
      ...(spec.reviewMode ? { reviewMode: spec.reviewMode } : {}),
      taskId,
      timeoutMs: manifest.timeoutMs,
      ...(options.replayDraft !== undefined ? { replayDraft: options.replayDraft } : {}),
      ...(options.fakeScript !== undefined ? { fakeScript: options.fakeScript } : {}),
      ...(options.hostBin !== undefined ? { hostBin: options.hostBin } : {}),
      ...(options.providerTimeoutMs !== undefined ? { providerTimeoutMs: options.providerTimeoutMs } : {}),
      ...(options.executorModel ? { executorModel: options.executorModel } : {}),
      ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    });

    base.latencyMs = hostResult.wallClockMs;
    base.taskId = hostResult.taskId;

    // **이벤트를 먼저 읽는다** (§2.7).
    //
    // 예전에는 `classifyInfrastructureFailure`가 먼저였고, 실패면 DB를 읽지 않고 반환했다.
    // 그러면 executor가 성공해 과금된 뒤 reviewer가 5xx로 죽은 실행에서 usage를 통째로
    // 잃는다 — 그리고 usage가 없으니 `not_dispatched`로 판정돼 예약까지 해제됐다.
    // host가 실패했든 아니든 DB가 만들어졌으면 남은 사실을 최대한 회수한다.
    const read = readEventsSafely(hostResult.dbPath, workspace.root, hostResult.taskId);
    base.eventsReadable = read.ok;
    if (read.ok) applyEventDerivedFields(base, read.events);

    const infraFailure = classifyInfrastructureFailure(hostResult, {
      eventsReadable: base.eventsReadable,
      providerCalls: base.providerCalls,
    });
    if (infraFailure) {
      base.failureClass = infraFailure;
      if (!read.ok) {
        base.policyDenials = [...base.policyDenials, `이벤트를 읽지 못했습니다: ${read.reason}`];
      }
      base.completedAt = new Date().toISOString();
      return base;
    }
    if (!read.ok) {
      // 이벤트를 못 읽었다는 것 자체가 **과금 불확실 상태**다. 성공으로 넘기지 않는다.
      base.failureClass = "oracle_harness_failure";
      base.policyDenials = [...base.policyDenials, `이벤트를 읽지 못했습니다: ${read.reason}`];
      base.completedAt = new Date().toISOString();
      return base;
    }

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

/**
 * 이벤트를 읽되 **실패를 빈 목록으로 감추지 않는다** (§2.7).
 *
 * `readEvents`는 파싱 실패에서 `[]`를 준다. "이벤트가 없다"와 "이벤트를 못 읽었다"는 전혀 다른
 * 사실인데 같은 값이 되므로, 여기서 갈라 놓는다 — 못 읽은 것은 호출이 나갔는지 모른다는 뜻이고,
 * 그건 예약을 해제할 수 없는 상태다.
 */
function readEventsSafely(
  dbPath: string,
  workspaceRoot: string,
  taskId: string
): { ok: true; events: ReturnType<typeof readEvents> } | { ok: false; reason: string } {
  if (!existsSync(dbPath)) {
    return { ok: false, reason: `상태 DB가 만들어지지 않았습니다: ${dbPath}` };
  }
  try {
    return { ok: true, events: readEvents(dbPath, workspaceRoot, taskId) };
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 200) };
  }
}

/**
 * 프로세스를 띄우지 못했거나 공급자 인증/한도 문제인가.
 *
 * # stderr 문자열이 구조화된 증거를 뒤집지 않는다
 *
 * 이 함수의 뒤쪽 절반은 호스트 stderr에 정규식을 건다. 그런데 stderr에는 `--verbose` 로그와
 * **검증 명령의 출력 전체**(cargo·node --test)가 섞여 있고, 거기엔 소요 시간·토큰 수·해시처럼
 * 숫자가 끝없이 나온다. `/\b5\d\d\b/`는 5로 시작하는 세 자리 숫자면 무엇이든 잡고,
 * `429`는 단어 경계도 없어 더 긴 토큰 안에서도 잡혔다.
 *
 * 실측(P0 smoke, 2026-08-27): provider 호출이 **전부 `succeeded`이고 `retryCount=0`인** 기록 둘이
 * `provider_5xx`로 분류됐다. 인프라 실패율이 75%로 찍혀 사전 등록 기준 9번(5% 미만)이
 * 허위로 깨졌다.
 *
 * 그리고 이건 집계만 틀리는 문제가 아니다. 호출부가 이 값을 받으면 **곧바로 반환**해
 * 공개 검증도 oracle 검증도 돌지 않는다 — 실제로 측정할 수 있었던 결과가 버려진다.
 *
 * 그래서 규칙을 하나 세운다: **이벤트를 읽을 수 있었고, 기록된 provider 호출이 있고, 그것들이
 * 전부 성공했다면 stderr 문자열로 공급자 실패를 만들어내지 않는다.** 진짜 5xx는 실패한 호출
 * 이벤트를 남기므로 이 규칙이 그것을 가리지 않는다. 가리는 것은 "성공했다고 기록된 실행"뿐이다.
 *
 * `spawnError`와 `provider_config_error`는 구조화된 사실이므로 이 규칙 앞에 둔다.
 */
export function classifyInfrastructureFailure(
  result: HostRunResult,
  evidence: { eventsReadable: boolean; providerCalls: readonly { status: string }[] }
): FailureClass | undefined {
  if (result.spawnError) return "host_crash";
  if (result.failureReason === "provider_config_error") return "auth_failure";

  const allCallsSucceeded =
    evidence.eventsReadable &&
    evidence.providerCalls.length > 0 &&
    evidence.providerCalls.every((call) => call.status === "succeeded");
  if (allCallsSucceeded) return undefined;

  const stderr = result.stderr;
  if (/rate.?limit|\b429\b/i.test(stderr)) return "rate_limit";
  if (/\b5\d\d\b|internal server error|overloaded/i.test(stderr)) return "provider_5xx";
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(stderr)) return "network_timeout";
  return undefined;
}

/**
 * DB 이벤트에서 **호출별 사실**과 usage/verdict/초안을 뽑아 기록을 채운다 (§2.6).
 *
 * # 세 이벤트를 어떻게 합치는가
 *
 * - `PROVIDER_CALL_STARTED`: adapter 호출 **직전**. 여기까지만 있고 terminal이 없으면
 *   요청이 나갔는지도 응답이 왔는지도 모른다 → `dispatched_no_response`.
 * - `PROVIDER_USAGE`: usage를 받은 성공 → `response_received_with_usage`.
 * - `PROVIDER_CALL_FAILED`: 실패. 어댑터가 아는 dispatch 사실을 그대로 싣는다.
 *
 * 키는 `callId + attempt`다. 재시도한 attempt마다 사실이 따로 남아야 "몇 번 나갔고 그중
 * 무엇이 과금됐는가"를 말할 수 있다.
 */
function applyEventDerivedFields(record: RecordWithDraft, events: ReturnType<typeof readEvents>): void {
  const calls = new Map<string, ProviderCallFact>();
  const key = (callId: unknown, attempt: unknown): string => `${String(callId)}#${String(attempt ?? 0)}`;

  for (const payload of allPayloads(events, "PROVIDER_CALL_STARTED")) {
    const p = payload as {
      callId?: string; role?: string; attempt?: number; providerId?: string;
      requestedModelId?: string; startedAt?: string;
    };
    calls.set(key(p.callId, p.attempt), {
      callId: p.callId ?? "(unknown)",
      role: p.role === "executor" || p.role === "reviewer" ? p.role : "unknown",
      attempt: p.attempt ?? 0,
      providerId: p.providerId ?? "(unknown)",
      requestedModelId: p.requestedModelId ?? "(unknown)",
      // **개시만 있고 종결이 없으면 불확실이다.** 아래 두 루프가 이 값을 덮어쓴다.
      dispatchState: "dispatched_no_response",
      status: "unknown",
      startedAt: p.startedAt ?? record.startedAt,
    });
  }

  for (const usage of allPayloads(events, "PROVIDER_USAGE")) {
    const u = usage as {
      callId?: string; role?: string; attempt?: number; providerId?: string;
      requestedModelId?: string; resolvedModelId?: string; providerRequestId?: string;
      usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number; createdAt?: string;
    };
    record.inputTokens += u.usage?.inputTokens ?? 0;
    record.outputTokens += u.usage?.outputTokens ?? 0;
    record.costUsd = (record.costUsd ?? 0) + (u.costUsd ?? 0);
    record.providerCallCount += 1;

    const id = key(u.callId, u.attempt);
    const existing = calls.get(id);
    const fact: ProviderCallFact = {
      callId: u.callId ?? existing?.callId ?? "(unknown)",
      role: u.role === "executor" || u.role === "reviewer" ? u.role : (existing?.role ?? "unknown"),
      attempt: u.attempt ?? existing?.attempt ?? 0,
      providerId: u.providerId ?? existing?.providerId ?? "(unknown)",
      requestedModelId: u.requestedModelId ?? existing?.requestedModelId ?? "(unknown)",
      // **응답 envelope의 모델 ID다.** 없으면 적지 않는다 — 요청 ID로 채우면 exact-model
      // 검증이 자기 자신과 비교하게 되어 조용한 대체를 절대 잡지 못한다(§2.8).
      ...(typeof u.resolvedModelId === "string" ? { providerReportedModelId: u.resolvedModelId } : {}),
      ...(typeof u.providerRequestId === "string" ? { providerRequestId: u.providerRequestId } : {}),
      dispatchState: "response_received_with_usage",
      ...(u.usage?.inputTokens !== undefined ? { inputTokens: u.usage.inputTokens } : {}),
      ...(u.usage?.outputTokens !== undefined ? { outputTokens: u.usage.outputTokens } : {}),
      ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
      status: "succeeded",
      startedAt: existing?.startedAt ?? u.createdAt ?? record.startedAt,
      ...(u.createdAt ? { completedAt: u.createdAt } : {}),
    };
    calls.set(id, fact);
  }

  for (const failure of allPayloads(events, "PROVIDER_CALL_FAILED")) {
    const f = failure as {
      callId?: string; role?: string; attempt?: number; providerId?: string;
      requestedModelId?: string; providerReportedModelId?: string; providerRequestId?: string;
      dispatchState?: string; errorKind?: string;
      usage?: { inputTokens?: number; outputTokens?: number }; at?: string;
    };
    const id = key(f.callId, f.attempt);
    const existing = calls.get(id);
    calls.set(id, {
      callId: f.callId ?? existing?.callId ?? "(unknown)",
      role: f.role === "executor" || f.role === "reviewer" ? f.role : (existing?.role ?? "unknown"),
      attempt: f.attempt ?? existing?.attempt ?? 0,
      providerId: f.providerId ?? existing?.providerId ?? "(unknown)",
      requestedModelId: f.requestedModelId ?? existing?.requestedModelId ?? "(unknown)",
      ...(typeof f.providerReportedModelId === "string"
        ? { providerReportedModelId: f.providerReportedModelId }
        : {}),
      ...(typeof f.providerRequestId === "string" ? { providerRequestId: f.providerRequestId } : {}),
      // 어댑터가 dispatch 사실을 실어 보냈으면 그것을 쓴다. 없으면 **불확실**이 기본이다 —
      // HTTP 분류만으로 "안 나갔다"를 추론하지 않는다(§2.6).
      dispatchState: isDispatchState(f.dispatchState) ? f.dispatchState : "dispatched_no_response",
      ...(f.usage?.inputTokens !== undefined ? { inputTokens: f.usage.inputTokens } : {}),
      ...(f.usage?.outputTokens !== undefined ? { outputTokens: f.usage.outputTokens } : {}),
      ...(f.errorKind ? { errorKind: f.errorKind } : {}),
      status: "failed",
      startedAt: existing?.startedAt ?? f.at ?? record.startedAt,
      ...(f.at ? { completedAt: f.at } : {}),
    });
  }

  record.providerCalls = [...calls.values()].sort((a, b) =>
    a.startedAt === b.startedAt ? a.attempt - b.attempt : a.startedAt < b.startedAt ? -1 : 1
  );
  record.retryCount = allPayloads(events, "PROVIDER_RETRY").length;

  const routing = lastPayload(events, "ROUTING_DECIDED") as
    | { assignments?: { role: string; modelId: string; providerId: string }[] }
    | undefined;
  const executor = routing?.assignments?.find((a) => a.role === "executor");
  if (executor) {
    record.requestedModelId = executor.modelId;
    record.providerId = routing!.assignments!.map((a) => `${a.role}=${a.providerId}`).join(",");
  }

  /**
   * **`DRAFT_RECEIVED`는 이름 하나에 모양이 넷이다.** 진짜 초안 말고도
   * `kind: "question_answer"`, `kind: "plan_outline"`, 그리고 단일모델 fix 결과가 같은 이름으로
   * 나온다(orchestrator.ts 926·1070·2407·2499). 셋 다 `proposalId`도 `patch`도 없다.
   *
   * 그래서 `lastPayload`로 마지막 것을 집으면 **뒤에 온 다른 모양이 초안을 지운다.**
   * 실측(P0 smoke, 2026-08-27): Arm A가 executor 호출 4회를 전부 성공시켰는데 마지막
   * `DRAFT_RECEIVED`가 재질문 응답이라 `draftProposal`이 비었고, 그 초안을 재생해야 하는
   * **Arm C/D가 8건 중 4건 통째로 건너뛰어졌다** — 교차검증 arm, 즉 이 게이트가 재려는
   * 대상 전체다. 모호한 요구 카테고리(`ambiguous_requirement`)에서 모델이 되묻는 것은
   * 정상 동작이므로, 세트가 어려울수록 더 자주 일어난다.
   *
   * 없는 것으로 거르지 않고 **있는 것으로 고른다.** `draftSource`는 진짜 초안에만 실리므로
   * 그것을 표지로 쓴다 — "kind가 없으면 초안"으로 두면 다섯 번째 모양이 생겼을 때 조용히
   * 다시 깨진다.
   */
  const draft = lastDraftProposalPayload(events);
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
    ...(options.receiptId ? { receiptId: options.receiptId } : {}),
    ...(options.receiptHash ? { receiptHash: options.receiptHash } : {}),
    // 이 기록은 host를 띄우지도 않았다. 호출이 없고 이벤트를 읽을 것도 없다는 것이 **사실**이므로
    // `eventsReadable: true`가 맞다 — 그래야 `not_dispatched`로 판정돼 예약이 정상 해제된다.
    providerCalls: [],
    eventsReadable: true,
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
