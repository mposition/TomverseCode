import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BudgetEvent } from "@tomverse/sidecar/budget";
import { analyzeBudgetEvents } from "./budgetRecovery.js";
import { findSecretLike } from "./records.js";
import type { ProbeEvidence } from "./probeEvidence.js";
import type { RunCard } from "./runCard.js";
import type { GateRunRecord } from "./types.js";

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

export const P0_ATTESTATION_SCHEMA_VERSION = 1;
export const P0_ATTESTATION_FILE = "p0-attestation.json";

export interface P0Attestation {
  schemaVersion: number;
  attestationId: string;
  createdAt: string;
  /** 이 attestation이 증명하는 카드. */
  cardId: string;
  cardHash: string;
  /** 그 카드가 근거로 삼은 probe evidence. 체인을 잇는다. */
  probeEvidenceId: string;
  probeEvidenceHash: string;
  protocolVersion: number;
  criteriaHash: string;
  stage: string;
  outputDir: string;
  /** 카드가 요구한 기록 수와 실제 기록 수. 같아야 한다. */
  expectedRecords: number;
  actualRecords: number;
  executorModelId: string;
  reviewerModelId: string;
  /** 모든 기록에서 확인된 응답 envelope 모델 ID. 하나라도 다르면 attestation이 없다. */
  providerReportedModelIds: string[];
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
  return createHash("sha256").update(JSON.stringify(attestation, Object.keys(attestation).sort())).digest("hex").slice(0, 32);
}

export interface AttestationInput {
  card: RunCard;
  evidence: ProbeEvidence;
  records: readonly GateRunRecord[];
  budgetEvents: readonly BudgetEvent[];
  createdAt: string;
  attestationId?: string;
}

/**
 * P0 결과를 검사해 attestation을 만든다.
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
  const expected = card.stage.plannedRecords;
  const records = [...input.records];

  add(
    "카드가 요구한 기록 수와 일치",
    records.length === expected,
    `요구 ${expected}건 / 실제 ${records.length}건`
  );

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

  const analysis = analyzeBudgetEvents(input.budgetEvents);
  const open = analysis.reservations.filter((r) => r.outcome === "open" || r.outcome === "unresolved");
  add("열린 예약 0건", open.length === 0, open.length === 0 ? undefined : `${open.length}건 미해결`);
  add(
    "예산 이벤트 상태 머신 위반 0건",
    analysis.problems.length === 0,
    analysis.problems.length === 0 ? undefined : analysis.problems.slice(0, 3).join(" / ")
  );
  const breached = input.budgetEvents.some((e) => e.type === "budget_estimate_breached");
  add("예산 추정 초과 0건", !breached);

  // ---- probe evidence와 같은 provider/model/credential binding ----
  const evidenceModels = [input.evidence.executor, input.evidence.reviewer];
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
    "카드가 이 evidence를 근거로 만들어짐",
    card.probeEvidenceId === input.evidence.evidenceId &&
      card.probeEvidenceHash === input.evidence.evidencePayloadHash,
    `카드 ${String(card.probeEvidenceId)} vs evidence ${input.evidence.evidenceId}`
  );

  // ---- 응답 envelope 모델 ID 일치 ----
  // 기록의 `returnedModelId`는 실행 중 관측된 응답 모델 ID다. evidence가 확인한 것과 같아야 한다.
  const acceptable = new Set(evidenceModels.map((m) => m.providerReportedModelId));
  const observed = [...new Set(records.map((r) => r.returnedModelId).filter((m): m is string => typeof m === "string"))];
  const mismatched = observed.filter((m) => !acceptable.has(m));
  add(
    "응답 envelope 모델 ID가 evidence와 일치",
    observed.length > 0 && mismatched.length === 0,
    observed.length === 0
      ? "기록에 응답 모델 ID가 없습니다"
      : mismatched.length === 0
        ? observed.join(", ")
        : `evidence에 없는 모델: ${mismatched.join(", ")}`
  );

  // ---- 해시 일관성 ----
  const cardFixtures = new Map(card.fixtureHashes.map((f) => [f.fixtureId, f.hash]));
  const fixtureMismatch = records.filter((r) => cardFixtures.get(r.fixtureId) !== r.fixtureHash);
  add(
    "fixture 해시가 카드와 일치",
    fixtureMismatch.length === 0,
    fixtureMismatch.length === 0 ? undefined : `${fixtureMismatch.length}건 불일치`
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
    probeEvidenceId: input.evidence.evidenceId,
    probeEvidenceHash: input.evidence.evidencePayloadHash,
    protocolVersion: card.protocolVersion,
    criteriaHash: card.criteriaHash,
    stage: card.stage.stage,
    outputDir: card.outputDir,
    expectedRecords: expected,
    actualRecords: records.length,
    executorModelId: cardExecutor!,
    reviewerModelId: cardReviewer!,
    providerReportedModelIds: observed.sort(),
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
}

export type AttestationVerdict =
  | { ok: true; attestation: P0Attestation }
  | { ok: false; status: "BLOCKED_PENDING_P0_RESULT"; reasons: string[] };

/**
 * P1이 이 attestation을 근거로 삼을 수 있는가.
 *
 * 해시부터 검사한다 — 파일이 수정됐으면 나머지 필드를 믿을 이유가 없다.
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
        `${P0_ATTESTATION_SCHEMA_VERSION}만 압니다)`
    );
    return fail();
  }
  const { attestationHash: stored, ...rest } = attestation;
  const recomputed = attestationHash(rest as Omit<P0Attestation, "attestationHash">);
  if (stored !== recomputed) {
    reasons.push(`P0 attestation 해시가 다릅니다 (저장 ${String(stored)} / 재계산 ${recomputed}) — 파일이 수정되었습니다`);
    return fail();
  }
  if (attestation.status !== "P0_VERIFIED") {
    reasons.push(`P0 attestation 상태가 ${String(attestation.status)}입니다 — P0_VERIFIED만 근거가 됩니다`);
  }
  if (attestation.checks.some((c) => !c.passed)) {
    reasons.push("P0 attestation에 실패한 검사가 포함되어 있습니다 — 통과한 attestation만 근거가 됩니다");
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

  if (reasons.length > 0) return fail();
  return { ok: true, attestation };
}

export function p0AttestationPath(dir: string): string {
  return path.join(dir, P0_ATTESTATION_FILE);
}

export function writeP0Attestation(dir: string, attestation: P0Attestation): string {
  mkdirSync(dir, { recursive: true });
  const file = p0AttestationPath(dir);
  writeFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`);
  return file;
}

export function loadP0Attestation(file: string): { found: boolean; raw?: unknown; parseError?: string } {
  if (!existsSync(file)) return { found: false };
  try {
    return { found: true, raw: JSON.parse(readFileSync(file, "utf8")) as unknown };
  } catch (error) {
    return { found: true, parseError: String(error).slice(0, 200) };
  }
}

export function renderAttestation(outcome: AttestationOutcome): string[] {
  const lines: string[] = [];
  if (outcome.ok) {
    lines.push("=== P0 Attestation ===");
    lines.push(`상태: ${outcome.attestation.status}`);
    lines.push(`ID: ${outcome.attestation.attestationId}`);
    lines.push(`해시: ${outcome.attestation.attestationHash}`);
    lines.push(`카드: ${outcome.attestation.cardId} (${outcome.attestation.cardHash})`);
    lines.push(`probe evidence: ${outcome.attestation.probeEvidenceId}`);
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
