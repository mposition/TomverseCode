import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BudgetEvent } from "@tomverse/sidecar/budget";
import { ATTESTATIONS_DIR, loadApprovalArtifactByPath, storeApprovalArtifact, writeApprovalPointer } from "./approvalStore.js";
import { analyzeBudgetEvents } from "./budgetRecovery.js";
import { artifactHash, verifyArtifactHash } from "./canonical.js";
import { findSecretLike } from "./records.js";
import type { ProbeEvidence } from "./probeEvidence.js";
import type { ExecutionAuthorizationReceipt } from "./receipt.js";
import type { RunCard } from "./runCard.js";
import type { ArmId, GateRunRecord } from "./types.js";

/**
 * P0 Attestation (§5) — **"P0가 완전히 정상이었다"를 기계가 확인한 증거.**
 *
 * # 왜 필요한가
 *
 * P1 카드의 선행 조건은 문장이었다: "P0 smoke가 완전히 정상이어야 합니다". 사람이 읽고 판단할
 * 뿐 아무것도 막지 않았으므로, P0에서 절반이 실패해도 P1을 그대로 승인할 수 있었다. P1은
 * fixture가 12배이고 비용도 12배이므로, 그 상태로 넘어가는 것이 가장 비싼 실수다.
 *
 * # 왜 "부분 성공"에 attestation을 만들지 않는가
 *
 * P0의 목적은 품질 측정이 아니라 **실행 경로 확인**이다. 8건 중 7건만 돌았다면 확인되지 않은
 * 경로가 남아 있고, 그 경로가 P1에서 96건 규모로 실패할 수 있다. "대체로 됐다"는 P0의 통과
 * 기준이 아니다 — 그래서 조건 하나라도 어긋나면 attestation을 만들지 않는다.
 */

export const P0_ATTESTATION_SCHEMA_VERSION = 2;
/** 안내용 포인터. 승인 근거는 immutable 번들의 파일이다. */
export const P0_ATTESTATION_POINTER_FILE = "p0-attestation.pointer.json";

/** attestation이 확인한 호출 하나의 모델 사실. 원본 응답이나 프롬프트는 담지 않는다. */
export interface AttestedCallModel {
  role: "executor" | "reviewer" | "unknown";
  callId: string;
  attempt: number;
  requestedModelId: string;
  providerReportedModelId: string;
  matchedBy: "exact" | "accepted_list";
}

export interface P0Attestation {
  schemaVersion: number;
  attestationId: string;
  createdAt: string;
  /** 이 attestation이 증명하는 카드. */
  cardId: string;
  cardHash: string;
  immutableCardPath: string;
  /**
   * 그 실행을 승인한 receipt (§2.3). **체인의 중심이다** — 기록이 가리키는 receipt가
   * 카드를 가리키고, 카드가 evidence를 가리킨다.
   */
  receiptId: string;
  receiptHash: string;
  /** 그 카드가 근거로 삼은 probe evidence. */
  probeEvidenceId: string;
  probeEvidenceHash: string;
  immutableEvidencePath: string;
  protocolVersion: number;
  criteriaHash: string;
  registrySnapshotHash: string;
  adapterContractVersion: string;
  stage: string;
  outputDir: string;
  /** 카드가 요구한 기록 수와 실제 기록 수. 같아야 한다. */
  expectedRecords: number;
  actualRecords: number;
  executorModelId: string;
  reviewerModelId: string;
  /** 실행 시점에 확인된 fixture 내용 해시. */
  fixtures: { fixtureId: string; hash: string }[];
  /**
   * **모든 성공 호출**의 응답 envelope 모델 사실 (§2.8).
   *
   * 예전에는 `providerReportedModelIds: string[]` 하나였고, 그 값의 출처가
   * `DRAFT_RECEIVED.model`(= 어댑터 자기보고)이었다. 즉 검사가 요청 ID를 요청 ID와 비교했다.
   */
  attestedCalls: AttestedCallModel[];
  totalCostUsd: number;
  /** 검사 항목별 결과 — 무엇을 확인했는지가 남아야 사후에 설명할 수 있다. */
  checks: { name: string; passed: boolean; detail?: string }[];
  attestationHash: string;
  status: "P0_VERIFIED";
}

