import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { artifactHash, verifyArtifactHash } from "./canonical.js";
import { executionArgv, type ExecutionRequestSpec } from "./executionRequest.js";
import { findSecretLike } from "./records.js";
import type { Stage } from "./stage.js";
import type { ArmId } from "./types.js";

/**
 * Execution Authorization Receipt (§2.3) — **"이 실행은 이 승인으로 시작됐다"는 영구 증적.**
 *
 * # 왜 카드만으로는 부족했나
 *
 * 카드는 "무엇을 승인했는가"를 말한다. 그런데 실행 기록(`records.jsonl`, `run.json`)은 자기가
 * **어느 카드로** 시작됐는지 남기지 않았다. 그래서:
 *
 * - `attest-p0`는 "명령 시점에 넘겨받은 카드 파일"을 읽었다. 그 파일이 실행 이후 `plan-pilot`
 *   재실행으로 바뀌었다면, **실제로 실행된 것과 다른 카드로 attestation이 만들어진다.**
 * - 같은 디렉터리에 조건을 바꿔 이어붙이면, 두 승인의 기록이 한 파일에 섞여도 아무것도 막지 않았다.
 *
 * receipt는 그 연결을 **provider를 부르기 전에** 디스크에 못 박는다. 이후의 모든 기록이
 * `receiptId`/`receiptHash`를 달고 나오고, attestation은 명령 인자가 아니라 **기록이 가리키는
 * receipt**를 정본으로 삼는다.
 *
 * # 왜 append-only JSONL인가
 *
 * 승인 아티팩트(card/evidence/attestation)는 id별 파일이 자연스럽지만, receipt는 "이 실행
 * 디렉터리에서 일어난 승인들의 시간순 목록"이다. append-only면 중단으로 잘린 마지막 줄 하나를
 * 버리는 것으로 복구가 끝나고, 이전 줄을 고칠 방법이 없다.
 *
 * # 여기에 절대 들어가지 않는 것
 *
 * API 키 원문·prefix·suffix·길이, Authorization 헤더, 전체 환경변수. `credentialBinding`은
 * **키를 HMAC 키로 쓴 다이제스트와 변수 이름**뿐이다.
 */

export const EXECUTION_RECEIPT_SCHEMA_VERSION = 1;
export const EXECUTION_RECEIPTS_FILE = "execution-authorizations.jsonl";

/**
 * 자격증명 binding의 목적 문자열 — receipt 전용.
 *
 * evidence와 다른 문자열을 쓰는 이유: 같은 키로 만든 두 다이제스트가 서로 다른 문맥에서
 * 재사용되면, 한 문맥의 유출이 다른 문맥의 검증을 통과시킬 수 있다.
 */
export const RECEIPT_CREDENTIAL_PURPOSE = "tomverse/gate-g/execution-authorization-binding/v1";

export interface ReceiptCredentialBinding {
  algorithm: "HMAC-SHA256";
  purpose: string;
  /** 비밀이 아니다. 같은 키가 여러 receipt에서 같은 다이제스트로 나타나지 않게 한다. */
  salt: string;
  providers: { providerId: string; envName: string; digest: string }[];
}

/** receipt에 남기는 fixture 사실. 실행 직전의 **현재 내용** 해시다. */
export interface ReceiptFixture {
  fixtureId: string;
  category: string;
  language: string;
  hash: string;
}

export interface ExecutionAuthorizationReceipt {
  receiptSchemaVersion: number;
  receiptId: string;
  createdAt: string;

  /** 이 실행을 승인한 immutable Run Card. */
  cardId: string;
  cardHash: string;
  immutableCardPath: string;

  /** 그 카드가 근거로 삼은 immutable probe evidence. */
  probeEvidenceId: string;
  probeEvidenceHash: string;
  immutableEvidencePath: string;

  /** P1만 갖는다. P0 attestation이 없으면 P1 receipt를 만들지 않는다. */
  requiresP0Attestation: boolean;
  p0AttestationId?: string;
  p0AttestationHash?: string;
  immutableAttestationPath?: string;

  protocolVersion: number;
  criteriaHash: string;
  registrySnapshotHash: string;
  adapterContractVersion: string;

  stage: Stage;
  outputDir: string;
  /** 실행 **직전**의 fixture 내용 해시 전부. fixtureId 순으로 정렬한다. */
  fixtures: ReceiptFixture[];
  arms: ArmId[];
  repetitions: number;
  seed: number;
  maxConcurrency: number;

  executor: { providerId: string; modelId: string };
  reviewer: { providerId: string; modelId: string };
  approvedLimitUsd: number;

  /** 정규화된 실행 argv. 카드의 `runArgv`와 같은 생성기에서 나온다. */
  executionArgv: string[];
  credentialBinding: ReceiptCredentialBinding;

  receiptHash: string;
}

