import { randomUUID } from "node:crypto";
import path from "node:path";
import { createBudgetLedger } from "@tomverse/sidecar/budget";
import { ARMS } from "./arms.js";
import {
  APPROVALS_DIR,
  ATTESTATIONS_DIR,
  CARDS_DIR,
  EVIDENCE_DIR,
  artifactPath,
  loadApprovalArtifactByPath,
  storeApprovalArtifact,
  writeApprovalPointer,
} from "./approvalStore.js";
import { computeCallBudget, describeCallBudget, type CallBudget } from "./callBudget.js";
import { artifactHash, verifyArtifactHash } from "./canonical.js";
import { CRITERIA, criteriaHash } from "./criteria.js";
import {
  diffArgv,
  executionArgv,
  executionCliArgv,
  resumeArgv as buildResumeArgv,
  type ExecutionRequestSpec,
} from "./executionRequest.js";
import {
  estimateRecordCost,
  lookupModel,
  maxCallsPerRecord,
  readinessBlockers,
  readinessProbeGaps,
  withLiveProbe,
  type ModelPlan,
} from "./models.js";
import type { ProbeEvidence } from "./probeEvidence.js";
import { findSecretLike } from "./records.js";
import { posixCommand, powerShellCommand } from "./shellQuote.js";
import { requiresP0Attestation as stageRequiresAttestation, type Stage } from "./stage.js";
import type { LoadedFixture } from "./manifest.js";
import type { ArmId } from "./types.js";

export type { Stage } from "./stage.js";

/**
 * Run Card (§4) — **유료 실행의 필수 입력.**
 *
 * # 왜 출력만으로는 부족했나
 *
 * 예전 카드는 화면에 출력되고 끝났다. `pilot`은 그 카드를 요구하지 않았으므로, 사용자는
 * `plan-pilot`을 거치지 않고 곧바로 `pilot --max-cost-usd 200`을 돌릴 수 있었다. 그러면
 * 카드가 보여준 계획(어떤 fixture, 어떤 모델, 얼마)과 실제 실행이 아무 관계도 없다 —
 * 승인 절차가 있는 것처럼 보이지만 강제되지 않는 상태다.
 *
 * 이제 카드는 **파일로 저장되고 해시로 봉인되며**, `pilot`/`run`이 `--run-card`를 필수로 받는다.
 * 실행 전에 카드 해시·단계·경로·인자·예산·probe evidence·자격증명 binding을 확인하고,
 * 하나라도 다르면 **어댑터를 만들기 전에** 거부한다.
 *
 * # 이 카드에 없는 것
 *
 * API 키 값, 전체 환경변수, 실제 성공률. 마지막 항목이 중요하다 — 이 카드는 계획이지
 * 결과가 아니므로 성공률을 적을 수 없고, 적으면 지어낸 것이다.
 */

/**
 * 카드 스키마 버전.
 *
 * 2: 해시가 **재귀 canonical JSON**으로 바뀌었고(§2.1), 카드가 immutable 경로와 근거 아티팩트
 * 경로를 갖는다(§2.2). v1 카드는 중첩 필드가 해시에 들어가지 않던 시절의 것이므로 되살리지
 * 않는다 — "해시가 맞다"가 아무것도 보증하지 않는 카드로 유료 실행을 승인할 수는 없다.
 */
export const RUN_CARD_SCHEMA_VERSION = 2;
/** 사람이 최신 카드를 찾을 수 있게 하는 **안내용** 포인터. 승인 근거가 아니다. */
export const P0_CARD_POINTER_FILE = "p0-run-card.pointer.json";
export const P1_CARD_POINTER_FILE = "p1-run-card.pointer.json";

/**
 * 카드 유효 기간.
 *
 * probe evidence(24시간)보다 길면 "만료된 확인 위에 유효한 카드"가 생긴다. 같게 두어
 * 두 문서가 함께 낡게 한다.
 */
export const RUN_CARD_TTL_HOURS = 24;

export interface StagePlan {
  stage: Stage;
  label: string;
  fixtureIds: string[];
  arms: ArmId[];
  repetitions: number;
  /** 계획된 기록 수 = fixture × arm × 반복. */
  plannedRecords: number;
  /**
   * provider 호출 상한 — **executor/reviewer/총합을 함께 담는다.**
   *
   * 예전에는 executor만 센 값이 카드에 "최대 provider 호출 수"로 표시됐다. P1에서 그 값은
   * 384였고 실제 상한은 528이었다. 사용자가 보는 "최대"가 실제보다 작으면 승인 근거로
   * 쓸 수 없으므로, 이제 `callBudget.total`이 정본이고 내역이 함께 나온다.
   */
  callBudget: CallBudget;
  /** 보수적 최대 비용. 계산할 수 없으면 undefined다(0으로 대체하지 않는다). */
  maxCostUsd?: number;
  perArmMaxCostUsd: { arm: ArmId; maxUsd?: number; basis?: string }[];
}

/**
 * 카드 상태 (§3).
 *
 * 상태가 곧 "다음에 무엇을 해야 하는가"다. `READY_FOR_APPROVAL` 하나였을 때는 오프라인 검사만
 * 통과한 상태와 실제 호출까지 확인한 상태가 같은 단어로 표시됐고, 앞의 것으로 유료 실행을
 * 승인하면 "레지스트리에 있으므로 사용 가능"을 승인 근거로 쓰는 것이었다.
 */
export type CardStatus =
  /** 자격증명이 없다. probe도 실행도 불가능하다. */
  | "BLOCKED_MISSING_CREDENTIALS"
  /** 오프라인으로 확인할 수 있는 것은 전부 확인됐다. 다음은 `gate:g:probe-models`다. */
  | "READY_FOR_MODEL_PROBE"
  /** evidence가 있지만 손상·불일치·만료됐다. */
  | "BLOCKED_INVALID_PROBE_EVIDENCE"
  /** P1인데 P0 attestation이 없다. */
  | "BLOCKED_PENDING_P0_RESULT"
  /** 그 밖의 결함(가격 정보 없음, 예산 부족, 독립성 위반 등). */
  | "BLOCKED"
  /** P0 유료 실행을 승인할 수 있다. */
  | "READY_FOR_P0_APPROVAL"
  /** P1 유료 실행을 승인할 수 있다. */
  | "READY_FOR_P1_APPROVAL";