export type AttestationOutcome =
  | { ok: true; attestation: P0Attestation }
  | {
      ok: false;
      status: "BLOCKED_P0_INCOMPLETE" | "BLOCKED_P0_FAILED";
      checks: { name: string; passed: boolean; detail?: string }[];
      reasons: string[];
    };

function attestationHash(attestation: Omit<P0Attestation, "attestationHash">): string {
  return artifactHash(attestation);
}

export interface AttestationInput {
  /** receipt가 가리킨 immutable 카드. 명령 인자로 받은 카드가 아니다. */
  card: RunCard;
  /** 기록 전체가 참조하는 실행 승인. */
  receipt: ExecutionAuthorizationReceipt;
  /** receipt가 가리킨 immutable evidence. 이미 hash·TTL·binding 검증을 통과한 것만 들어온다. */
  evidence: ProbeEvidence;
  records: readonly GateRunRecord[];
  budgetEvents: readonly BudgetEvent[];
  /** 지금 디스크에 있는 fixture 내용 해시. 카드·receipt·기록과 모두 같아야 한다. */
  currentFixtureHashes: ReadonlyMap<string, string>;
  /**
   * 이 arm의 이 역할이 **어느 모델을 요청해야 했는가.**
   *
   * arm마다 역할 배정이 다르다 — Arm B는 공급자가 anthropic 하나뿐이라 카드의 *reviewer*
   * 모델이 executor 자리에 앉고 reviewer는 드롭된다. 그래서 "executor = 카드의 executor 모델"로
   * 고정하면 정상 실행이 실패로 판정된다. 배정 규칙은 `arms.ts` 하나에만 두고 여기로 주입한다.
   *
   * `undefined`를 돌려주면 "그 arm에 그 역할은 없다"는 뜻이고, 그 역할의 호출이 있으면 실패다.
   */
  expectedModelFor: (arm: ArmId, role: "executor" | "reviewer") => string | undefined;
  /** 응답 모델 ID가 레지스트리에서 허용되는가 — `providerModelIdAccepted`를 주입받는다. */
  modelIdAccepted: (
    modelId: string,
    reported: string | undefined
  ) => { ok: true; matchedBy: "exact" | "accepted_list" } | { ok: false; reason: string };
  createdAt: string;
  attestationId?: string;
}

/**
 * P0 결과를 검사해 attestation을 만든다 (§2.5, §2.8).
 *
 * 검사 목록을 코드가 아니라 **데이터로** 만들어 결과에 그대로 실어 보낸다. 실패했을 때
 * "무엇이 실패했는가"를 사용자가 바로 볼 수 있어야 하고, 통과했을 때도 "무엇을 확인한
 * attestation인가"가 남아야 한다.
 */