// ---------------------------------------------------------------------------
// credential binding
// ---------------------------------------------------------------------------

/**
 * 다이제스트 계산 — **키가 HMAC 키다** (§2.10).
 *
 * 예전에는 salt를 HMAC 키로, 키 값을 메시지에 넣었다. HMAC의 보안 성질은 "키를 모르면
 * 다이제스트를 만들 수 없다"인데, 그 배치에서는 salt(공개)를 아는 사람이 키 후보를 넣어
 * 다이제스트를 계산할 수 있다. 즉 salt가 비밀이 아닌 이상 offline 검증을 막는 것이 없었다.
 * 실제 API 키가 고엔트로피라 실무 위험은 낮았지만, **의미가 뒤집힌 코드**는 다음 사람이
 * 다른 곳에 복사한다.
 *
 * 이제 키를 HMAC 키로 쓴다 — 키를 모르면 어떤 메시지의 다이제스트도 만들 수 없다.
 */
export function credentialDigest(input: {
  purpose: string;
  salt: string;
  providerId: string;
  envName: string;
  keyValue: string;
}): string {
  return createHmac("sha256", input.keyValue)
    .update(`${input.purpose}\n${input.salt}\n${input.providerId}\n${input.envName}`)
    .digest("hex");
}

export interface ResolvedProviderCredential {
  providerId: string;
  envName: string;
  /** 메모리에서만 쓰인다. 어디에도 저장되지 않는다. */
  value: string;
}

export function buildCredentialBinding(
  purpose: string,
  credentials: readonly ResolvedProviderCredential[],
  salt: string = randomBytes(32).toString("hex")
): ReceiptCredentialBinding {
  return {
    algorithm: "HMAC-SHA256",
    purpose,
    salt,
    providers: [...credentials]
      .sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0))
      .map((c) => ({
        providerId: c.providerId,
        envName: c.envName,
        digest: credentialDigest({ purpose, salt, providerId: c.providerId, envName: c.envName, keyValue: c.value }),
      })),
  };
}