export interface RunCard {
  cardSchemaVersion: number;
  cardId: string;
  /** 카드 전체의 해시. 실행 시 재계산해 비교한다 — 손으로 고친 카드를 잡는다. */
  cardHash: string;
  status: CardStatus;
  /** 사용자가 다음에 할 일 한 줄. 상태만 보고 무엇을 해야 할지 추측하게 하지 않는다. */
  nextAction: string;
  blockers: string[];
  /** 실제 probe로만 채울 수 있는 빈칸. blocker와 섞지 않는다. */
  probeGaps: string[];
  protocolVersion: number;
  criteriaHash: string;
  fixtureHashes: { fixtureId: string; category: string; language: string; hash: string }[];
  arms: { arm: ArmId; label: string; providers: string[]; reviewMode?: string; draftSource: string }[];
  models?: {
    executor: ModelPlan["executor"];
    reviewer: ModelPlan["reviewer"];
    providerIndependent: boolean;
    readiness: ModelPlan["readiness"];
  };
  seed: number;
  maxConcurrency: number;
  /** **이 카드 하나가 쓰는 실행 디렉터리.** P0와 P1은 서로 다른 디렉터리를 쓴다. */
  outputDir: string;
  approvedLimitUsd?: number;
  /**
   * 이 카드 자신의 **immutable 경로** (§2.2).
   *
   * 카드가 자기 경로를 알아야 하는 이유: `--run-card`로 받은 경로가 이 값과 다르면 거부한다.
   * 그렇게 하지 않으면 "덮어쓰이는 안내용 사본"을 승인 근거로 쓸 수 있고, 그 사본은 시간에
   * 따라 내용이 달라진다.
   */
  immutableCardPath: string;
  /** 승인 번들 디렉터리. P0와 P1이 공유한다 — evidence 하나가 두 단계의 근거이기 때문이다. */
  approvalsDir: string;
  /** 이 카드가 근거로 삼은 probe evidence. 없으면 유료 승인 상태가 되지 않는다. */
  probeEvidenceId?: string;
  probeEvidenceHash?: string;
  /** 그 evidence의 immutable 경로. 실행 명령이 이 경로를 그대로 쓴다. */
  probeEvidencePath?: string;
  /** P1은 P0 attestation을 요구한다. */
  requiresP0Attestation: boolean;
  p0AttestationId?: string;
  p0AttestationHash?: string;
  p0AttestationPath?: string;
  /**
   * 이 카드가 승인하는 **한 단계**. P0와 P1을 한 카드에 넣으면 승인 하나가 두 단계를
   * 덮으므로, "P0가 정상일 때만 P1을 승인한다"는 절차가 카드 수준에서 성립하지 않는다.
   */
  stage: StagePlan;
  createdAt: string;
  expiresAt: string;
  /** 실제 API 호출 수 — 카드를 만드는 명령은 항상 0이다. */
  realApiCalls: 0;
  abortConditions: string[];
  /**
   * 실행 인자 **구조**. 검증은 이 배열을 비교한다 — 문자열을 다시 파싱하면 인용 규칙을
   * 두 번 구현하게 되고, 그 둘이 갈라지면 "카드와 실행이 같다"는 검증이 거짓이 된다.
   */
  runArgv: string[];
  /** 사람이 복사할 수 있는 형태. Windows 공백 경로가 깨지지 않게 인용한다. */
  runCommandPowerShell: string;
  runCommandPosix: string;
  resumeArgv: string[];
  resumeCommandPowerShell: string;
  /** 이 단계 앞에 사람이 확인해야 하는 것. */
  prerequisites?: string[];
}

/**
 * P0 smoke의 fixture 선정 — TypeScript 1개 + Rust 1개.
 *
 * 두 언어를 모두 넣는 이유: Rust fixture는 네이티브 툴체인을 요구하므로 **다른 실패 모드**를
 * 갖는다. TypeScript만 돌려 통과시키면 P1에서 Rust 4개가 한꺼번에 무너질 수 있다.
 * 결정론적으로 고르기 위해 id 순으로 첫 항목을 쓴다.
 */
export function selectSmokeFixtures(fixtures: readonly LoadedFixture[]): LoadedFixture[] {
  const byLanguage = (language: string): LoadedFixture | undefined =>
    [...fixtures]
      .filter((f) => f.manifest.language === language)
      .sort((a, b) => a.manifest.fixtureId.localeCompare(b.manifest.fixtureId))[0];
  return [byLanguage("typescript"), byLanguage("rust")].filter((f): f is LoadedFixture => f !== undefined);
}

export function planStage(input: {
  stage: Stage;
  label: string;
  fixtures: readonly LoadedFixture[];
  arms: readonly ArmId[];
  repetitions: number;
  models?: ModelPlan;
  contextTokenBudget?: number;
}): StagePlan {
  const armSpecs = ARMS.filter((a) => input.arms.includes(a.arm));
  const perArm: StagePlan["perArmMaxCostUsd"] = [];
  let total = 0;
  let costKnown = input.models !== undefined;

  for (const spec of armSpecs) {
    const calls = maxCallsPerRecord(spec.arm, spec.providers.length);
    if (!input.models) {
      perArm.push({ arm: spec.arm });
      continue;
    }
    const executor = lookupModel(
      spec.providers[0] === "anthropic" ? input.models.reviewer.modelId : input.models.executor.modelId
    );
    const reviewer = lookupModel(input.models.reviewer.modelId);
    const estimate =
      executor === undefined
        ? undefined
        : estimateRecordCost(executor, reviewer, calls, input.contextTokenBudget);
    if (estimate === undefined) {
      costKnown = false;
      perArm.push({ arm: spec.arm });
      continue;
    }
    const armTotal = estimate.maxUsd * input.fixtures.length * input.repetitions;
    total += armTotal;
    perArm.push({ arm: spec.arm, maxUsd: armTotal, basis: estimate.basis });
  }

  // **호출 수는 공용 계산기에서 온다** — preflight/dry-run과 같은 함수를 쓴다.
  const callBudget = computeCallBudget({
    fixtureCount: input.fixtures.length,
    arms: armSpecs.map((a) => a.arm),
    repetitions: input.repetitions,
  });

  return {
    stage: input.stage,
    label: input.label,
    fixtureIds: input.fixtures.map((f) => f.manifest.fixtureId),
    arms: armSpecs.map((a) => a.arm),
    repetitions: input.repetitions,
    plannedRecords: callBudget.records,
    callBudget,
    ...(costKnown ? { maxCostUsd: total } : {}),
    perArmMaxCostUsd: perArm,
  };
}