export function attestP0(input: AttestationInput): AttestationOutcome {
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  const add = (name: string, passed: boolean, detail?: string): void => {
    checks.push({ name, passed, ...(detail !== undefined ? { detail } : {}) });
  };

  const card = input.card;
  const receipt = input.receipt;
  const expected = card.stage.plannedRecords;
  const records = [...input.records];

  // ---- 체인: receipt → card → evidence ----
  add(
    "receipt가 이 카드를 가리킴",
    receipt.cardId === card.cardId && receipt.cardHash === card.cardHash,
    `receipt ${receipt.cardId}/${receipt.cardHash} vs 카드 ${card.cardId}/${card.cardHash}`
  );
  add(
    "카드가 이 evidence를 근거로 만들어짐",
    card.probeEvidenceId === input.evidence.evidenceId &&
      card.probeEvidenceHash === input.evidence.evidencePayloadHash,
    `카드 ${String(card.probeEvidenceId)} vs evidence ${input.evidence.evidenceId}`
  );
  add(
    "receipt가 이 evidence를 가리킴",
    receipt.probeEvidenceId === input.evidence.evidenceId &&
      receipt.probeEvidenceHash === input.evidence.evidencePayloadHash,
    `receipt ${receipt.probeEvidenceId} vs evidence ${input.evidence.evidenceId}`
  );
  add(
    "receipt와 evidence의 레지스트리·어댑터 계약이 같음",
    receipt.registrySnapshotHash === input.evidence.registrySnapshotHash &&
      receipt.adapterContractVersion === input.evidence.adapterContractVersion,
    `receipt ${receipt.registrySnapshotHash}/${receipt.adapterContractVersion} vs ` +
      `evidence ${input.evidence.registrySnapshotHash}/${input.evidence.adapterContractVersion}`
  );

  // ---- 기록이 전부 같은 receipt를 씀 ----
  const receiptIds = new Set(records.map((r) => `${String(r.receiptId)}::${String(r.receiptHash)}`));
  add(
    "모든 기록이 같은 실행 승인을 사용",
    records.length > 0 && receiptIds.size === 1 && receiptIds.has(`${receipt.receiptId}::${receipt.receiptHash}`),
    records.length === 0
      ? "기록이 없습니다"
      : `기록에 있는 receipt: ${[...receiptIds].join(" / ")} (기대 ${receipt.receiptId})`
  );

  add("카드가 요구한 기록 수와 일치", records.length === expected, `요구 ${expected}건 / 실제 ${records.length}건`);

  const realRecords = records.filter((r) => r.providerKind === "real");
  add(
    "모든 기록이 실제 공급자 기록",
    realRecords.length === records.length && records.length > 0,
    `real ${realRecords.length}건 / 전체 ${records.length}건`
  );

  const keys = new Set(records.map((r) => `${r.fixtureId}::${r.arm}::${r.repetition}`));
  add("fixture/arm/반복 중복 없음", keys.size === records.length, `고유 ${keys.size}건 / 전체 ${records.length}건`);

  const INFRA: ReadonlySet<string> = new Set([
    "host_crash",
    "auth_failure",
    "rate_limit",
    "provider_5xx",
    "network_timeout",
    "oracle_harness_failure",
    "fixture_setup_failure",
    "toolchain_unavailable",
    "cost_unmeasurable",
    "schema_violation",
    "model_unavailable",
  ]);
  const infra = records.filter((r) => r.failureClass !== undefined && INFRA.has(r.failureClass));
  add(
    "인프라·인증·모델·스키마·usage 오류 0건",
    infra.length === 0,
    infra.length === 0 ? undefined : infra.map((r) => `${r.fixtureId}/${r.arm}=${r.failureClass}`).join(", ")
  );

  const unmeasured = records.filter((r) => r.costUsd === undefined);
  add(
    "모든 기록의 비용이 측정됨",
    unmeasured.length === 0,
    unmeasured.length === 0 ? undefined : `${unmeasured.length}건이 비용 미측정`
  );

  const unreadable = records.filter((r) => !r.eventsReadable);
  add(
    "모든 기록에서 이벤트를 읽을 수 있었음",
    unreadable.length === 0,
    unreadable.length === 0
      ? undefined
      : `${unreadable.length}건에서 DB 이벤트를 읽지 못했습니다 — 과금 여부가 불확실합니다`
  );

  const analysis = analyzeBudgetEvents(input.budgetEvents);
  const open = analysis.reservations.filter(
    (r) => r.outcome === "open" || r.outcome === "unresolved" || r.outcome === "partially_settled"
  );
  add("열린 예약 0건", open.length === 0, open.length === 0 ? undefined : `${open.length}건 미해결`);
  add(
    "예산 이벤트 상태 머신 위반 0건",
    analysis.problems.length === 0,
    analysis.problems.length === 0 ? undefined : analysis.problems.slice(0, 3).join(" / ")
  );
  const breached = input.budgetEvents.some((e) => e.type === "budget_estimate_breached");
  add("예산 추정 초과 0건", !breached);

  // ---- 카드/receipt/evidence의 모델이 같음 ----
  const cardExecutor = card.models?.executor.modelId;
  const cardReviewer = card.models?.reviewer.modelId;
  add(
    "카드 모델과 evidence 모델 일치",
    cardExecutor === input.evidence.executor.requestedModelId &&
      cardReviewer === input.evidence.reviewer.requestedModelId,
    `카드 ${String(cardExecutor)}/${String(cardReviewer)} vs evidence ` +
      `${input.evidence.executor.requestedModelId}/${input.evidence.reviewer.requestedModelId}`
  );
  add(
    "카드 모델과 receipt 모델 일치",
    cardExecutor === receipt.executor.modelId && cardReviewer === receipt.reviewer.modelId,
    `카드 ${String(cardExecutor)}/${String(cardReviewer)} vs receipt ` +
      `${receipt.executor.modelId}/${receipt.reviewer.modelId}`
  );

  // ---- 호출별 exact-model 검증 (§2.8) ----
  const attestedCalls: AttestedCallModel[] = [];
  const modelProblems: string[] = [];
  let successfulCalls = 0;

  for (const record of records) {
    for (const call of record.providerCalls) {
      if (call.status !== "succeeded") continue;
      successfulCalls += 1;
      const label = `${record.fixtureId}/${record.arm}/${call.callId}#${call.attempt}`;

      // **역할을 서로 바꿔 통과시키지 않는다.** reviewer 호출이 executor 모델로 응답했다면
      // 그건 배정이 무너진 것이고, 교차검증이라는 실험 전제 자체가 성립하지 않는다.
      if (call.role !== "executor" && call.role !== "reviewer") {
        modelProblems.push(`${label}: 역할을 알 수 없는 호출입니다 (role=${call.role})`);
        continue;
      }
      const expectedModel = input.expectedModelFor(record.arm, call.role);
      if (expectedModel === undefined) {
        modelProblems.push(`${label}: Arm ${record.arm}에는 ${call.role} 역할이 없어야 하는데 호출이 있습니다`);
        continue;
      }
      if (call.requestedModelId !== expectedModel) {
        modelProblems.push(
          `${label}: Arm ${record.arm}의 ${call.role}가 배정과 다른 모델을 요청했습니다 ` +
            `(요청 ${call.requestedModelId} / 배정 ${expectedModel})`
        );
        continue;
      }
      if (call.providerReportedModelId === undefined) {
        modelProblems.push(`${label}: 응답 envelope에 모델 ID가 없습니다 — 조용한 대체를 배제할 수 없습니다`);
        continue;
      }
      // **요청한 모델의 허용 목록으로만** 검사한다. 다른 역할의 목록으로 통과시키면
      // executor 응답이 reviewer 모델로 와도 넘어간다.
      const match = input.modelIdAccepted(expectedModel, call.providerReportedModelId);
      if (!match.ok) {
        modelProblems.push(`${label}: ${match.reason}`);
        continue;
      }
      attestedCalls.push({
        role: call.role,
        callId: call.callId,
        attempt: call.attempt,
        requestedModelId: call.requestedModelId,
        providerReportedModelId: call.providerReportedModelId,
        matchedBy: match.matchedBy,
      });
    }
  }

  add(
    "성공한 provider 호출이 존재",
    successfulCalls > 0,
    `성공 호출 ${successfulCalls}건 (replay된 초안은 API 호출로 세지 않습니다)`
  );
  add(
    "모든 성공 호출의 응답 envelope 모델 ID가 카드·레지스트리와 일치",
    modelProblems.length === 0 && attestedCalls.length === successfulCalls,
    modelProblems.length === 0
      ? `확인한 호출 ${attestedCalls.length}건`
      : modelProblems.slice(0, 5).join(" / ")
  );

  // ---- fixture 해시 일관성: 카드 / receipt / 기록 / 현재 ----
  const cardFixtures = new Map(card.fixtureHashes.map((f) => [f.fixtureId, f.hash]));
  const receiptFixtures = new Map(receipt.fixtures.map((f) => [f.fixtureId, f.hash]));
  const fixtureMismatch = records.filter((r) => cardFixtures.get(r.fixtureId) !== r.fixtureHash);
  add(
    "fixture 해시가 카드와 일치",
    fixtureMismatch.length === 0,
    fixtureMismatch.length === 0 ? undefined : `${fixtureMismatch.length}건 불일치`
  );
  const receiptMismatch = records.filter((r) => receiptFixtures.get(r.fixtureId) !== r.fixtureHash);
  add(
    "fixture 해시가 실행 승인과 일치",
    receiptMismatch.length === 0,
    receiptMismatch.length === 0 ? undefined : `${receiptMismatch.length}건 불일치`
  );
  const currentMismatch = [...receiptFixtures.entries()].filter(
    ([id, hash]) => input.currentFixtureHashes.get(id) !== hash
  );
  add(
    "fixture 내용이 실행 이후 바뀌지 않음",
    currentMismatch.length === 0,
    currentMismatch.length === 0
      ? undefined
      : currentMismatch.map(([id, hash]) => `${id}: 승인 ${hash} / 현재 ${String(input.currentFixtureHashes.get(id))}`).join(", ")
  );

  const criteriaMismatch = records.filter((r) => r.criteriaHash !== card.criteriaHash);
  add(
    "판정 기준 해시가 카드와 일치",
    criteriaMismatch.length === 0,
    criteriaMismatch.length === 0 ? undefined : `${criteriaMismatch.length}건 불일치`
  );

  // ---- secret 탐지 ----
  const leaked = findSecretLike(records);
  add("기록에 자격증명처럼 보이는 값 없음", leaked === undefined, leaked);

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    // 기록이 부족한 것과 기록은 다 있지만 실패한 것은 사용자가 해야 하는 일이 다르다.
    const incomplete = records.length !== expected;
    return {
      ok: false,
      status: incomplete ? "BLOCKED_P0_INCOMPLETE" : "BLOCKED_P0_FAILED",
      checks,
      reasons: failed.map((c) => `${c.name} 실패${c.detail ? `: ${c.detail}` : ""}`),
    };
  }

  const totalCostUsd = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const withoutHash: Omit<P0Attestation, "attestationHash"> = {
    schemaVersion: P0_ATTESTATION_SCHEMA_VERSION,
    attestationId: input.attestationId ?? `p0-${randomUUID()}`,
    createdAt: input.createdAt,
    cardId: card.cardId,
    cardHash: card.cardHash,
    immutableCardPath: card.immutableCardPath,
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    probeEvidenceId: input.evidence.evidenceId,
    probeEvidenceHash: input.evidence.evidencePayloadHash,
    immutableEvidencePath: receipt.immutableEvidencePath,
    protocolVersion: card.protocolVersion,
    criteriaHash: card.criteriaHash,
    registrySnapshotHash: receipt.registrySnapshotHash,
    adapterContractVersion: receipt.adapterContractVersion,
    stage: card.stage.stage,
    outputDir: card.outputDir,
    expectedRecords: expected,
    actualRecords: records.length,
    executorModelId: cardExecutor!,
    reviewerModelId: cardReviewer!,
    fixtures: [...receiptFixtures.entries()]
      .map(([fixtureId, hash]) => ({ fixtureId, hash }))
      .sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : 1)),
    attestedCalls,
    totalCostUsd,
    checks,
    status: "P0_VERIFIED",
  };
  return { ok: true, attestation: { ...withoutHash, attestationHash: attestationHash(withoutHash) } };
}

