import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Probe Evidence (§3) — **"실제로 확인했다"를 다음 단계로 옮기는 증거.**
 *
 * # 왜 파일이 필요한가
 *
 * `probe-models`가 성공해도 `plan-pilot`은 그 사실을 몰랐다. 그래서 카드는 계속
 * `READY_FOR_MODEL_PROBE`였고, 반대로 `pilot`은 **자격증명 존재만으로** 유료 실행 경로에
 * 들어갔다. 즉 확인은 아무것도 잠그지 않고, 실행은 아무것도 요구하지 않는 상태였다.
 *
 * # 왜 이렇게 많은 필드에 결합하는가
 *
 * "확인했다"는 말은 **무엇을 무엇으로 확인했는가** 없이는 쓸모가 없다. 다른 모델, 다른 키,
 * 다른 카탈로그, 다른 어댑터 계약, 다른 판정 기준에서 얻은 확인은 이 실행을 보증하지 않는다.
 * 그래서 하나라도 다르면 거부한다 — 느슨하게 열어 둔 축은 결국 아무것도 막지 않는다.
 *
 * # 왜 짧은 유효 기간인가
 *
 * 모델 가용성은 시간에 따라 바뀐다(모델 폐기, 조직 인증 상태 변경, 요금 변경). 어제의 확인으로
 * 오늘 $139를 승인하는 것은 확인의 의미를 넘어선다. 24시간은 "한 세션 안에서 승인 흐름을
 * 끝낼 수 있는" 길이이면서, 카탈로그·계정 상태가 크게 바뀌기 전이라고 볼 수 있는 길이다.
 */

export const PROBE_EVIDENCE_SCHEMA_VERSION = 1;
export const PROBE_EVIDENCE_FILE = "probe-evidence.json";

/** evidence 유효 기간. 짧게 두는 근거는 위 주석 참조. */
export const PROBE_EVIDENCE_TTL_HOURS = 24;

/**
 * 자격증명 binding의 목적 문자열.
 *
 * HMAC 입력에 목적을 넣는 이유: 같은 키로 만든 다른 용도의 다이제스트와 이 값이 섞이지 않게 한다.
 * (같은 해시를 다른 문맥에서 재사용하면 한 곳의 유출이 다른 곳의 검증을 통과시킬 수 있다.)
 */
export const CREDENTIAL_BINDING_PURPOSE = "tomverse/gate-g/probe-credential-binding/v1";

/**
 * 자격증명이 **같은 것인지만** 확인할 수 있는 비가역 binding.
 *
 * # 저장하지 않는 것
 *
 * 키 원문, prefix, suffix, 길이. prefix/suffix도 자격증명의 일부이고, 여러 파일을 모으면 복원
 * 단서가 된다. 길이는 그 자체로는 약하지만 남길 이유도 없다.
 *
 * # 왜 salt가 evidence에 들어 있는데도 안전한가
 *
 * salt는 비밀이 아니다. 역할은 "같은 키가 다른 evidence에서 같은 다이제스트로 나타나지 않게"
 * 하는 것이다. 다이제스트를 되돌리려면 키를 추측해야 하는데, API 키는 고엔트로피 난수다.
 */
export interface CredentialBinding {
  algorithm: "HMAC-SHA256";
  purpose: string;
  /** evidence마다 새로 만드는 무작위 salt (hex). 비밀이 아니다. */
  salt: string;
  providers: { providerId: string; envName: string; digest: string }[];
}

export interface RoleEvidence {
  providerId: string;
  requestedModelId: string;
  /** 응답 envelope이 실어 온 모델 ID. 없으면 검증이 실패했으므로 evidence가 만들어지지 않는다. */
  providerReportedModelId: string;
  exactModelIdVerified: boolean;
  structuredOutputVerified: boolean;
  usage: { inputTokens: number; outputTokens: number };
  actualUsd: number;
}