/** 실험을 즉시 멈춰야 하는 조건 (§8). 카드에 그대로 실려 사용자가 미리 안다. */
export const ABORT_CONDITIONS: readonly string[] = Object.freeze([
  "인증 실패 (auth_failure)",
  "모델 미지원 / 요청한 모델을 쓸 수 없음",
  "구조화 출력 또는 tool-use 실패 (schema_violation)",
  "usage가 없거나 비용을 계산할 수 없음 — 예산 상한이 무의미해지므로 남은 유료 호출을 중단",
  "과금 여부가 불확실한 실패 — 예약을 해제하지 않고 미해결로 남기고 중단",
  "기록에서 자격증명처럼 보이는 값 탐지",
  "oracle 하네스 실패",
  "네이티브 툴체인 실패 (toolchain_unavailable)",
  "예산 예약 실패 — 승인 상한을 넘길 수 있는 호출은 시작하지 않음",
  "검수자 독립성 위반 (executor와 reviewer가 같은 공급자)",
  "응답 envelope의 모델 ID가 요청과 다름 — 조용한 대체를 허용하지 않음",
  "P0 smoke에 한해: 인프라 실패율이 0보다 큼",
]);

export interface StageCardInput {
  /** 이 카드가 승인하는 단계. */
  stage: Stage;
  label: string;
  /** 이 단계가 실제로 돌릴 fixture. P0는 smoke 선정, P1은 전체다. */
  fixtures: readonly LoadedFixture[];
  arms: readonly ArmId[];
  repetitions: number;
  seed: number;
  maxConcurrency: number;
  /** **이 단계만의** 실행 디렉터리. P0와 P1이 같은 디렉터리를 쓰면 기록이 섞인다. */
  outputDir: string;
  /** 승인 번들 디렉터리(`<outputRoot>/approvals`). 카드·evidence·attestation이 여기 산다. */
  approvalsDir: string;
  /** **이 단계만의** 승인 상한. */
  approvedLimitUsd?: number;
  models: ModelPlan | { blockers: string[]; probeGaps: string[] };
  extraBlockers?: string[];
  createdAt: string;
  contextTokenBudget?: number;
  /** 이 단계를 시작하기 전에 사람이 확인해야 하는 선행 조건(P1은 P0 결과다). */
  prerequisites?: string[];
  /** 자격증명이 전부 있는가. 없으면 probe도 실행도 불가능하다. */
  credentialsPresent: boolean;
  /** 검증을 통과한 probe evidence. 없으면 유료 승인 상태가 되지 않는다. */
  probeEvidence?: ProbeEvidence;
  /** evidence가 있었지만 검증에 실패한 경우의 사유. */
  probeEvidenceProblems?: string[];
  /** P1이 요구하는 P0 attestation. 경로까지 받는다 — 실행 명령이 그것을 그대로 쓴다. */
  p0Attestation?: { attestationId: string; attestationHash: string; path: string };
  p0AttestationProblems?: string[];
  ttlHours?: number;
  cardId?: string;
}

/**
 * **한 단계에 대한 카드 하나.**
 *
 * 예전에는 카드 하나가 P0와 P1 두 단계를 담고 승인 상한도 하나였다. 그러면 "P0가 완전히
 * 정상일 때만 P1을 승인한다"는 절차가 카드 수준에서 성립하지 않는다 — 승인 하나가 두 단계를
 * 덮고, 출력 디렉터리도 하나이므로 P0의 기록과 P1의 기록이 섞인다.
 */