export interface AttestationExpectations {
  probeEvidenceId: string;
  probeEvidenceHash: string;
  criteriaHash: string;
  protocolVersion: number;
  executorModelId: string;
  reviewerModelId: string;
  /** P0를 승인했던 receipt. P1 실행 직전 검증이 이걸로 체인을 확인한다. */
  receiptId?: string;
  receiptHash?: string;
  /** P1 카드가 기록한 attestation. 파일이 그것과 같아야 한다. */
  attestationId?: string;
  attestationHash?: string;
}

export type AttestationVerdict =
  | { ok: true; attestation: P0Attestation }
  | { ok: false; status: "BLOCKED_PENDING_P0_RESULT"; reasons: string[] };

/**
 * P1이 이 attestation을 근거로 삼을 수 있는가.
 *
 * 해시부터 검사한다 — 파일이 수정됐으면 나머지 필드를 믿을 이유가 없다.
 * **P1 유료 실행 직전에도 이 함수를 다시 부른다**(§2.5): 카드를 만든 뒤 attestation 파일이
 * 지워지거나 바뀌었을 수 있고, 그 사실은 카드 해시로는 드러나지 않는다.
 */
export function validateP0Attestation(raw: unknown, expect: AttestationExpectations): AttestationVerdict {
  const reasons: string[] = [];
  const fail = (): AttestationVerdict => ({ ok: false, status: "BLOCKED_PENDING_P0_RESULT", reasons });

  if (typeof raw !== "object" || raw === null) {
    reasons.push("P0 attestation이 객체가 아닙니다");
    return fail();
  }
  const attestation = raw as P0Attestation;
  if (attestation.schemaVersion !== P0_ATTESTATION_SCHEMA_VERSION) {
    reasons.push(
      `P0 attestation 스키마 버전이 ${String(attestation.schemaVersion)}입니다 (이 코드는 ` +
        `${P0_ATTESTATION_SCHEMA_VERSION}만 압니다). P0를 다시 검사하세요 — 이전 형식은 되살리지 않습니다.`
    );
    return fail();
  }
  const hashCheck = verifyArtifactHash(attestation, "attestationHash");
  if (!hashCheck.ok) {
    reasons.push(`P0 attestation ${hashCheck.reason}`);
    return fail();
  }
  if (attestation.status !== "P0_VERIFIED") {
    reasons.push(`P0 attestation 상태가 ${String(attestation.status)}입니다 — P0_VERIFIED만 근거가 됩니다`);
  }
  if (attestation.checks.some((c) => !c.passed)) {
    reasons.push("P0 attestation에 실패한 검사가 포함되어 있습니다 — 통과한 attestation만 근거가 됩니다");
  }
  if (attestation.attestedCalls.length === 0) {
    reasons.push("P0 attestation이 확인한 provider 호출이 0건입니다 — 실행 경로가 확인되지 않았습니다");
  }
  if (attestation.probeEvidenceId !== expect.probeEvidenceId || attestation.probeEvidenceHash !== expect.probeEvidenceHash) {
    reasons.push(
      `P0 attestation이 다른 probe evidence를 근거로 만들어졌습니다 ` +
        `(attestation ${attestation.probeEvidenceId} / 현재 ${expect.probeEvidenceId})`
    );
  }
  if (attestation.criteriaHash !== expect.criteriaHash) {
    reasons.push(`P0 attestation의 판정 기준 해시가 다릅니다 (${attestation.criteriaHash} / ${expect.criteriaHash})`);
  }
  if (attestation.protocolVersion !== expect.protocolVersion) {
    reasons.push(`P0 attestation의 protocol version이 다릅니다`);
  }
  if (attestation.executorModelId !== expect.executorModelId || attestation.reviewerModelId !== expect.reviewerModelId) {
    reasons.push(
      `P0 attestation의 모델이 다릅니다 (${attestation.executorModelId}/${attestation.reviewerModelId} / ` +
        `${expect.executorModelId}/${expect.reviewerModelId})`
    );
  }
  if (expect.receiptId !== undefined && attestation.receiptId !== expect.receiptId) {
    reasons.push(`P0 attestation이 다른 실행 승인을 가리킵니다 (${attestation.receiptId} / ${expect.receiptId})`);
  }
  if (expect.receiptHash !== undefined && attestation.receiptHash !== expect.receiptHash) {
    reasons.push("P0 attestation의 실행 승인 해시가 다릅니다");
  }
  if (expect.attestationId !== undefined && attestation.attestationId !== expect.attestationId) {
    reasons.push(
      `P1 카드가 가리키는 attestation과 다릅니다 (파일 ${attestation.attestationId} / 카드 ${expect.attestationId}) — ` +
        `카드를 만든 뒤 attestation이 바뀌었습니다`
    );
  }
  if (expect.attestationHash !== undefined && attestation.attestationHash !== expect.attestationHash) {
    reasons.push("P1 카드가 기록한 attestation 해시와 파일의 해시가 다릅니다 — 카드를 만든 뒤 파일이 바뀌었습니다");
  }

  if (reasons.length > 0) return fail();
  return { ok: true, attestation };
}

