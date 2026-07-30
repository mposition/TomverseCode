import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createBudgetLedger,
  effectiveMaxOutputTokens,
  maxCallCostUsd,
  type BudgetEvent,
  type BudgetLedger,
  type DispatchState,
} from "@tomverse/sidecar/budget";
import { providerModelIdAccepted } from "@tomverse/sidecar/registry";
import { redactSecrets } from "@tomverse/sidecar/providers";
import type { ModelEntry, TokenUsage } from "@tomverse/protocol";
import { withLiveProbe, type ModelReadiness } from "./models.js";
import {
  buildProbeEvidence,
  computeCredentialBinding,
  type CredentialBinding,
  type ProbeEvidence,
  type RoleEvidence,
} from "./probeEvidence.js";
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
 * - **과금 여부가 불확실한 실패는 해제하지 않는다.** 공급자가 응답을 만들고 과금한 뒤 파싱에서
 *   실패했을 수 있으므로, 그때 예약을 해제하면 쓴 돈을 안 쓴 것으로 만드는 것이다.
 * - 결과를 게이트 기록(`records.jsonl`)과 **다른 파일**에 쓴다. probe는 실험 표본이 아니다.
 * - 오류 메시지는 만들 때 redaction을 지난다. 저장 직전 검사만으로는 stdout에 이미 나간 것을
 *   되돌릴 수 없다.
 *
 * # 왜 production 어댑터를 쓰는가
 *
 * probe용 HTTP 호출을 따로 만들면 "probe는 통과했는데 실제 실행은 실패"가 가능해진다.
 * 확인하려는 것은 **우리 코드 경로가 이 모델과 동작하는가**이므로, 구조화 출력 강제와
 * 응답 정규화를 포함한 production 어댑터를 그대로 태운다.
 */

export const PROBE_RECORDS_FILE = "model-probes.jsonl";
export const PROBE_SUMMARY_FILE = "model-probe.json";
export const PROBE_BUDGET_EVENTS_FILE = "probe-budget-events.jsonl";

export type ProbeRole = "executor" | "reviewer";

/** 어댑터를 한 번 호출한 결과. 여기에 자격증명이나 응답 원문은 들어오지 않는다. */
export interface RoleProbeOutcome {
  /**
   * **응답 envelope이 실어 온** 모델 ID. 없으면 `undefined`다.
   *
   * 예전에는 `DraftProposal.model`을 읽었는데 그 값은 어댑터가 `this.modelId`를 넣은 것이라
   * 항상 요청 ID와 같았다 — 즉 조용한 대체를 절대 잡지 못하는 검증이었다.
   */
  providerReportedModelId?: string;
  usage: TokenUsage;
  latencyMs: number;
  /** 구조화 출력이 실제로 성립했는가. */
  structuredOutputOk: boolean;
  /** 사람이 읽는 근거 한 줄. 응답 원문이 아니다. */
  evidence: string;
  dispatchState: DispatchState;
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
  /** 응답 envelope이 실어 온 모델 ID. 없으면 검증 실패다. */
  providerReportedModelId?: string;
  exactModelIdVerified: boolean;
  /** exact 일치 근거 — 정확히 같았는가, 허용 목록에 있었는가. */
  modelIdMatchedBy?: "exact" | "accepted_list";
  structuredOutputOk: boolean;
  liveProbe: "verified" | "failed";
  dispatchState: DispatchState;
  inputTokens?: number;
  outputTokens?: number;
  /** 요청 전에 예약한 금액. */
  estimatedMaxUsd: number;
  /** 실제 사용량으로 계산한 비용. 잴 수 없으면 undefined이며, 그 경우 실행이 중단된다. */
  actualUsd?: number;
  latencyMs?: number;
  failureReason?: string;
  evidence?: string;
  /** 예약이 어떻게 끝났는가 — 해제/정산/미해결. */
  reservationOutcome: "settled" | "released" | "unresolved" | "not_opened";
  at: string;
}

export type ProbeStatus =
  | "READY_FOR_PAID_RUN"
  | "BLOCKED"
  | "BLOCKED_UNRESOLVED_RESERVATION";

