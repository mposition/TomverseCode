import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createBudgetLedger,
  effectiveMaxOutputTokens,
  maxCallCostUsd,
  type BudgetEvent,
  type BudgetLedger,
} from "@tomverse/sidecar/budget";
import type { ModelEntry, TokenUsage } from "@tomverse/protocol";
import { withLiveProbe, type ModelReadiness } from "./models.js";
import { findSecretLike } from "./records.js";

/**
 * `gate:g:probe-models` — **모델을 실제로 한 번 불러 확인한다** (§3).
 *
 * # 왜 별도 명령인가
 *
 * "이 모델을 쓸 수 있는가"는 카탈로그가 아는 사실이 아니다. gpt-5는 레지스트리에 있는데
 * 미인증 계정에서 `model_not_found`로 실패한다 — 가용성은 **자격증명별 사실**이다. 그리고
 * 그 사실을 확인하는 유일한 방법은 실제로 부르는 것이다.
 *
 * 그렇다고 pilot 안에서 확인하면 안 된다. pilot은 24 fixture × 4 arm을 돌리므로, 모델이
 * 아예 안 되는 경우를 알아내는 데 전체 규모의 비용이 든다. 그래서 **가장 작은 요청 1회**만
 * 하는 명령을 따로 둔다.
 *
 * # 이 명령이 지키는 것
 *
 * - 비용 상한이 **필수**다. 우회 옵션 없음.
 * - 역할당 **정확히 한 번**만 요청한다. 재시도도 fallback도 없다 — "다른 모델로 바꿔서라도
 *   성공"은 이 명령이 대답하려는 질문("이 모델이 되는가")을 지운다.
 * - 요청 **전에** 예약한다. 예약할 수 없으면 부르지 않는다.
 * - 비용을 잴 수 없으면 중단한다. 0으로 대체하지 않는다.
 * - 결과를 게이트 기록(`records.jsonl`)과 **다른 파일**에 쓴다. probe는 실험 표본이 아니다.
 * - 자격증명은 결과에 남지 않는다. 쓰기 전에 확인하고, 발견되면 쓰지 않는다.
 *
 * # 왜 production 어댑터를 쓰는가
 *
 * probe용 HTTP 호출을 따로 만들면 "probe는 통과했는데 실제 실행은 실패"가 가능해진다.
 * 확인하려는 것은 **우리 코드 경로가 이 모델과 동작하는가**이므로, 구조화 출력 강제와
 * 응답 정규화를 포함한 production 어댑터를 그대로 태운다. 구조화 출력이 실제로 되는지는
 * 별도 검사가 아니라 **어댑터가 값을 파싱해내는 데 성공했는가**로 확인된다.
 */

export const PROBE_RECORDS_FILE = "model-probes.jsonl";
export const PROBE_SUMMARY_FILE = "model-probe.json";
export const PROBE_BUDGET_EVENTS_FILE = "probe-budget-events.jsonl";

export type ProbeRole = "executor" | "reviewer";

/** 어댑터를 한 번 호출한 결과. 여기에 자격증명이나 응답 원문은 들어오지 않는다. */
export interface RoleProbeOutcome {
  /** 응답이 실어 온 모델 ID. 요청과 다르면 조용한 대체다. */
  returnedModelId: string;
  usage: TokenUsage;
  latencyMs: number;
  /**
   * 구조화 출력이 실제로 성립했는가. **어댑터가 스키마를 만족하는 값을 만들어냈다는 뜻**이며,
   * 실패는 예외로 나타나므로 여기서 false가 되는 경우는 값은 왔지만 필수 필드가 빈 경우다.
   */
  structuredOutputOk: boolean;
  /** 사람이 읽는 근거 한 줄 (예: "verdict=APPROVE, plan 2단계"). 응답 원문이 아니다. */
  evidence: string;
}

export interface ProbeTransport {
  /** 역할당 최소 요청 **1회**. 재시도하지 않는다. */
  probe(role: ProbeRole, entry: ModelEntry): Promise<RoleProbeOutcome>;
}

/** 이 모델의 단가로 실제 사용량의 비용을 계산한다. 계산 불가면 undefined다. */
export type CostOfUsage = (modelId: string, usage: TokenUsage) => number | undefined;

export interface ProbeRecord {
  role: ProbeRole;
  requestedModelId: string;
  providerId: string;
  /** 성공했을 때만 채워진다. */
  returnedModelId?: string;
  exactModelIdVerified: boolean;
  structuredOutputOk: boolean;
  liveProbe: "verified" | "failed";
  inputTokens?: number;
  outputTokens?: number;
  /** 요청 전에 예약한 금액. */
  estimatedMaxUsd: number;
  /** 실제 사용량으로 계산한 비용. 잴 수 없으면 undefined이며, 그 경우 실행이 중단된다. */
  actualUsd?: number;
  latencyMs?: number;
  failureReason?: string;
  evidence?: string;
  at: string;
}