/** 지금 손에 있는 키가 binding을 만들 때와 같은가. 길이가 달라도 예외를 던지지 않는다. */
export function credentialBindingMatchesResolved(
  binding: ReceiptCredentialBinding,
  credentials: readonly ResolvedProviderCredential[]
): { ok: true } | { ok: false; reason: string } {
  if (binding.algorithm !== "HMAC-SHA256") {
    return { ok: false, reason: "자격증명 binding의 알고리즘이 이 코드가 아는 것과 다릅니다" };
  }
  if (!/^[0-9a-f]{32,}$/.test(binding.salt)) {
    return { ok: false, reason: "자격증명 binding의 salt 형식이 올바르지 않습니다" };
  }
  const byProvider = new Map(credentials.map((c) => [c.providerId, c]));
  for (const provider of binding.providers) {
    const current = byProvider.get(provider.providerId);
    if (!current) {
      return { ok: false, reason: `${provider.providerId} 자격증명이 현재 환경에 없습니다` };
    }
    const expected = Buffer.from(provider.digest, "hex");
    const actual = Buffer.from(
      credentialDigest({
        purpose: binding.purpose,
        salt: binding.salt,
        providerId: provider.providerId,
        envName: provider.envName,
        keyValue: current.value,
      }),
      "hex"
    );
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return {
        ok: false,
        reason:
          `${provider.providerId} 자격증명이 승인 당시와 다릅니다 — ` +
          `그때 확인한 것이 지금 쓰는 키를 보증하지 않습니다`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// receipt 생성
// ---------------------------------------------------------------------------

export type ReceiptFacts = Omit<ExecutionAuthorizationReceipt, "receiptSchemaVersion" | "receiptId" | "createdAt" | "receiptHash" | "executionArgv">;

/**
 * **실행 조건의 해시.** receiptId/시각/해시를 뺀 나머지 전부가 대상이다.
 *
 * resume이 "같은 승인인가"를 판정하는 근거이며, 예산을 올리거나 fixture 내용이 바뀌면 이 값이
 * 달라져 같은 디렉터리에 이어붙일 수 없게 된다.
 */
export function receiptConditionsHash(facts: ReceiptFacts): string {
  return artifactHash(facts);
}

export function buildExecutionReceipt(input: {
  facts: ReceiptFacts;
  spec: ExecutionRequestSpec;
  createdAt: string;
  receiptId?: string;
}): ExecutionAuthorizationReceipt {
  const withoutHash: Omit<ExecutionAuthorizationReceipt, "receiptHash"> = {
    receiptSchemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
    receiptId: input.receiptId ?? `receipt-${input.facts.stage}-${randomUUID()}`,
    createdAt: input.createdAt,
    ...input.facts,
    executionArgv: executionArgv(input.spec),
  };
  // `withoutHash`에는 해시 필드가 없으므로 전체를 해시하면 `hashExcludingField`와 같은 값이 된다 —
  // 검증(`verifyArtifactHash`)이 쓰는 것이 그쪽이므로 둘이 같은 대상을 봐야 한다.
  const receipt: ExecutionAuthorizationReceipt = { ...withoutHash, receiptHash: artifactHash(withoutHash) };

  // 승인 증적이 유출 경로가 되면 절차 자체가 위험해진다. 만들자마자 확인한다.
  const leaked = findSecretLike(receipt);
  if (leaked) {
    throw new Error(`실행 승인 receipt에 비밀값처럼 보이는 값이 있습니다 (${leaked}) — 만들지 않았습니다`);
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// 저장과 읽기 (append-only)
// ---------------------------------------------------------------------------

export function receiptsPath(runDir: string): string {
  return path.join(runDir, EXECUTION_RECEIPTS_FILE);
}

/**
 * receipt를 append한다. **provider 호출 전에** 부른다.
 *
 * 쓰기가 실패하면 예외가 그대로 올라간다 — 증적을 남기지 못한 채 유료 호출을 시작하지 않는다.
 */
export function appendExecutionReceipt(runDir: string, receipt: ExecutionAuthorizationReceipt): string {
  mkdirSync(runDir, { recursive: true });
  const file = receiptsPath(runDir);
  appendFileSync(file, `${JSON.stringify(receipt)}\n`);
  return file;
}

export type ReceiptReadOutcome =
  | { ok: true; receipts: ExecutionAuthorizationReceipt[]; truncatedLastLine: boolean }
  | { ok: false; reasons: string[] };

/**
 * receipt 파일을 읽는다.
 *
 * 예산 이벤트와 같은 규칙: 잘린 **마지막** 줄은 중단의 정상적 흔적이므로 버리되 사실을 남기고,
 * 중간 줄이 깨져 있거나 모르는 스키마 버전이면 해석하지 않는다.
 */
export function readExecutionReceipts(runDir: string): ReceiptReadOutcome {
  const file = receiptsPath(runDir);
  if (!existsSync(file)) return { ok: true, receipts: [], truncatedLastLine: false };
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const endedCleanly = lines[lines.length - 1] === "";
  const content = lines.filter((l) => l.trim().length > 0);
  const receipts: ExecutionAuthorizationReceipt[] = [];
  const reasons: string[] = [];
  let truncatedLastLine = false;

  for (let i = 0; i < content.length; i += 1) {
    const isLast = i === content.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content[i]!);
    } catch {
      if (isLast && !endedCleanly) {
        truncatedLastLine = true;
        continue;
      }
      reasons.push(`실행 승인 receipt ${i + 1}번째 줄이 손상되었습니다`);
      continue;
    }
    const receipt = parsed as ExecutionAuthorizationReceipt;
    if (receipt.receiptSchemaVersion !== EXECUTION_RECEIPT_SCHEMA_VERSION) {
      reasons.push(
        `실행 승인 receipt ${i + 1}번째 줄의 스키마 버전이 ${String(receipt.receiptSchemaVersion)}입니다 ` +
          `(이 코드는 ${EXECUTION_RECEIPT_SCHEMA_VERSION}만 압니다)`
      );
      continue;
    }
    const hashCheck = verifyArtifactHash(receipt, "receiptHash");
    if (!hashCheck.ok) {
      reasons.push(`실행 승인 receipt ${i + 1}번째 줄: ${hashCheck.reason}`);
      continue;
    }
    receipts.push(receipt);
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, receipts, truncatedLastLine };
}

export type ReceiptReuseVerdict =
  /** 같은 조건의 receipt가 이미 있다. 그것을 그대로 쓴다. */
  | { kind: "reuse"; receipt: ExecutionAuthorizationReceipt }
  /** 이 디렉터리에 receipt가 없다. 새로 만든다. */
  | { kind: "create" }
  /** 조건이 다른 receipt가 있다. **같은 디렉터리에 기록을 섞지 않는다.** */
  | { kind: "conflict"; reasons: string[] };

/**
 * 재개 시 기존 receipt와 지금 조건을 비교한다.
 *
 * 조건이 하나라도 다르면 `conflict`다 — 예산을 올렸든 fixture 내용이 바뀌었든, 그것은 **새 승인**이며
 * 새 카드와 새 receipt를 요구한다. 기존 기록에 이어붙이면 하나의 `records.jsonl`이 두 승인의
 * 결과를 담게 되고, 그러면 attestation이 무엇을 증명하는지 말할 수 없다.
 */
export function reuseOrConflict(
  existing: readonly ExecutionAuthorizationReceipt[],
  facts: ReceiptFacts
): ReceiptReuseVerdict {
  if (existing.length === 0) return { kind: "create" };
  const wanted = receiptConditionsHash(facts);
  const match = existing.find((r) => receiptConditionsHash(factsOf(r)) === wanted);
  if (match) return { kind: "reuse", receipt: match };

  const newest = existing[existing.length - 1]!;
  return {
    kind: "conflict",
    reasons: [
      `이 실행 디렉터리에는 이미 다른 조건의 실행 승인이 있습니다 (receipt ${newest.receiptId}, ` +
        `카드 ${newest.cardId}).`,
      ...describeReceiptDifferences(factsOf(newest), facts),
      "다른 승인의 기록을 한 디렉터리에 섞지 않습니다 — 새 카드를 만들고 새 --output을 쓰세요.",
    ],
  };
}

/** receipt에서 조건 부분만 뽑는다. id/시각/해시/argv는 조건이 아니다. */
export function factsOf(receipt: ExecutionAuthorizationReceipt): ReceiptFacts {
  const {
    receiptSchemaVersion: _v,
    receiptId: _id,
    createdAt: _at,
    receiptHash: _h,
    executionArgv: _argv,
    ...facts
  } = receipt;
  return facts;
}

function describeReceiptDifferences(existing: ReceiptFacts, incoming: ReceiptFacts): string[] {
  const differences: string[] = [];
  const compare = (label: string, a: unknown, b: unknown): void => {
    const left = artifactHash(a ?? null);
    const right = artifactHash(b ?? null);
    if (left !== right) differences.push(`  - ${label}: 기존 ${describe(a)} / 요청 ${describe(b)}`);
  };
  compare("카드", existing.cardId, incoming.cardId);
  compare("probe evidence", existing.probeEvidenceId, incoming.probeEvidenceId);
  compare("P0 attestation", existing.p0AttestationId ?? "(없음)", incoming.p0AttestationId ?? "(없음)");
  compare("승인 상한", existing.approvedLimitUsd, incoming.approvedLimitUsd);
  compare("단계", existing.stage, incoming.stage);
  compare("seed", existing.seed, incoming.seed);
  compare("반복", existing.repetitions, incoming.repetitions);
  compare("arm", [...existing.arms].sort(), [...incoming.arms].sort());
  compare("executor 모델", existing.executor.modelId, incoming.executor.modelId);
  compare("reviewer 모델", existing.reviewer.modelId, incoming.reviewer.modelId);
  compare("판정 기준 해시", existing.criteriaHash, incoming.criteriaHash);
  compare("레지스트리 스냅샷", existing.registrySnapshotHash, incoming.registrySnapshotHash);
  compare("어댑터 계약", existing.adapterContractVersion, incoming.adapterContractVersion);

  const existingFixtures = new Map(existing.fixtures.map((f) => [f.fixtureId, f.hash]));
  const incomingFixtures = new Map(incoming.fixtures.map((f) => [f.fixtureId, f.hash]));
  for (const [id, hash] of incomingFixtures) {
    const known = existingFixtures.get(id);
    if (known === undefined) differences.push(`  - fixture ${id}가 기존 승인에 없습니다`);
    else if (known !== hash) differences.push(`  - fixture ${id}의 내용이 바뀌었습니다 (${known} → ${hash})`);
  }
  for (const id of existingFixtures.keys()) {
    if (!incomingFixtures.has(id)) differences.push(`  - fixture ${id}가 이번 요청에 없습니다`);
  }
  return differences;
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "(없음)";
}

export function renderReceipt(receipt: ExecutionAuthorizationReceipt): string[] {
  return [
    "=== 실행 승인 receipt ===",
    `receipt: ${receipt.receiptId}`,
    `해시: ${receipt.receiptHash}`,
    `카드: ${receipt.cardId} (${receipt.cardHash})`,
    `  경로: ${receipt.immutableCardPath}`,
    `probe evidence: ${receipt.probeEvidenceId} (${receipt.probeEvidenceHash})`,
    `  경로: ${receipt.immutableEvidencePath}`,
    receipt.requiresP0Attestation
      ? `P0 attestation: ${receipt.p0AttestationId ?? "(없음)"} — 경로 ${receipt.immutableAttestationPath ?? "(없음)"}`
      : "P0 attestation: (이 단계는 요구하지 않음)",
    `단계 ${receipt.stage} / fixture ${receipt.fixtures.length}개 / arm ${receipt.arms.join(",")} / 반복 ${receipt.repetitions}`,
    `모델: executor ${receipt.executor.modelId} (${receipt.executor.providerId}) / ` +
      `reviewer ${receipt.reviewer.modelId} (${receipt.reviewer.providerId})`,
    `승인 상한: $${receipt.approvedLimitUsd}`,
    `자격증명: ${receipt.credentialBinding.providers.map((p) => `${p.providerId}←${p.envName}`).join(", ")} ` +
      `(키 값은 저장하지 않습니다)`,
  ];
}