export function p0AttestationPath(approvalsDir: string, attestationId: string): string {
  return path.join(approvalsDir, ATTESTATIONS_DIR, `${attestationId}.json`);
}

/**
 * attestation을 **immutable 번들에** 저장하고 안내용 포인터를 남긴다 (§2.2).
 *
 * 같은 id에 다른 내용을 쓰려 하면 예외다 — P1 카드가 이미 그 id/해시를 가리키고 있을 수 있다.
 */
export function writeP0Attestation(
  approvalsDir: string,
  pointerDir: string,
  attestation: P0Attestation
): { file: string; pointerFile: string } {
  const stored = storeApprovalArtifact(path.join(approvalsDir, ATTESTATIONS_DIR), attestation.attestationId, attestation);
  const pointerFile = writeApprovalPointer(path.join(pointerDir, P0_ATTESTATION_POINTER_FILE), {
    kind: "approval-pointer",
    note: "이 파일은 안내용입니다. P1은 immutablePath의 파일을 --p0-attestation으로 받습니다.",
    stage: attestation.stage,
    artifactId: attestation.attestationId,
    artifactHash: attestation.attestationHash,
    immutablePath: stored.file,
    updatedAt: attestation.createdAt,
  });
  return { file: stored.file, pointerFile };
}

export function loadP0Attestation(file: string): { found: boolean; raw?: unknown; parseError?: string } {
  const loaded = loadApprovalArtifactByPath(file);
  if (!loaded.found) return { found: false, parseError: loaded.reason };
  return { found: true, raw: loaded.raw };
}