export type ProbeStatus = "READY_FOR_PAID_RUN" | "BLOCKED";

export interface ProbeSummary {
  status: ProbeStatus;
  /** 실제로 보낸 요청 수. 역할당 1회이므로 최대 2다. */
  requestsSent: number;
  approvedLimitUsd: number;
  estimatedMaxUsd: number;
  /** 확정된 실제 비용. 잴 수 없었던 요청이 있으면 그 사실이 blockers에 남는다. */
  actualUsd: number;
  records: ProbeRecord[];
  readiness: ModelReadiness[];
  blockers: string[];
  nextAction: string;
  at: string;
}

export interface ProbeModelsInput {
  /** 역할별 모델과 오프라인 준비성. 오프라인 준비성 위에 실제 확인 결과를 얹는다. */
  roles: { role: ProbeRole; entry: ModelEntry; readiness: ModelReadiness }[];
  /** 사용자 승인 상한. **없으면 아무 요청도 보내지 않는다.** */
  maxCostUsd?: number;
  /** 이 명령은 순차 실행만 한다 — 1이 아니면 시작하지 않는다. */
  maxConcurrency: number;
  transport: ProbeTransport;
  costOfUsage: CostOfUsage;
  /** probe가 실제로 넣는 입력 토큰 상한 — 예약 금액의 근거다. */
  probeInputTokens?: number;
  now?: () => string;
  onEvent?: (event: BudgetEvent) => void;
  onProgress?: (message: string) => void;
}

/**
 * probe 요청에 넣는 입력 토큰 상한.
 *
 * 실험 본체의 컨텍스트 예산(6만)을 쓰지 않는다 — probe는 "부를 수 있는가"만 확인하므로
 * 파일을 실을 필요가 없다. 작게 잡는 만큼 예약 금액도 작아진다. 다만 0으로 두지는 않는다:
 * 프롬프트 자체(시스템 프롬프트 + 스키마 지시)가 토큰을 쓰고, 예약은 넘치는 쪽으로 틀려야 한다.
 */
export const PROBE_INPUT_TOKENS = 4_000;