export interface ProbeEvidence {
  schemaVersion: number;
  evidenceId: string;
  createdAt: string;
  expiresAt: string;
  protocolVersion: number;
  criteriaHash: string;
  registrySnapshotHash: string;
  adapterContractVersion: string;
  executor: RoleEvidence;
  reviewer: RoleEvidence;
  approvedProbeLimitUsd: number;
  cumulativeProbeCostUsd: number;
  credentialBinding: CredentialBinding;
  /** 위 모든 필드의 해시. 파일을 손으로 고친 것을 잡는다. */
  evidencePayloadHash: string;
  status: "VERIFIED";
}

// ---------------------------------------------------------------------------
// credential binding
// ---------------------------------------------------------------------------

function digestFor(salt: string, providerId: string, keyValue: string): string {
  return createHmac("sha256", Buffer.from(salt, "hex"))
    .update(`${CREDENTIAL_BINDING_PURPOSE}\n${providerId}\n${keyValue}`)
    .digest("hex");
}

export interface ProviderCredentialSpec {
  providerId: string;
  envName: string;
}

/**
 * 현재 환경의 자격증명으로 binding을 만든다.
 *
 * 키가 없는 공급자가 있으면 `undefined`를 돌려준다 — binding을 만들 수 없다는 사실을
 * "빈 다이제스트"로 적으면 나중에 "키가 없었는데 통과"가 가능해진다.
 */
export function computeCredentialBinding(
  specs: readonly ProviderCredentialSpec[],
  env: NodeJS.ProcessEnv,
  salt: string = randomBytes(32).toString("hex")
): CredentialBinding | undefined {
  const providers: CredentialBinding["providers"] = [];
  for (const spec of specs) {
    const value = (env[spec.envName] ?? "").trim();
    if (value.length === 0) return undefined;
    providers.push({ providerId: spec.providerId, envName: spec.envName, digest: digestFor(salt, spec.providerId, value) });
  }
  return { algorithm: "HMAC-SHA256", purpose: CREDENTIAL_BINDING_PURPOSE, salt, providers };
}