export function buildStageCard(input: StageCardInput): RunCard {
  // **evidence가 있으면 오프라인 준비성 위에 실제 확인 결과를 얹는다.**
  //
  // 이걸 하지 않으면 probe에 성공해도 `probeGaps`에 "실제로 호출할 수 있는지 확인되지
  // 않았습니다"가 남아 카드가 계속 READY_FOR_MODEL_PROBE가 된다 — 즉 probe가 아무것도
  // 잠그지 못하는 상태가 그대로 유지된다.
  const plan = isPlan(input.models) ? applyEvidence(input.models, input.probeEvidence) : input.models;
  const models = isPlan(plan) ? plan : undefined;
  const blockers = [...(input.extraBlockers ?? []), ...plan.blockers];
  const probeGaps = [...plan.probeGaps];

  const stage = planStage({
    stage: input.stage,
    label: input.label,
    fixtures: input.fixtures,
    arms: input.arms,
    repetitions: input.repetitions,
    ...(models ? { models } : {}),
    ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
  });

  // 승인 상한이 없는 카드는 승인 대상이 아니다. 이 판정을 CLI가 아니라 여기 두는 이유:
  // 카드를 만드는 다른 경로가 생겨도 같은 규칙이 적용되어야 하기 때문이다.
  if (input.approvedLimitUsd === undefined) {
    blockers.push(
      `${input.stage} 단계의 --max-cost-usd가 지정되지 않았습니다 — 유료 실행에는 단계별 승인 상한이 필수입니다`
    );
  }

  // 승인 상한이 한 건도 감당하지 못하면 시작할 수 없다 — 카드에서 미리 막는다.
  if (input.approvedLimitUsd !== undefined && models) {
    if (stage.maxCostUsd === undefined) {
      blockers.push(`${input.stage} 최대 비용을 계산할 수 없습니다 — 가격 정보가 없는 모델이 포함되어 있습니다`);
    } else {
      const ledger = createBudgetLedger(input.approvedLimitUsd);
      const worst = Math.max(
        ...stage.perArmMaxCostUsd.map((a) => (a.maxUsd ?? 0) / Math.max(1, stage.fixtureIds.length * input.repetitions))
      );
      const probe = ledger.reserve({ maxUsd: worst, basis: `${input.stage} 최악 arm 1건` }, "preflight");
      if (!probe.ok) {
        blockers.push(
          `승인 상한 $${input.approvedLimitUsd}로는 ${input.stage} 한 건도 예약할 수 없습니다 ` +
            `(가장 비싼 arm 1건 최대 $${worst.toFixed(4)})`
        );
      }
      if (stage.maxCostUsd > input.approvedLimitUsd) {
        probeGaps.push(
          `승인 상한 $${input.approvedLimitUsd}는 ${input.stage} 전체 보수적 최대 ` +
            `$${stage.maxCostUsd.toFixed(2)}보다 작습니다 — 상한에 도달하면 남은 기록을 실행하지 않고 멈춥니다`
        );
      }
    }
  }

  const evidenceProblems = [...(input.probeEvidenceProblems ?? [])];
  const p0Problems = [...(input.p0AttestationProblems ?? [])];
  const requiresP0Attestation = stageRequiresAttestation(input.stage);

  // ---- 상태 결정 ----
  // 순서에 의미가 있다: 앞의 것이 해결되지 않으면 뒤의 것을 확인해도 무의미하다.
  const status: CardStatus = ((): CardStatus => {
    if (!input.credentialsPresent) return "BLOCKED_MISSING_CREDENTIALS";
    if (blockers.length > 0) return "BLOCKED";
    if (evidenceProblems.length > 0) return "BLOCKED_INVALID_PROBE_EVIDENCE";
    if (!input.probeEvidence) return "READY_FOR_MODEL_PROBE";
    if (requiresP0Attestation && !input.p0Attestation) return "BLOCKED_PENDING_P0_RESULT";
    if (requiresP0Attestation && p0Problems.length > 0) return "BLOCKED_PENDING_P0_RESULT";
    if (probeGaps.some((g) => g.includes("확인되지 않았습니다"))) return "READY_FOR_MODEL_PROBE";
    return input.stage === "smoke" ? "READY_FOR_P0_APPROVAL" : "READY_FOR_P1_APPROVAL";
  })();

  const ttl = input.ttlHours ?? RUN_CARD_TTL_HOURS;
  const expiresAt = new Date(new Date(input.createdAt).getTime() + ttl * 3_600_000).toISOString();
  const cardId = input.cardId ?? `card-${input.stage}-${randomUUID()}`;

  // **경로가 먼저 정해져야 argv를 만들 수 있다.** 카드가 출력하는 명령은 immutable 경로를
  // 가리켜야 하고, 그 경로는 cardId에서 나온다.
  const immutableCardPath = artifactPath(path.join(input.approvalsDir, CARDS_DIR), cardId);
  const evidencePath = input.probeEvidence
    ? artifactPath(path.join(input.approvalsDir, EVIDENCE_DIR), input.probeEvidence.evidenceId)
    : undefined;

  const spec: ExecutionRequestSpec = {
    stage: input.stage,
    fixtureIds: input.fixtures.map((f) => f.manifest.fixtureId),
    arms: [...input.arms],
    repetitions: input.repetitions,
    maxConcurrency: input.maxConcurrency,
    seed: input.seed,
    outputDir: input.outputDir,
    ...(input.approvedLimitUsd !== undefined ? { approvedLimitUsd: input.approvedLimitUsd } : {}),
    // 모델 계획이 없는 카드는 어차피 BLOCKED이지만, argv에는 사실을 적는다 — "(미확정)"이
    // 들어간 명령은 그대로 실행되지 않으므로 조용히 기본값으로 도는 일이 없다.
    executorModelId: models?.executor.modelId ?? "(미확정)",
    reviewerModelId: models?.reviewer.modelId ?? "(미확정)",
    runCardPath: immutableCardPath,
    probeEvidencePath: evidencePath ?? "(probe evidence 없음)",
    ...(input.p0Attestation ? { p0AttestationPath: input.p0Attestation.path } : {}),
  };
  const runArgv = executionArgv(spec);
  const resumeArgvValue = buildResumeArgv(spec);

  const withoutHash: Omit<RunCard, "cardHash"> = {
    cardSchemaVersion: RUN_CARD_SCHEMA_VERSION,
    cardId,
    status,
    nextAction: describeNextAction(status, input.stage),
    blockers: [...blockers, ...evidenceProblems, ...p0Problems],
    probeGaps,
    protocolVersion: CRITERIA.protocolVersion,
    criteriaHash: criteriaHash(),
    fixtureHashes: input.fixtures.map((f) => ({
      fixtureId: f.manifest.fixtureId,
      category: f.manifest.category,
      language: f.manifest.language,
      hash: f.fixtureHash,
    })),
    arms: ARMS.filter((a) => input.arms.includes(a.arm)).map((a) => ({
      arm: a.arm,
      label: a.label,
      providers: [...a.providers],
      ...(a.reviewMode ? { reviewMode: a.reviewMode } : {}),
      draftSource: a.draftSource === "replay" ? `replay(Arm ${a.draftSourceArm})` : "generate",
    })),
    ...(models
      ? {
          models: {
            executor: models.executor,
            reviewer: models.reviewer,
            providerIndependent: models.providerIndependent,
            readiness: models.readiness,
          },
        }
      : {}),
    seed: input.seed,
    maxConcurrency: input.maxConcurrency,
    outputDir: input.outputDir,
    ...(input.approvedLimitUsd !== undefined ? { approvedLimitUsd: input.approvedLimitUsd } : {}),
    immutableCardPath,
    approvalsDir: input.approvalsDir,
    ...(input.probeEvidence && evidencePath
      ? {
          probeEvidenceId: input.probeEvidence.evidenceId,
          probeEvidenceHash: input.probeEvidence.evidencePayloadHash,
          probeEvidencePath: evidencePath,
        }
      : {}),
    requiresP0Attestation,
    ...(input.p0Attestation
      ? {
          p0AttestationId: input.p0Attestation.attestationId,
          p0AttestationHash: input.p0Attestation.attestationHash,
          p0AttestationPath: input.p0Attestation.path,
        }
      : {}),
    stage,
    createdAt: input.createdAt,
    expiresAt,
    realApiCalls: 0,
    abortConditions: [...ABORT_CONDITIONS],
    runArgv,
    runCommandPowerShell: powerShellCommand(runArgv),
    runCommandPosix: posixCommand(runArgv),
    resumeArgv: resumeArgvValue,
    resumeCommandPowerShell: powerShellCommand(resumeArgvValue),
    ...(input.prerequisites && input.prerequisites.length > 0 ? { prerequisites: [...input.prerequisites] } : {}),
  };

  const card: RunCard = { ...withoutHash, cardHash: runCardHash(withoutHash) };

  // 카드에 자격증명이 섞이면 승인 절차 자체가 유출 경로가 된다. 만들자마자 확인한다.
  const leaked = findSecretLike(card);
  if (leaked) {
    throw new Error(`Run Card에 비밀값처럼 보이는 값이 있습니다 (${leaked}) — 생성하지 않았습니다`);
  }
  return card;
}

/**
 * 카드 해시 — 해시 자신을 제외한 **전체**를 재귀 canonical JSON으로 해시한다 (§2.1).
 *
 * 예전 구현은 `JSON.stringify(card, Object.keys(card).sort())`였다. array replacer는
 * property whitelist이고 그 whitelist가 모든 깊이에 적용되므로, **중첩 객체가 전부 `{}`로
 * 직렬화됐다.** 즉 `models.executor.modelId`, `stage.fixtureIds`, `stage.callBudget`,
 * `fixtureHashes[*].hash`, `arms[*].providers`, `readiness` 내부를 아무리 바꿔도 cardHash가
 * 그대로였다 — 해시가 지키던 것은 최상위 스칼라뿐이었다. 자세한 근거는 `canonical.ts`.
 */
export function runCardHash(card: Omit<RunCard, "cardHash">): string {
  return artifactHash(card);
}

function isPlan(value: ModelPlan | { blockers: string[]; probeGaps: string[] }): value is ModelPlan {
  return "executor" in value;
}