export async function probeModels(input: ProbeModelsInput): Promise<ProbeSummary> {
  const now = input.now ?? ((): string => new Date().toISOString());
  const log = input.onProgress ?? ((): void => undefined);
  const blockers: string[] = [];
  const records: ProbeRecord[] = [];
  const readiness: ModelReadiness[] = [];

  // ---- 요청을 보내기 전에 끝나야 하는 검사들 ----
  if (input.maxConcurrency !== 1) {
    blockers.push(`--max-concurrency는 1만 허용합니다 (받은 값: ${input.maxConcurrency})`);
  }
  if (input.maxCostUsd === undefined) {
    blockers.push(
      "probe-models는 실제 공급자를 호출하므로 --max-cost-usd가 필수입니다 (우회 옵션 없음)"
    );
  }
  if (blockers.length > 0) {
    return {
      status: "BLOCKED",
      requestsSent: 0,
      approvedLimitUsd: input.maxCostUsd ?? 0,
      estimatedMaxUsd: 0,
      actualUsd: 0,
      records,
      readiness: input.roles.map((r) => r.readiness),
      blockers,
      nextAction: "blocker를 해결한 뒤 다시 실행하세요. 아직 요청을 보내지 않았습니다.",
      at: now(),
    };
  }

  const ledger: BudgetLedger = createBudgetLedger(input.maxCostUsd!, {
    runId: "probe-models",
    stage: "model_probe",
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    now,
  });

  const inputTokens = input.probeInputTokens ?? PROBE_INPUT_TOKENS;
  let requestsSent = 0;
  let estimatedTotal = 0;
  let actualTotal = 0;
  let aborted = false;

  // **순차 루프.** 동시 실행을 붙이지 않는 이유는 지연 비교가 아니라 단순함이다 —
  // 요청이 두 개뿐이므로 병렬로 얻을 것이 없고, 예약/정산 순서가 눈에 보이는 편이 낫다.
  for (const role of input.roles) {
    if (aborted) {
      // 앞의 역할에서 중단됐으면 뒤는 부르지 않는다. 확인하지 않은 사실은 확인하지 않은 대로 남긴다.
      readiness.push(role.readiness);
      blockers.push(`${role.role}(${role.entry.modelId}): 앞선 중단으로 확인하지 않았습니다`);
      continue;
    }

    const estimate = maxCallCostUsd(role.entry, {
      maxInputTokens: inputTokens,
      maxOutputTokens: effectiveMaxOutputTokens(role.entry),
    });
    if (estimate === undefined) {
      // 비용을 계산할 수 없으면 예약할 금액을 모른다 → 부르지 않는다.
      const reason = `${role.entry.modelId}: 가격 정보가 없어 예상 비용을 계산할 수 없습니다 — 요청을 보내지 않았습니다`;
      blockers.push(reason);
      readiness.push(role.readiness);
      ledger.recordBlocked(reason);
      aborted = true;
      continue;
    }

    const reservation = ledger.reserve(
      {
        maxUsd: estimate,
        basis: `probe 1회: 입력 ${inputTokens.toLocaleString()}토큰 + 출력 ${effectiveMaxOutputTokens(
          role.entry
        ).toLocaleString()}토큰`,
      },
      `probe/${role.role}/${role.entry.modelId}`
    );
    if (!reservation.ok) {
      blockers.push(`${role.role}(${role.entry.modelId}): ${reservation.reason}`);
      readiness.push(role.readiness);
      aborted = true;
      continue;
    }
    estimatedTotal += estimate;

    log(`${role.role}: ${role.entry.modelId}에 최소 요청 1회 (예약 $${estimate.toFixed(4)})`);
    let outcome: RoleProbeOutcome;
    try {
      requestsSent += 1;
      outcome = await input.transport.probe(role.role, role.entry);
    } catch (error) {
      // 요청이 실패했으면 과금되지 않았다고 보고 예약을 해제한다. 그리고 **다른 모델로
      // 바꾸지 않는다** — 이 명령의 질문은 "이 모델이 되는가"다.
      reservation.reservation.release();
      const reason = describeError(error);
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        exactModelIdVerified: false,
        structuredOutputOk: false,
        liveProbe: "failed",
        estimatedMaxUsd: estimate,
        failureReason: reason,
        at: now(),
      });
      readiness.push(
        withLiveProbe(role.readiness, { outcome: "failed", checkedAt: now(), note: `실제 호출 실패: ${reason}` })
      );
      blockers.push(`${role.role}(${role.entry.modelId}) 실제 호출 실패: ${reason}`);
      aborted = true;
      continue;
    }

    const actual = input.costOfUsage(role.entry.modelId, outcome.usage);
    const usageMissing = outcome.usage.inputTokens === 0 && outcome.usage.outputTokens === 0;
    if (actual === undefined || usageMissing) {
      // **0으로 대체하지 않는다.** 비용을 못 재면 상한을 강제할 수 없고, 그 상태로 다음
      // 요청을 보내는 것은 상한이 없는 것과 같다.
      reservation.reservation.release();
      const reason =
        actual === undefined
          ? `${role.entry.modelId}: 실제 비용을 계산할 수 없습니다 (가격 정보 없음)`
          : `${role.entry.modelId}: 응답에 usage가 없어 비용을 확정할 수 없습니다`;
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        returnedModelId: outcome.returnedModelId,
        exactModelIdVerified: outcome.returnedModelId === role.entry.modelId,
        structuredOutputOk: outcome.structuredOutputOk,
        liveProbe: "failed",
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        estimatedMaxUsd: estimate,
        latencyMs: outcome.latencyMs,
        failureReason: reason,
        at: now(),
      });
      readiness.push(withLiveProbe(role.readiness, { outcome: "failed", checkedAt: now(), note: reason }));
      blockers.push(reason);
      ledger.recordBlocked(reason);
      aborted = true;
      continue;
    }

    reservation.reservation.settle(actual);
    actualTotal += actual;

    const exact = outcome.returnedModelId === role.entry.modelId;
    const verified = exact && outcome.structuredOutputOk;
    records.push({
      role: role.role,
      requestedModelId: role.entry.modelId,
      providerId: role.entry.providerId,
      returnedModelId: outcome.returnedModelId,
      exactModelIdVerified: exact,
      structuredOutputOk: outcome.structuredOutputOk,
      liveProbe: verified ? "verified" : "failed",
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      estimatedMaxUsd: estimate,
      actualUsd: actual,
      latencyMs: outcome.latencyMs,
      evidence: outcome.evidence,
      ...(verified ? {} : { failureReason: describeMismatch(role.entry.modelId, outcome) }),
      at: now(),
    });
    readiness.push(
      withLiveProbe(role.readiness, {
        outcome: verified ? "verified" : "failed",
        returnedModelId: outcome.returnedModelId,
        checkedAt: now(),
        note: `실제 요청 1회 성공 (${outcome.evidence}), 실제 비용 $${actual.toFixed(6)}`,
      })
    );
    if (!verified) {
      blockers.push(describeMismatch(role.entry.modelId, outcome));
      aborted = true;
    }
  }

  const allVerified =
    readiness.length === input.roles.length &&
    readiness.every((r) => r.liveProbeVerified && r.exactModelIdVerified);
  const status: ProbeStatus = blockers.length === 0 && allVerified ? "READY_FOR_PAID_RUN" : "BLOCKED";

  return {
    status,
    requestsSent,
    approvedLimitUsd: input.maxCostUsd!,
    estimatedMaxUsd: estimatedTotal,
    actualUsd: actualTotal,
    records,
    readiness,
    blockers,
    nextAction:
      status === "READY_FOR_PAID_RUN"
        ? "P0 카드를 다시 만들어 승인하세요 — 이제 실제 확인이 포함됩니다."
        : "blocker를 해결하세요. 모델을 조용히 바꾸지 않았으므로 무엇이 안 되는지 그대로 남아 있습니다.",
    at: now(),
  };
}