export interface ProbeSummary {
  status: ProbeStatus;
  /** 실제로 보낸 요청 수. 역할당 1회이므로 최대 2다. */
  requestsSent: number;
  approvedLimitUsd: number;
  estimatedMaxUsd: number;
  /** 확정된 실제 비용. 잴 수 없었던 요청이 있으면 그 사실이 blockers에 남는다. */
  actualUsd: number;
  /** 과금 여부가 불확실해 미해결로 남은 예약액. 0이 아니면 사람이 확인해야 한다. */
  unresolvedUsd: number;
  records: ProbeRecord[];
  readiness: ModelReadiness[];
  blockers: string[];
  nextAction: string;
  at: string;
  /** 모든 역할이 확인됐을 때만 만들어진다. 없으면 유료 실행을 승인할 수 없다. */
  evidence?: ProbeEvidence;
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
  /** evidence를 만들기 위한 결합 축. 없으면 evidence를 만들지 않는다. */
  evidenceBinding?: {
    protocolVersion: number;
    criteriaHash: string;
    registrySnapshotHash: string;
    adapterContractVersion: string;
    credentialBinding: CredentialBinding;
    ttlHours?: number;
  };
}

/**
 * probe 요청에 넣는 입력 토큰 상한.
 *
 * 실험 본체의 컨텍스트 예산(6만)을 쓰지 않는다 — probe는 "부를 수 있는가"만 확인하므로
 * 파일을 실을 필요가 없다. 작게 잡는 만큼 예약 금액도 작아진다. 다만 0으로 두지는 않는다:
 * 프롬프트 자체(시스템 프롬프트 + 스키마 지시)가 토큰을 쓰고, 예약은 넘치는 쪽으로 틀려야 한다.
 */
export const PROBE_INPUT_TOKENS = 4_000;

/** 오류에서 우리가 아는 사실을 뽑는다. `ProviderCallFailure`가 아니면 dispatch 상태를 모른다. */
interface FailureFacts {
  dispatchState: DispatchState;
  usage?: TokenUsage;
  providerReportedModelId?: string;
  latencyMs?: number;
  message: string;
}