/**
 * 검증된 evidence를 준비성에 반영한다.
 *
 * evidence는 이미 `validateProbeEvidence`를 통과한 것만 들어온다 — 모델 ID·자격증명·
 * 레지스트리·계약·만료가 모두 확인된 상태다. 그래서 여기서 다시 판정하지 않고
 * **그 사실을 준비성 축에 옮기기만** 한다.
 */
function applyEvidence(plan: ModelPlan, evidence: ProbeEvidence | undefined): ModelPlan {
  if (!evidence) return plan;
  const byModel = new Map([
    [evidence.executor.requestedModelId, evidence.executor],
    [evidence.reviewer.requestedModelId, evidence.reviewer],
  ]);
  const readiness = plan.readiness.map((r) => {
    const role = byModel.get(r.modelId);
    if (!role) return r;
    return withLiveProbe(r, {
      outcome: "verified",
      returnedModelId: role.providerReportedModelId,
      acceptedByRegistry: role.exactModelIdVerified,
      checkedAt: evidence.createdAt,
      note: `probe evidence ${evidence.evidenceId}로 확인됨 (실제 비용 $${role.actualUsd.toFixed(6)})`,
    });
  });
  const probeGaps = readiness.flatMap((r) => readinessProbeGaps(r));
  const blockers = readiness.flatMap((r) => readinessBlockers(r));
  return { ...plan, readiness, probeGaps, blockers: [...new Set([...plan.blockers, ...blockers])] };
}

/**
 * 안내용 포인터 파일 이름.
 *
 * **승인 근거가 아니다** — 이 파일은 덮어쓰이므로 시간에 따라 내용이 달라진다. 승인의 대상이
 * 시간에 따라 달라지면 "이것을 승인했다"는 말이 성립하지 않는다. 그래서 포인터는 Run Card
 * 형태가 아니고(`kind: "approval-pointer"`), 실수로 `--run-card`에 넘겨도 카드로 해석되지 않는다.
 */
export function cardPointerFileFor(stage: Stage): string {
  return stage === "smoke" ? P0_CARD_POINTER_FILE : P1_CARD_POINTER_FILE;
}

function describeNextAction(status: CardStatus, stage: Stage): string {
  switch (status) {
    case "BLOCKED_MISSING_CREDENTIALS":
      return "공급자 자격증명을 환경에 설정하세요. 키가 없으면 probe도 실행도 불가능합니다.";
    case "BLOCKED":
      return "blocker를 해결하세요. 실제 probe를 돌려도 해결되지 않습니다.";
    case "BLOCKED_INVALID_PROBE_EVIDENCE":
      return "`npm run gate:g:probe-models`로 evidence를 다시 만드세요. 기존 evidence는 이 실행을 보증하지 않습니다.";
    case "BLOCKED_PENDING_P0_RESULT":
      return "P0를 먼저 실행하고 attestation을 만드세요. P0 결과 없이 P1을 승인할 수 없습니다.";
    case "READY_FOR_MODEL_PROBE":
      return "`npm run gate:g:probe-models`로 모델을 실제 확인하세요. 오프라인 사실만으로는 유료 실행을 승인할 수 없습니다.";
    case "READY_FOR_P0_APPROVAL":
      return "이 카드의 실행 명령을 승인하면 P0 smoke를 시작할 수 있습니다.";
    case "READY_FOR_P1_APPROVAL":
      return `이 카드의 실행 명령을 승인하면 ${stage} 단계를 시작할 수 있습니다.`;
  }
}

/**
 * P0 / P1 카드 **두 장**을 만든다.
 *
 * 승인은 단계마다 따로 받아야 한다 — P0(2 fixture)와 P1(24 fixture)의 규모 차이가 크고,
 * P0에서 드러나는 실행 경로 문제를 P1 비용으로 발견하면 안 된다.
 */