function describeMismatch(requestedModelId: string, outcome: RoleProbeOutcome): string {
  if (outcome.returnedModelId !== requestedModelId) {
    return (
      `요청한 모델 ${requestedModelId}와 응답 모델 ${outcome.returnedModelId}가 다릅니다 — ` +
      `조용한 대체를 허용하지 않습니다`
    );
  }
  return `${requestedModelId}: 구조화 출력이 요구 형태를 만족하지 않았습니다`;
}

/**
 * 오류 메시지를 남긴다. **원문을 그대로 싣지 않는다** — 공급자 오류 본문에 요청 헤더가
 * 되돌아오는 경우가 있고, 그러면 결과 파일이 유출 경로가 된다.
 */
function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message.slice(0, 200)}`;
}

// ---------------------------------------------------------------------------
// 결과 저장 — **게이트 기록과 다른 파일에.**
// ---------------------------------------------------------------------------

export function probePaths(probeDir: string): { records: string; summary: string; budgetEvents: string } {
  return {
    records: path.join(probeDir, PROBE_RECORDS_FILE),
    summary: path.join(probeDir, PROBE_SUMMARY_FILE),
    budgetEvents: path.join(probeDir, PROBE_BUDGET_EVENTS_FILE),
  };
}

/**
 * probe 결과를 쓴다.
 *
 * `records.jsonl`에 쓰지 않는 이유: probe는 실험 표본이 아니다. 섞이면 집계가 조용히
 * 틀리고(오라클 검증이 없는 기록이 성공률 분모에 들어간다), 그 틀림은 리포트를 봐서는
 * 드러나지 않는다.
 */
export function writeProbeResults(probeDir: string, summary: ProbeSummary): { records: string; summary: string } {
  const leaked = findSecretLike(summary);
  if (leaked) {
    throw new Error(`probe 결과에 비밀값처럼 보이는 값이 있습니다 (${leaked}) — 저장하지 않았습니다`);
  }
  mkdirSync(probeDir, { recursive: true });
  const paths = probePaths(probeDir);
  for (const record of summary.records) {
    appendFileSync(paths.records, `${JSON.stringify(record)}\n`);
  }
  writeFileSync(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  return { records: paths.records, summary: paths.summary };
}

export function renderProbeSummary(summary: ProbeSummary): string[] {
  const lines: string[] = [];
  lines.push("=== Model Probe ===");
  lines.push(`상태: ${summary.status}`);
  lines.push(`다음 행동: ${summary.nextAction}`);
  lines.push(`보낸 요청 수: ${summary.requestsSent}회 (역할당 1회, 재시도·fallback 없음)`);
  lines.push(`승인 상한: $${summary.approvedLimitUsd}`);
  lines.push(`예약 합계(보수적 최대): $${summary.estimatedMaxUsd.toFixed(6)}`);
  lines.push(`실제 비용 합계: $${summary.actualUsd.toFixed(6)}`);
  lines.push("");
  for (const record of summary.records) {
    lines.push(`${record.role}: ${record.requestedModelId} (${record.providerId})`);
    lines.push(`  실제 호출: ${record.liveProbe}`);
    lines.push(`  응답 모델 ID: ${record.returnedModelId ?? "(없음)"} / 일치=${record.exactModelIdVerified}`);
    lines.push(`  구조화 출력: ${record.structuredOutputOk}${record.evidence ? ` (${record.evidence})` : ""}`);
    lines.push(
      `  usage: 입력 ${record.inputTokens ?? "?"} / 출력 ${record.outputTokens ?? "?"} → ` +
        `예약 $${record.estimatedMaxUsd.toFixed(6)} / 실제 ${
          record.actualUsd === undefined ? "(측정 불가)" : `$${record.actualUsd.toFixed(6)}`
        }`
    );
    if (record.failureReason) lines.push(`  실패 사유: ${record.failureReason}`);
    lines.push("");
  }
  if (summary.blockers.length > 0) {
    lines.push("BLOCKED:");
    for (const blocker of summary.blockers) lines.push(`  - ${blocker}`);
  }
  return lines;
}