export function renderAttestation(outcome: AttestationOutcome): string[] {
  const lines: string[] = [];
  if (outcome.ok) {
    lines.push("=== P0 Attestation ===");
    lines.push(`상태: ${outcome.attestation.status}`);
    lines.push(`ID: ${outcome.attestation.attestationId}`);
    lines.push(`해시: ${outcome.attestation.attestationHash}`);
    lines.push(`카드: ${outcome.attestation.cardId} (${outcome.attestation.cardHash})`);
    lines.push(`실행 승인: ${outcome.attestation.receiptId} (${outcome.attestation.receiptHash})`);
    lines.push(`probe evidence: ${outcome.attestation.probeEvidenceId}`);
    lines.push(`확인한 provider 호출: ${outcome.attestation.attestedCalls.length}건 (응답 envelope 기준)`);
    lines.push(`기록: ${outcome.attestation.actualRecords}/${outcome.attestation.expectedRecords}건`);
    lines.push(`총 비용: $${outcome.attestation.totalCostUsd.toFixed(6)}`);
    lines.push("");
    lines.push("확인한 것:");
    for (const check of outcome.attestation.checks) lines.push(`  ✓ ${check.name}`);
    return lines;
  }
  lines.push("=== P0 Attestation ===");
  lines.push(`상태: ${outcome.status}`);
  lines.push("");
  lines.push("검사 결과:");
  for (const check of outcome.checks) {
    lines.push(`  ${check.passed ? "✓" : "✗"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
  }
  lines.push("");
  lines.push("attestation을 만들지 않았습니다 — P1은 이 상태에서 실행할 수 없습니다.");
  return lines;
}