export function buildStagedCards(input: {
  fixtures: readonly LoadedFixture[];
  arms: readonly ArmId[];
  seed: number;
  maxConcurrency: number;
  /** 두 단계의 부모 디렉터리. 각 카드는 그 아래 자기 디렉터리를 쓴다. */
  outputRoot: string;
  p0ApprovedLimitUsd?: number;
  p1ApprovedLimitUsd?: number;
  p2ApprovedLimitUsd?: number;
  models: ModelPlan | { blockers: string[]; probeGaps: string[] };
  extraBlockers?: string[];
  createdAt: string;
  contextTokenBudget?: number;
  credentialsPresent: boolean;
  probeEvidence?: ProbeEvidence;
  probeEvidenceProblems?: string[];
  p0Attestation?: { attestationId: string; attestationHash: string; path: string };
  p0AttestationProblems?: string[];
  /** 경로 결합 — 테스트가 플랫폼과 무관하게 검증할 수 있어야 한다. */
  joinPath?: (a: string, b: string) => string;
  ttlHours?: number;
}): { p0: RunCard; p1: RunCard; p2: RunCard } {
  const join = input.joinPath ?? ((a: string, b: string): string => `${a}/${b}`);
  // **승인 번들은 두 단계가 공유한다** — evidence 하나가 P0와 P1의 근거이고, P1 카드가 P0
  // attestation을 가리킨다. 단계별 실행 디렉터리는 그 아래가 아니라 형제로 둔다.
  const approvalsDir = join(input.outputRoot, APPROVALS_DIR);
  const common = {
    approvalsDir,
    arms: input.arms,
    seed: input.seed,
    maxConcurrency: input.maxConcurrency,
    models: input.models,
    createdAt: input.createdAt,
    credentialsPresent: input.credentialsPresent,
    ...(input.extraBlockers ? { extraBlockers: input.extraBlockers } : {}),
    ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
    ...(input.probeEvidence ? { probeEvidence: input.probeEvidence } : {}),
    ...(input.probeEvidenceProblems ? { probeEvidenceProblems: input.probeEvidenceProblems } : {}),
    ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
  };
  return {
    p0: buildStageCard({
      ...common,
      stage: "smoke",
      label: "Stage P0 — 유료 smoke (실행 경로 확인. 품질 측정 아님)",
      fixtures: selectSmokeFixtures(input.fixtures),
      repetitions: 1,
      outputDir: join(input.outputRoot, "p0-smoke"),
      ...(input.p0ApprovedLimitUsd !== undefined ? { approvedLimitUsd: input.p0ApprovedLimitUsd } : {}),
    }),
    p1: buildStageCard({
      ...common,
      stage: "pilot",
      label: "Stage P1 — 전체 pilot (표본 부족 → 항상 INCONCLUSIVE)",
      fixtures: input.fixtures,
      repetitions: 1,
      outputDir: join(input.outputRoot, "p1-pilot"),
      ...(input.p1ApprovedLimitUsd !== undefined ? { approvedLimitUsd: input.p1ApprovedLimitUsd } : {}),
      ...(input.p0Attestation ? { p0Attestation: input.p0Attestation } : {}),
      ...(input.p0AttestationProblems ? { p0AttestationProblems: input.p0AttestationProblems } : {}),
      prerequisites: [
        "P0 smoke가 완전히 정상이어야 합니다 — 인프라 실패 0건, 비용 측정 가능, 구조화 출력 성공",
        "P0에서 요청한 모델 ID와 응답 envelope 모델 ID가 같았음이 attestation으로 확인되어야 합니다",
      ],
    }),
    p2: buildStageCard({
      ...common,
      stage: "confirmatory",
      label: "Stage P2 — confirmatory (PASS/FAIL이 나오는 유일한 단계)",
      fixtures: input.fixtures,
      // **사전 등록 기준 2번이 요구하는 값이다.** 여기서만 만족시킬 수 있으므로 상수로 두지
      // 않고 기준에서 읽는다 — 기준을 바꾸면 이 값도 따라와야 한다.
      repetitions: CRITERIA.minRepetitions,
      outputDir: join(input.outputRoot, "p2-confirmatory"),
      ...(input.p2ApprovedLimitUsd !== undefined ? { approvedLimitUsd: input.p2ApprovedLimitUsd } : {}),
      ...(input.p0Attestation ? { p0Attestation: input.p0Attestation } : {}),
      ...(input.p0AttestationProblems ? { p0AttestationProblems: input.p0AttestationProblems } : {}),
      prerequisites: [
        "P0 smoke가 완전히 정상이어야 합니다 — 인프라 실패 0건, 비용 측정 가능, 구조화 출력 성공",
        "P0에서 요청한 모델 ID와 응답 envelope 모델 ID가 같았음이 attestation으로 확인되어야 합니다",
        "P1이 끝까지 돌았어야 합니다 — 이 단계는 P1의 3배 규모이므로, 완주하지 못한 하네스로 " +
          "시작하면 같은 자리에서 세 배의 비용을 쓰고 멈춘다 (강제되지는 않는다: P1 attestation은 없다)",
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// 저장과 검증
// ---------------------------------------------------------------------------

/**
 * 카드를 **immutable 번들에 저장하고** 안내용 포인터를 갱신한다 (§2.2).
 *
 * 같은 cardId에 다른 내용을 쓰려 하면 `ArtifactConflictError`가 올라간다 — 이미 실행이 그
 * 카드를 근거로 삼았을 수 있으므로 조용히 덮어쓰지 않는다.
 */
export function writeRunCard(card: RunCard): { cardFile: string; pointerFile: string; created: boolean } {
  const stored = storeApprovalArtifact(path.join(card.approvalsDir, CARDS_DIR), card.cardId, card);
  const pointerFile = writeApprovalPointer(path.join(card.outputDir, cardPointerFileFor(card.stage.stage)), {
    kind: "approval-pointer",
    note:
      "이 파일은 **안내용**입니다. 승인 근거는 immutablePath의 파일이며, --run-card에는 그 경로를 " +
      "넘기세요. 이 포인터는 plan-pilot을 다시 돌릴 때마다 갱신됩니다.",
    stage: card.stage.stage,
    artifactId: card.cardId,
    artifactHash: card.cardHash,
    immutablePath: card.immutableCardPath,
    updatedAt: card.createdAt,
  });
  return { cardFile: stored.file, pointerFile, created: stored.created };
}

export type CardLoad =
  | { ok: true; card: RunCard }
  | { ok: false; reasons: string[] };

/**
 * 카드를 읽고 **형식·버전·해시·경로**를 확인한다.
 *
 * 경로까지 보는 이유(§2.2): 카드는 자기 immutable 경로를 알고 있고, 그와 다른 파일에서 읽힌
 * 카드는 사본이다. 사본은 덮어쓰일 수 있으므로 승인 근거가 되지 못한다.
 */
export function loadRunCard(file: string): CardLoad {
  const loaded = loadApprovalArtifactByPath(file);
  if (!loaded.found) return { ok: false, reasons: [loaded.reason] };
  const raw = loaded.raw;
  if (typeof raw !== "object" || raw === null) return { ok: false, reasons: ["Run Card가 객체가 아닙니다"] };

  if ((raw as { kind?: unknown }).kind === "approval-pointer") {
    const pointer = raw as { immutablePath?: string };
    return {
      ok: false,
      reasons: [
        `이 파일은 승인 근거가 아니라 **안내용 포인터**입니다: ${file}`,
        `승인에 쓰는 immutable 카드 경로: ${pointer.immutablePath ?? "(포인터에 경로가 없습니다)"}`,
      ],
    };
  }

  const card = raw as RunCard;
  if (card.cardSchemaVersion !== RUN_CARD_SCHEMA_VERSION) {
    return {
      ok: false,
      reasons: [
        `Run Card 스키마 버전이 ${String(card.cardSchemaVersion)}입니다 (이 코드는 ` +
          `${RUN_CARD_SCHEMA_VERSION}만 압니다) — 모르는 형식을 해석하지 않습니다.`,
        "`npm run gate:g:plan-pilot`으로 카드를 다시 만드세요. 이전 형식은 되살리지 않습니다 — " +
          "v1 해시는 중첩 필드를 덮지 않았으므로 '해시가 맞다'가 아무것도 보증하지 않습니다.",
      ],
    };
  }

  const hashCheck = verifyArtifactHash(card, "cardHash");
  if (!hashCheck.ok) return { ok: false, reasons: [`Run Card ${hashCheck.reason}`] };

  if (typeof card.immutableCardPath !== "string" || card.immutableCardPath.length === 0) {
    return { ok: false, reasons: ["Run Card에 immutable 경로가 없습니다 — 승인 번들 밖에서 만들어진 카드입니다"] };
  }
  if (path.resolve(card.immutableCardPath) !== path.resolve(file)) {
    return {
      ok: false,
      reasons: [
        `이 카드는 다른 경로에서 왔습니다 (카드가 기록한 경로 ${card.immutableCardPath} / 읽은 경로 ${file}).`,
        "사본은 덮어쓰일 수 있으므로 승인 근거가 되지 못합니다 — 카드가 기록한 경로를 그대로 쓰세요.",
      ],
    };
  }
  return { ok: true, card };
}

/** 실행 직전에 확인하는 fixture 사실 — id뿐 아니라 **현재 내용 해시**까지 본다. */
export interface RequestFixture {
  fixtureId: string;
  category: string;
  language: string;
  hash: string;
}

export interface CardExecutionRequest {
  stage: Stage;
  outputDir: string;
  /** **실행 직전의 현재 fixture 사실.** id만 비교하면 내용이 바뀐 fixture로 실행된다(§2.4). */
  fixtures: RequestFixture[];
  arms: ArmId[];
  repetitions: number;
  maxConcurrency: number;
  seed: number;
  maxCostUsd?: number;
  executorModelId: string;
  reviewerModelId: string;
  /** 이 실행에 넘긴 카드/evidence/attestation 경로. 카드가 기록한 것과 같아야 한다. */
  runCardPath: string;
  probeEvidencePath: string;
  p0AttestationPath?: string;
  now: string;
}

export type CardGateVerdict =
  | { ok: true; card: RunCard }
  | { ok: false; status: "BLOCKED_INVALID_RUN_CARD"; reasons: string[] };

/**
 * 유료 실행 직전 검증 — **어댑터를 만들기 전에** 부른다.
 *
 * # 왜 CLI 인수와 카드를 둘 다 보는가
 *
 * 카드만 보면 사용자가 카드와 다른 인수를 주고 실행할 수 있고, 인수만 보면 승인이 무의미하다.
 * 둘이 **같아야** 승인이 실행을 설명한다. 다르면 어느 쪽이 사용자 의도인지 코드가 알 수 없으므로
 * 거부하고, 사용자가 카드를 다시 만들거나 인수를 맞추게 한다.
 *
 * # 왜 argv를 통째로 비교하는가 (§2.9)
 *
 * 필드를 하나씩 비교하면 **새 축을 추가할 때 비교를 빠뜨린다.** 실제로 모델 override와
 * evidence 경로가 그렇게 빠져 있었고, 그래서 카드가 출력한 명령이 그 카드의 검증을 통과하지
 * 못하는 상태가 됐다. 이제 카드를 만든 것과 같은 생성기로 요청 argv를 만들고 **배열을 비교**한다 —
 * 새 플래그를 추가하면 자동으로 비교 대상에 들어간다.
 */
export function authorizeRunCard(card: RunCard, request: CardExecutionRequest): CardGateVerdict {
  const reasons: string[] = [];
  const fail = (): CardGateVerdict => ({ ok: false, status: "BLOCKED_INVALID_RUN_CARD", reasons });

  const approvable: CardStatus[] = ["READY_FOR_P0_APPROVAL", "READY_FOR_P1_APPROVAL"];
  if (!approvable.includes(card.status)) {
    reasons.push(`Run Card 상태가 ${card.status}입니다 — 승인 가능한 상태(${approvable.join(", ")})가 아닙니다`);
  }
  if (card.expiresAt <= request.now) {
    reasons.push(`Run Card가 만료되었습니다 (만료 ${card.expiresAt}, 현재 ${request.now}) — 다시 만드세요`);
  }
  if (card.protocolVersion !== CRITERIA.protocolVersion) {
    reasons.push(`protocol version이 다릅니다 (카드 ${card.protocolVersion} / 현재 ${CRITERIA.protocolVersion})`);
  }
  if (card.criteriaHash !== criteriaHash()) {
    reasons.push(`판정 기준 해시가 다릅니다 (카드 ${card.criteriaHash} / 현재 ${criteriaHash()})`);
  }

  // ---- 실행 인자 전체 비교 ----
  const requestSpec: ExecutionRequestSpec = {
    stage: request.stage,
    fixtureIds: request.fixtures.map((f) => f.fixtureId),
    arms: [...request.arms],
    repetitions: request.repetitions,
    maxConcurrency: request.maxConcurrency,
    seed: request.seed,
    outputDir: request.outputDir,
    ...(request.maxCostUsd !== undefined ? { approvedLimitUsd: request.maxCostUsd } : {}),
    executorModelId: request.executorModelId,
    reviewerModelId: request.reviewerModelId,
    runCardPath: request.runCardPath,
    probeEvidencePath: request.probeEvidencePath,
    ...(request.p0AttestationPath !== undefined ? { p0AttestationPath: request.p0AttestationPath } : {}),
  };
  const cardCli = card.runArgv.slice(card.runArgv.indexOf("--") + 1);
  const differences = diffArgv(cardCli, executionCliArgv(requestSpec));
  for (const difference of differences) reasons.push(difference);

  // ---- 현재 fixture 내용 (§2.4) ----
  // id 집합만 비교하면 **같은 id인데 내용이 바뀐 fixture**로 실행된다. 그러면 카드가 승인한
  // 실험과 실제로 도는 실험이 다르고, attestation은 그 차이를 볼 수 없다.
  const cardFixtures = new Map(card.fixtureHashes.map((f) => [f.fixtureId, f]));
  for (const fixture of request.fixtures) {
    const known = cardFixtures.get(fixture.fixtureId);
    if (!known) {
      reasons.push(`fixture ${fixture.fixtureId}는 이 카드에 없습니다`);
      continue;
    }
    if (known.hash !== fixture.hash) {
      reasons.push(
        `fixture ${fixture.fixtureId}의 **내용이 바뀌었습니다** (카드 ${known.hash} / 현재 ${fixture.hash}) — ` +
          `카드가 승인한 것과 다른 실험이므로 호출을 시작하지 않습니다`
      );
    }
    if (known.category !== fixture.category || known.language !== fixture.language) {
      reasons.push(
        `fixture ${fixture.fixtureId}의 층화 사실이 다릅니다 ` +
          `(카드 ${known.category}/${known.language} / 현재 ${fixture.category}/${fixture.language})`
      );
    }
  }
  for (const id of cardFixtures.keys()) {
    if (!request.fixtures.some((f) => f.fixtureId === id)) {
      reasons.push(`카드의 fixture ${id}가 이번 실행 요청에 없습니다`);
    }
  }

  if (!card.models) {
    reasons.push("Run Card에 모델 계획이 없습니다 — 무엇을 측정하는지 확정되지 않은 카드로 유료 실행하지 않습니다");
  }
  if (!card.probeEvidenceId || !card.probeEvidenceHash || !card.probeEvidencePath) {
    reasons.push("Run Card에 probe evidence가 연결되어 있지 않습니다 — 실제 확인 없이 유료 실행하지 않습니다");
  }
  if (card.requiresP0Attestation && (!card.p0AttestationId || !card.p0AttestationHash || !card.p0AttestationPath)) {
    reasons.push("이 단계는 P0 attestation을 요구하는데 카드에 연결되어 있지 않습니다");
  }

  if (reasons.length > 0) return fail();
  return { ok: true, card };
}

export function renderRunCard(card: RunCard): string[] {
  const lines: string[] = [];
  const money = (v: number | undefined): string => (v === undefined ? "(계산 불가)" : `$${v.toFixed(2)}`);

  lines.push(`=== Run Card — Stage ${card.stage.stage} ===`);
  lines.push(`카드 ID: ${card.cardId}`);
  lines.push(`카드 해시: ${card.cardHash}`);
  lines.push(`상태: ${card.status}`);
  lines.push(`다음 행동: ${card.nextAction}`);
  lines.push(`생성 시각: ${card.createdAt} / 만료: ${card.expiresAt}`);
  lines.push(`실제 API 호출: ${card.realApiCalls}건`);
  lines.push("");
  lines.push(`protocol version: v${card.protocolVersion}`);
  lines.push(`판정 기준 해시: ${card.criteriaHash}`);
  lines.push(
    `probe evidence: ${card.probeEvidenceId ?? "(없음 — 아직 실제 확인이 없습니다)"}` +
      (card.probeEvidenceHash ? ` / hash ${card.probeEvidenceHash}` : "")
  );
  lines.push(
    `P0 attestation: ${card.requiresP0Attestation ? (card.p0AttestationId ?? "(필요하지만 없음)") : "(이 단계는 요구하지 않음)"}`
  );
  lines.push(`fixture: ${card.fixtureHashes.length}개`);
  const categories = new Map<string, number>();
  for (const f of card.fixtureHashes) categories.set(f.category, (categories.get(f.category) ?? 0) + 1);
  for (const [category, count] of [...categories].sort()) lines.push(`  - ${category}: ${count}개`);
  const languages = new Map<string, number>();
  for (const f of card.fixtureHashes) languages.set(f.language, (languages.get(f.language) ?? 0) + 1);
  lines.push(`언어: ${[...languages].sort().map(([l, c]) => `${l} ${c}개`).join(" / ")}`);
  lines.push("");

  lines.push("Arm:");
  for (const arm of card.arms) {
    lines.push(
      `  ${arm.arm}: ${arm.label} [${arm.providers.join("+")}] 초안=${arm.draftSource}` +
        (arm.reviewMode ? ` review=${arm.reviewMode}` : "")
    );
  }
  lines.push("");

  if (card.models) {
    lines.push("모델 (run metadata에 고정됨 — 실행 중 바뀌지 않는다):");
    for (const [role, m] of [["executor", card.models.executor], ["reviewer", card.models.reviewer]] as const) {
      lines.push(
        `  ${role}: ${m.modelId} (${m.providerId}) ` +
          `in $${m.inputPerMTok}/M out $${m.outputPerMTok}/M, 기준일 ${m.pricingAsOf}`
      );
      lines.push(
        `      context ${m.maxContextTokens.toLocaleString()} / ` +
          `요청 출력 ${m.requestedMaxOutputTokens.toLocaleString()} (모델 최대 ${m.modelMaxOutputTokens.toLocaleString()}) ` +
          `/ ${m.structuredOutput}`
      );
    }
    lines.push(`  검수자 독립성: ${card.models.providerIndependent ? "성립" : "불성립"}`);
    lines.push("  준비성 (축별로 따로 적는다 — '레지스트리에 있으므로 사용 가능'은 사실이 아니다):");
    for (const r of card.models.readiness) {
      const yn = (v: boolean): string => (v ? "확인됨" : "미확인");
      lines.push(`    ${r.modelId} [출처 ${r.source}, 확인 시각 ${r.checkedAt}]`);
      lines.push(
        `      카탈로그=${yn(r.catalogKnown)} 가격=${yn(r.pricingKnown)} ` +
          `구조화출력선언=${yn(r.structuredOutputDeclared)}`
      );
      lines.push(
        `      자격증명=${yn(r.credentialPresent)} 실제호출=${r.liveProbe} ` +
          `모델ID일치=${yn(r.exactModelIdVerified)}`
      );
      for (const note of r.notes) lines.push(`      · ${note}`);
    }
    lines.push("");
  }

  const stage = card.stage;
  lines.push(stage.label);
  lines.push(`  fixture ${stage.fixtureIds.length}개 × arm ${stage.arms.length}개 × 반복 ${stage.repetitions}회`);
  lines.push(`  계획 기록 수: ${stage.plannedRecords}건`);
  for (const line of describeCallBudget(stage.callBudget, "  ")) lines.push(line);
  lines.push(`  보수적 최대 비용: ${money(stage.maxCostUsd)}`);
  for (const arm of stage.perArmMaxCostUsd) {
    lines.push(`      Arm ${arm.arm}: ${money(arm.maxUsd)}`);
  }
  lines.push("");

  if (stage.perArmMaxCostUsd[0]?.basis) {
    lines.push(`비용 산출 근거: ${stage.perArmMaxCostUsd[0].basis}`);
    lines.push("");
  }

  lines.push(`실행 순서 seed: ${card.seed}`);
  lines.push(`최대 동시 실행: ${card.maxConcurrency} (protocol v1은 순차 실행만 지원)`);
  lines.push(`출력 디렉터리: ${card.outputDir}`);
  lines.push(
    `승인 예산 상한: ${card.approvedLimitUsd === undefined ? "(미지정 — 유료 실행에는 필수)" : `$${card.approvedLimitUsd}`}`
  );
  lines.push("상한 초과 방지: 각 기록의 최대 비용을 **호출 전에 예약**하고, 예약할 수 없으면 호출하지 않는다");
  lines.push("재개 시: 기록에서 이미 쓴 금액을 복원해 원장에 넣으므로 재시작이 상한을 늘리지 않는다");
  lines.push("");
  lines.push("실행 명령 (PowerShell — 공백 있는 경로도 그대로 복사 가능):");
  lines.push(`  ${card.runCommandPowerShell}`);
  lines.push("실행 명령 (bash/zsh):");
  lines.push(`  ${card.runCommandPosix}`);
  lines.push("재개 명령 (PowerShell):");
  lines.push(`  ${card.resumeCommandPowerShell}`);
  lines.push("");

  if (card.prerequisites && card.prerequisites.length > 0) {
    lines.push("선행 조건:");
    for (const item of card.prerequisites) lines.push(`  - ${item}`);
    lines.push("");
  }

  lines.push("중단 조건:");
  for (const condition of card.abortConditions) lines.push(`  - ${condition}`);

  if (card.blockers.length > 0) {
    lines.push("");
    lines.push(`${card.status} — 다음이 해결되어야 합니다:`);
    for (const blocker of card.blockers) lines.push(`  - ${blocker}`);
  }
  if (card.probeGaps.length > 0) {
    lines.push("");
    lines.push("실제 확인이 필요한 것 (gate:g:probe-models):");
    for (const gap of card.probeGaps) lines.push(`  - ${gap}`);
  }
  return lines;
}