function failureFacts(error: unknown): FailureFacts {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    dispatchState?: unknown;
    usage?: unknown;
    providerReportedModelId?: unknown;
    latencyMs?: unknown;
  };
  const name = typeof candidate?.name === "string" ? candidate.name : "UnknownError";
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  const dispatch =
    typeof candidate?.dispatchState === "string"
      ? (candidate.dispatchState as DispatchState)
      : // **모르면 불확실로 본다.** 평범한 Error는 요청이 나갔는지 알려주지 않으므로,
        // 안전한 쪽(과금됐을 수 있음)으로 기울인다.
        "dispatched_no_response";
  return {
    dispatchState: dispatch,
    ...(candidate?.usage !== undefined ? { usage: candidate.usage as TokenUsage } : {}),
    ...(typeof candidate?.providerReportedModelId === "string"
      ? { providerReportedModelId: candidate.providerReportedModelId }
      : {}),
    ...(typeof candidate?.latencyMs === "number" ? { latencyMs: candidate.latencyMs } : {}),
    // **만드는 지점에서 redaction한다.** 저장 직전 검사만으로는 stdout에 나간 것을 못 막는다.
    message: redactSecrets(`${name}: ${message.slice(0, 300)}`),
  };
}

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
    blockers.push("probe-models는 실제 공급자를 호출하므로 --max-cost-usd가 필수입니다 (우회 옵션 없음)");
  }
  if (blockers.length > 0) {
    return {
      status: "BLOCKED",
      requestsSent: 0,
      approvedLimitUsd: input.maxCostUsd ?? 0,
      estimatedMaxUsd: 0,
      actualUsd: 0,
      unresolvedUsd: 0,
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
  const roleEvidence = new Map<ProbeRole, RoleEvidence>();

  // **순차 루프.** 요청이 두 개뿐이므로 병렬로 얻을 것이 없고, 예약/정산 순서가 눈에 보이는
  // 편이 낫다. 그리고 앞의 역할에서 중단되면 뒤의 역할을 부르지 않아야 한다.
  for (const role of input.roles) {
    if (aborted) {
      readiness.push(role.readiness);
      blockers.push(`${role.role}(${role.entry.modelId}): 앞선 중단으로 확인하지 않았습니다`);
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        exactModelIdVerified: false,
        structuredOutputOk: false,
        liveProbe: "failed",
        dispatchState: "not_dispatched",
        estimatedMaxUsd: 0,
        failureReason: "앞선 중단으로 요청하지 않았습니다",
        reservationOutcome: "not_opened",
        at: now(),
      });
      continue;
    }

    const estimate = maxCallCostUsd(role.entry, {
      maxInputTokens: inputTokens,
      maxOutputTokens: effectiveMaxOutputTokens(role.entry),
    });
    if (estimate === undefined) {
      const reason = `${role.entry.modelId}: 가격 정보가 없어 예상 비용을 계산할 수 없습니다 — 요청을 보내지 않았습니다`;
      blockers.push(reason);
      readiness.push(role.readiness);
      ledger.recordBlocked(reason);
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        exactModelIdVerified: false,
        structuredOutputOk: false,
        liveProbe: "failed",
        dispatchState: "not_dispatched",
        estimatedMaxUsd: 0,
        failureReason: reason,
        reservationOutcome: "not_opened",
        at: now(),
      });
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
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        exactModelIdVerified: false,
        structuredOutputOk: false,
        liveProbe: "failed",
        dispatchState: "not_dispatched",
        estimatedMaxUsd: estimate,
        failureReason: reservation.reason,
        reservationOutcome: "not_opened",
        at: now(),
      });
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
      const facts = failureFacts(error);
      const cost =
        facts.usage !== undefined ? input.costOfUsage(role.entry.modelId, facts.usage) : undefined;

      if (facts.dispatchState === "not_dispatched") {
        // **요청이 나가지 않은 것이 확실한 경우만** 해제한다.
        reservation.reservation.release({
          dispatchState: "not_dispatched",
          reason: facts.message,
        });
      } else if (facts.dispatchState === "response_received_with_usage" && cost !== undefined && facts.usage) {
        // 응답은 받았고 usage도 있다 → 실제로 쓴 돈이므로 정산한다. 그래도 probe는 실패다.
        reservation.reservation.settle({
          cost: { measured: true, usd: cost },
          usage: { measured: true, inputTokens: facts.usage.inputTokens, outputTokens: facts.usage.outputTokens },
          providerKind: "real",
          requestedModelId: role.entry.modelId,
          ...(facts.providerReportedModelId ? { providerReportedModelId: facts.providerReportedModelId } : {}),
          dispatchState: facts.dispatchState,
        });
        actualTotal += cost;
      } else {
        // **불확실하면 해제하지 않는다.** 공급자가 응답을 만들고 과금한 뒤 파싱에서 실패했을 수 있다.
        reservation.reservation.markUnresolved({
          dispatchState: facts.dispatchState,
          reason: facts.message,
        });
      }

      const settledHere = facts.dispatchState === "response_received_with_usage" && cost !== undefined;
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        ...(facts.providerReportedModelId ? { providerReportedModelId: facts.providerReportedModelId } : {}),
        exactModelIdVerified: false,
        structuredOutputOk: false,
        liveProbe: "failed",
        dispatchState: facts.dispatchState,
        ...(facts.usage ? { inputTokens: facts.usage.inputTokens, outputTokens: facts.usage.outputTokens } : {}),
        estimatedMaxUsd: estimate,
        ...(settledHere ? { actualUsd: cost } : {}),
        ...(facts.latencyMs !== undefined ? { latencyMs: facts.latencyMs } : {}),
        failureReason: facts.message,
        reservationOutcome:
          facts.dispatchState === "not_dispatched" ? "released" : settledHere ? "settled" : "unresolved",
        at: now(),
      });
      readiness.push(
        withLiveProbe(role.readiness, {
          outcome: "failed",
          checkedAt: now(),
          note: `실제 호출 실패 (${facts.dispatchState}): ${facts.message}`,
        })
      );
      blockers.push(`${role.role}(${role.entry.modelId}) 실제 호출 실패: ${facts.message}`);
      aborted = true;
      continue;
    }

    const actual = input.costOfUsage(role.entry.modelId, outcome.usage);
    const usageMissing = outcome.usage.inputTokens === 0 && outcome.usage.outputTokens === 0;
    if (actual === undefined || usageMissing) {
      // **0으로 대체하지 않고, 해제하지도 않는다.** 응답을 받았으므로 과금됐을 수 있다.
      const reason =
        actual === undefined
          ? `${role.entry.modelId}: 실제 비용을 계산할 수 없습니다 (가격 정보 없음)`
          : `${role.entry.modelId}: 응답에 usage가 없어 비용을 확정할 수 없습니다`;
      reservation.reservation.markUnresolved({
        dispatchState: "response_received_without_usage",
        reason,
      });
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        ...(outcome.providerReportedModelId ? { providerReportedModelId: outcome.providerReportedModelId } : {}),
        exactModelIdVerified: false,
        structuredOutputOk: outcome.structuredOutputOk,
        liveProbe: "failed",
        dispatchState: "response_received_without_usage",
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        estimatedMaxUsd: estimate,
        latencyMs: outcome.latencyMs,
        failureReason: reason,
        reservationOutcome: "unresolved",
        at: now(),
      });
      readiness.push(withLiveProbe(role.readiness, { outcome: "failed", checkedAt: now(), note: reason }));
      blockers.push(reason);
      aborted = true;
      continue;
    }

    const settle = reservation.reservation.settle({
      cost: { measured: true, usd: actual },
      usage: { measured: true, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens },
      providerKind: "real",
      requestedModelId: role.entry.modelId,
      ...(outcome.providerReportedModelId ? { providerReportedModelId: outcome.providerReportedModelId } : {}),
      dispatchState: outcome.dispatchState,
    });
    if (!settle.ok) {
      // 수치 검증 실패 — 원장이 예약을 미해결로 남겼다.
      records.push({
        role: role.role,
        requestedModelId: role.entry.modelId,
        providerId: role.entry.providerId,
        ...(outcome.providerReportedModelId ? { providerReportedModelId: outcome.providerReportedModelId } : {}),
        exactModelIdVerified: false,
        structuredOutputOk: outcome.structuredOutputOk,
        liveProbe: "failed",
        dispatchState: outcome.dispatchState,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        estimatedMaxUsd: estimate,
        latencyMs: outcome.latencyMs,
        failureReason: `${settle.state}: ${settle.reason}`,
        reservationOutcome: "unresolved",
        at: now(),
      });
      readiness.push(
        withLiveProbe(role.readiness, { outcome: "failed", checkedAt: now(), note: `${settle.state}: ${settle.reason}` })
      );
      blockers.push(`${role.role}(${role.entry.modelId}): ${settle.reason}`);
      aborted = true;
      continue;
    }
    actualTotal += actual;

    // **exact-model 검증은 응답 envelope만 본다.** 허용 목록은 레지스트리가 명시한 것만 인정한다.
    const match = providerModelIdAccepted(role.entry, outcome.providerReportedModelId);
    const verified = match.ok && outcome.structuredOutputOk;
    records.push({
      role: role.role,
      requestedModelId: role.entry.modelId,
      providerId: role.entry.providerId,
      ...(outcome.providerReportedModelId ? { providerReportedModelId: outcome.providerReportedModelId } : {}),
      exactModelIdVerified: match.ok,
      ...(match.ok ? { modelIdMatchedBy: match.matchedBy } : {}),
      structuredOutputOk: outcome.structuredOutputOk,
      liveProbe: verified ? "verified" : "failed",
      dispatchState: outcome.dispatchState,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      estimatedMaxUsd: estimate,
      actualUsd: actual,
      latencyMs: outcome.latencyMs,
      evidence: outcome.evidence,
      ...(verified ? {} : { failureReason: match.ok ? "구조화 출력이 요구 형태를 만족하지 않았습니다" : match.reason }),
      reservationOutcome: "settled",
      at: now(),
    });
    readiness.push(
      withLiveProbe(role.readiness, {
        outcome: verified ? "verified" : "failed",
        ...(outcome.providerReportedModelId ? { returnedModelId: outcome.providerReportedModelId } : {}),
        acceptedByRegistry: match.ok,
        checkedAt: now(),
        note: `실제 요청 1회 성공 (${outcome.evidence}), 실제 비용 $${actual.toFixed(6)}`,
      })
    );
    if (!verified) {
      blockers.push(match.ok ? `${role.entry.modelId}: 구조화 출력이 요구 형태를 만족하지 않았습니다` : match.reason);
      aborted = true;
      continue;
    }
    roleEvidence.set(role.role, {
      providerId: role.entry.providerId,
      requestedModelId: role.entry.modelId,
      providerReportedModelId: outcome.providerReportedModelId!,
      exactModelIdVerified: true,
      structuredOutputVerified: true,
      usage: { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens },
      actualUsd: actual,
    });
  }

  const snapshot = ledger.snapshot();
  const allVerified =
    readiness.length === input.roles.length &&
    readiness.every((r) => r.liveProbeVerified && r.exactModelIdVerified) &&
    roleEvidence.size === input.roles.length;

  const status: ProbeStatus =
    snapshot.unresolvedUsd > 0
      ? "BLOCKED_UNRESOLVED_RESERVATION"
      : blockers.length === 0 && allVerified
        ? "READY_FOR_PAID_RUN"
        : "BLOCKED";

  const executor = roleEvidence.get("executor");
  const reviewer = roleEvidence.get("reviewer");
  const evidence =
    status === "READY_FOR_PAID_RUN" && input.evidenceBinding && executor && reviewer
      ? buildProbeEvidence({
          createdAt: now(),
          protocolVersion: input.evidenceBinding.protocolVersion,
          criteriaHash: input.evidenceBinding.criteriaHash,
          registrySnapshotHash: input.evidenceBinding.registrySnapshotHash,
          adapterContractVersion: input.evidenceBinding.adapterContractVersion,
          executor,
          reviewer,
          approvedProbeLimitUsd: input.maxCostUsd!,
          cumulativeProbeCostUsd: actualTotal,
          credentialBinding: input.evidenceBinding.credentialBinding,
          ...(input.evidenceBinding.ttlHours !== undefined ? { ttlHours: input.evidenceBinding.ttlHours } : {}),
        })
      : undefined;

  if (snapshot.unresolvedUsd > 0) {
    blockers.push(
      `과금 여부가 불확실한 예약 $${snapshot.unresolvedUsd.toFixed(6)}가 남았습니다 — ` +
        `자동으로 정리하지 않습니다. gate:g:budget-status로 확인하세요.`
    );
  }

  return {
    status,
    requestsSent,
    approvedLimitUsd: input.maxCostUsd!,
    estimatedMaxUsd: estimatedTotal,
    actualUsd: actualTotal,
    unresolvedUsd: snapshot.unresolvedUsd,
    records,
    readiness,
    blockers,
    nextAction:
      status === "READY_FOR_PAID_RUN"
        ? "plan-pilot을 다시 실행하세요 — evidence가 반영되어 P0 승인 카드가 나옵니다."
        : status === "BLOCKED_UNRESOLVED_RESERVATION"
          ? "미해결 예약을 공급자 청구 내역으로 확인하세요. 코드가 대신 판단하지 않습니다."
          : "blocker를 해결하세요. 모델을 조용히 바꾸지 않았으므로 무엇이 안 되는지 그대로 남아 있습니다.",
    at: now(),
    ...(evidence ? { evidence } : {}),
  };
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
  lines.push(`미해결 예약: $${summary.unresolvedUsd.toFixed(6)}`);
  lines.push("");
  for (const record of summary.records) {
    lines.push(`${record.role}: ${record.requestedModelId} (${record.providerId})`);
    lines.push(`  실제 호출: ${record.liveProbe} / dispatch=${record.dispatchState}`);
    lines.push(
      `  응답 envelope 모델 ID: ${record.providerReportedModelId ?? "(없음)"} / 일치=${record.exactModelIdVerified}` +
        (record.modelIdMatchedBy ? ` (${record.modelIdMatchedBy})` : "")
    );
    lines.push(`  구조화 출력: ${record.structuredOutputOk}${record.evidence ? ` (${record.evidence})` : ""}`);
    lines.push(
      `  usage: 입력 ${record.inputTokens ?? "?"} / 출력 ${record.outputTokens ?? "?"} → ` +
        `예약 $${record.estimatedMaxUsd.toFixed(6)} / 실제 ${
          record.actualUsd === undefined ? "(측정 불가)" : `$${record.actualUsd.toFixed(6)}`
        } / 예약 처리 ${record.reservationOutcome}`
    );
    if (record.failureReason) lines.push(`  실패 사유: ${record.failureReason}`);
    lines.push("");
  }
  if (summary.evidence) {
    lines.push(`probe evidence: ${summary.evidence.evidenceId}`);
    lines.push(`  유효 기간: ${summary.evidence.createdAt} → ${summary.evidence.expiresAt}`);
    lines.push(`  payload hash: ${summary.evidence.evidencePayloadHash}`);
    lines.push("");
  }
  if (summary.blockers.length > 0) {
    lines.push(`${summary.status}:`);
    for (const blocker of summary.blockers) lines.push(`  - ${blocker}`);
  }
  return lines;
}

/** 자격증명 binding을 만든다. 키가 하나라도 없으면 undefined — 그게 곧 probe 불가다. */
export function bindingForRoles(
  roles: readonly { entry: ModelEntry }[],
  env: NodeJS.ProcessEnv
): CredentialBinding | undefined {
  const specs = [...new Map(roles.map((r) => [r.entry.providerId, { providerId: r.entry.providerId, envName: r.entry.apiKeyEnvName }])).values()];
  return computeCredentialBinding(specs, env);
}