/** 지금 환경의 자격증명이 binding을 만들 때와 같은가. */
export function credentialBindingMatches(
  binding: CredentialBinding,
  env: NodeJS.ProcessEnv
): { ok: true } | { ok: false; reason: string } {
  if (binding.algorithm !== "HMAC-SHA256" || binding.purpose !== CREDENTIAL_BINDING_PURPOSE) {
    return { ok: false, reason: "자격증명 binding의 알고리즘 또는 목적 문자열이 이 코드가 아는 것과 다릅니다" };
  }
  if (!/^[0-9a-f]{32,}$/.test(binding.salt)) {
    return { ok: false, reason: "자격증명 binding의 salt 형식이 올바르지 않습니다" };
  }
  for (const provider of binding.providers) {
    const value = (env[provider.envName] ?? "").trim();
    if (value.length === 0) {
      return { ok: false, reason: `${provider.providerId} 자격증명(${provider.envName})이 현재 환경에 없습니다` };
    }
    const expected = Buffer.from(provider.digest, "hex");
    const actual = Buffer.from(digestFor(binding.salt, provider.providerId, value), "hex");
    // 길이가 다르면 timingSafeEqual이 던진다. 형식 오류를 예외로 흘리지 않고 사유로 돌려준다.
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return {
        ok: false,
        reason:
          `${provider.providerId} 자격증명이 probe 당시와 다릅니다 — ` +
          `그때 확인한 것이 지금 쓰는 키를 보증하지 않으므로 evidence를 쓰지 않습니다`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// evidence 생성/검증
// ---------------------------------------------------------------------------

/** 해시 대상에서 해시 자신을 뺀 나머지. 순서를 고정해 같은 내용이 같은 해시를 낸다. */
function payloadForHash(evidence: Omit<ProbeEvidence, "evidencePayloadHash">): string {
  return JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    evidenceId: evidence.evidenceId,
    createdAt: evidence.createdAt,
    expiresAt: evidence.expiresAt,
    protocolVersion: evidence.protocolVersion,
    criteriaHash: evidence.criteriaHash,
    registrySnapshotHash: evidence.registrySnapshotHash,
    adapterContractVersion: evidence.adapterContractVersion,
    executor: evidence.executor,
    reviewer: evidence.reviewer,
    approvedProbeLimitUsd: evidence.approvedProbeLimitUsd,
    cumulativeProbeCostUsd: evidence.cumulativeProbeCostUsd,
    credentialBinding: evidence.credentialBinding,
    status: evidence.status,
  });
}

export function evidencePayloadHash(evidence: Omit<ProbeEvidence, "evidencePayloadHash">): string {
  return createHash("sha256").update(payloadForHash(evidence)).digest("hex").slice(0, 32);
}

export function buildProbeEvidence(input: {
  createdAt: string;
  protocolVersion: number;
  criteriaHash: string;
  registrySnapshotHash: string;
  adapterContractVersion: string;
  executor: RoleEvidence;
  reviewer: RoleEvidence;
  approvedProbeLimitUsd: number;
  cumulativeProbeCostUsd: number;
  credentialBinding: CredentialBinding;
  ttlHours?: number;
  evidenceId?: string;
}): ProbeEvidence {
  const ttl = input.ttlHours ?? PROBE_EVIDENCE_TTL_HOURS;
  const expiresAt = new Date(new Date(input.createdAt).getTime() + ttl * 3_600_000).toISOString();
  const withoutHash: Omit<ProbeEvidence, "evidencePayloadHash"> = {
    schemaVersion: PROBE_EVIDENCE_SCHEMA_VERSION,
    evidenceId: input.evidenceId ?? `probe-${randomUUID()}`,
    createdAt: input.createdAt,
    expiresAt,
    protocolVersion: input.protocolVersion,
    criteriaHash: input.criteriaHash,
    registrySnapshotHash: input.registrySnapshotHash,
    adapterContractVersion: input.adapterContractVersion,
    executor: input.executor,
    reviewer: input.reviewer,
    approvedProbeLimitUsd: input.approvedProbeLimitUsd,
    cumulativeProbeCostUsd: input.cumulativeProbeCostUsd,
    credentialBinding: input.credentialBinding,
    status: "VERIFIED",
  };
  return { ...withoutHash, evidencePayloadHash: evidencePayloadHash(withoutHash) };
}

export interface EvidenceExpectations {
  now: string;
  protocolVersion: number;
  criteriaHash: string;
  registrySnapshotHash: string;
  adapterContractVersion: string;
  executorModelId: string;
  reviewerModelId: string;
  env: NodeJS.ProcessEnv;
}

export type EvidenceVerdict =
  | { ok: true; evidence: ProbeEvidence }
  | { ok: false; status: "BLOCKED_INVALID_PROBE_EVIDENCE"; reasons: string[] };

/**
 * evidence가 **이 실행을 보증하는가.**
 *
 * 검사 순서에 의미를 둔다: 먼저 스키마와 해시(파일이 온전한가), 그다음 결합 축(같은 실험인가),
 * 마지막에 자격증명(같은 키인가). 앞이 깨졌으면 뒤를 검사해도 무의미하고, 사용자가 먼저
 * 고쳐야 하는 것도 앞의 것이다.
 */
export function validateProbeEvidence(raw: unknown, expect: EvidenceExpectations): EvidenceVerdict {
  const reasons: string[] = [];
  const fail = (): EvidenceVerdict => ({ ok: false, status: "BLOCKED_INVALID_PROBE_EVIDENCE", reasons });

  if (typeof raw !== "object" || raw === null) {
    reasons.push("probe evidence가 객체가 아닙니다");
    return fail();
  }
  const evidence = raw as ProbeEvidence;

  if (evidence.schemaVersion !== PROBE_EVIDENCE_SCHEMA_VERSION) {
    reasons.push(
      `evidence 스키마 버전이 ${String(evidence.schemaVersion)}입니다 (이 코드는 ` +
        `${PROBE_EVIDENCE_SCHEMA_VERSION}만 압니다) — 모르는 형식을 해석하지 않습니다`
    );
    return fail();
  }
  if (evidence.status !== "VERIFIED") {
    reasons.push(`evidence 상태가 ${String(evidence.status)}입니다 — VERIFIED만 승인 근거가 됩니다`);
  }

  const { evidencePayloadHash: stored, ...rest } = evidence;
  const recomputed = evidencePayloadHash(rest as Omit<ProbeEvidence, "evidencePayloadHash">);
  if (stored !== recomputed) {
    reasons.push(
      `evidence 해시가 다릅니다 (저장 ${String(stored)} / 재계산 ${recomputed}) — ` +
        `파일이 수정되었거나 손상되었습니다`
    );
    // 해시가 깨졌으면 아래 필드들을 신뢰할 수 없으므로 여기서 끝낸다.
    return fail();
  }

  if (evidence.expiresAt <= expect.now) {
    reasons.push(
      `evidence가 만료되었습니다 (만료 ${evidence.expiresAt}, 현재 ${expect.now}) — ` +
        `모델 가용성과 요금은 시간에 따라 바뀌므로 다시 확인해야 합니다`
    );
  }
  if (evidence.protocolVersion !== expect.protocolVersion) {
    reasons.push(`protocol version이 다릅니다 (evidence ${evidence.protocolVersion} / 현재 ${expect.protocolVersion})`);
  }
  if (evidence.criteriaHash !== expect.criteriaHash) {
    reasons.push(`판정 기준 해시가 다릅니다 (evidence ${evidence.criteriaHash} / 현재 ${expect.criteriaHash})`);
  }
  if (evidence.registrySnapshotHash !== expect.registrySnapshotHash) {
    reasons.push(
      `Model Registry 스냅샷이 다릅니다 (evidence ${evidence.registrySnapshotHash} / 현재 ` +
        `${expect.registrySnapshotHash}) — 단가나 능력 선언이 바뀌면 비용 추정의 의미도 달라집니다`
    );
  }
  if (evidence.adapterContractVersion !== expect.adapterContractVersion) {
    reasons.push(
      `어댑터 계약 버전이 다릅니다 (evidence ${evidence.adapterContractVersion} / 현재 ` +
        `${expect.adapterContractVersion}) — 그때 확인한 계약이 지금 실행되는 계약이 아닙니다`
    );
  }

  for (const [role, expected, actual] of [
    ["executor", expect.executorModelId, evidence.executor],
    ["reviewer", expect.reviewerModelId, evidence.reviewer],
  ] as const) {
    if (!actual || typeof actual !== "object") {
      reasons.push(`evidence에 ${role} 항목이 없습니다`);
      continue;
    }
    if (actual.requestedModelId !== expected) {
      reasons.push(`${role} 모델이 다릅니다 (evidence ${actual.requestedModelId} / 현재 ${expected})`);
    }
    if (!actual.exactModelIdVerified) {
      reasons.push(`${role}의 응답 모델 ID가 확인되지 않은 evidence입니다`);
    }
    if (!actual.structuredOutputVerified) {
      reasons.push(`${role}의 구조화 출력이 확인되지 않은 evidence입니다`);
    }
  }

  if (!evidence.credentialBinding) {
    reasons.push("evidence에 자격증명 binding이 없습니다");
    return fail();
  }
  const binding = credentialBindingMatches(evidence.credentialBinding, expect.env);
  if (!binding.ok) reasons.push(binding.reason);

  if (reasons.length > 0) return fail();
  return { ok: true, evidence };
}

// ---------------------------------------------------------------------------
// 파일 입출력
// ---------------------------------------------------------------------------

export function probeEvidencePath(probeDir: string): string {
  return path.join(probeDir, PROBE_EVIDENCE_FILE);
}

export function writeProbeEvidence(probeDir: string, evidence: ProbeEvidence): string {
  mkdirSync(probeDir, { recursive: true });
  const file = probeEvidencePath(probeDir);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  return file;
}

export type EvidenceLoad = {
  found: boolean;
  /** 읽고 파싱한 내용. 파일이 없거나 파싱에 실패하면 `undefined`다. */
  raw?: unknown;
  path: string;
  parseError?: string;
};

export function loadProbeEvidence(file: string): EvidenceLoad {
  if (!existsSync(file)) return { found: false, path: file };
  try {
    return { found: true, raw: JSON.parse(readFileSync(file, "utf8")) as unknown, path: file };
  } catch (error) {
    return { found: true, raw: undefined, path: file, parseError: String(error).slice(0, 200) };
  }
}
