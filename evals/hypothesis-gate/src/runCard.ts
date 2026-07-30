import { createBudgetLedger } from "@tomverse/sidecar/budget";
import { ARMS } from "./arms.js";
import { CRITERIA, criteriaHash } from "./criteria.js";
import {
  estimateRecordCost,
  lookupModel,
  maxCallsPerRecord,
  MAX_EXECUTOR_CALLS_PER_RECORD,
  type ModelPlan,
} from "./models.js";
import { findSecretLike } from "./records.js";
import type { LoadedFixture } from "./manifest.js";
import type { ArmId } from "./types.js";

/**
 * Pilot Run Card (§7) — **실제 API를 부르지 않고** 사용자가 승인할 수 있는 실행 계획서.
 *
 * # 왜 필요한가
 *
 * 유료 실험은 시작하면 되돌릴 수 없다. 무엇을 몇 번 부르고 최대 얼마가 들 수 있는지,
 * 무엇이 실험을 중단시키는지를 **돈을 쓰기 전에** 한 장으로 볼 수 있어야 승인이 의미를 갖는다.
 *
 * # 이 카드에 없는 것
 *
 * API 키 값, 전체 환경변수, 실제 성공률. 마지막 항목이 중요하다 — 이 카드는 계획이지
 * 결과가 아니므로 성공률을 적을 수 없고, 적으면 지어낸 것이다.
 */

/** 실험 단계. P0와 P1의 기록을 같은 디렉터리에 섞지 않기 위해 stage가 메타에 들어간다. */
export type Stage = "smoke" | "pilot" | "confirmatory";

export interface StagePlan {
  stage: Stage;
  label: string;
  fixtureIds: string[];
  arms: ArmId[];
  repetitions: number;
  /** 계획된 기록 수 = fixture × arm × 반복. */
  plannedRecords: number;
  /**
   * **이 단계가 낼 수 있는 provider 호출 수의 진짜 상한.** executor + reviewer 전부다.
   *
   * 예전에는 `maxProviderCalls`가 executor 파이프라인만 세면서 카드에는 "최대 provider
   * 호출 수"로 표시됐다. P1에서 그 값은 384였고 실제 상한은 528이었다 — 사용자가 보는
   * "최대"가 실제 최대보다 27% 작았다는 뜻이고, 승인 판단의 근거로 쓸 수 없는 수치다.
   * 그래서 `maxProviderCallsTotal`이 정본이고, 내역은 아래 두 필드로 따로 보여준다.
   */
  maxProviderCallsTotal: number;
  /** 내역 — executor 파이프라인(초안 1 + fix loop 3)이 낼 수 있는 최대. */
  maxExecutorCalls: number;
  /** 내역 — 검수자(검수 1 + revise 2)가 낼 수 있는 최대. 단독 arm은 0이다. */
  maxReviewerCalls: number;
  /** 보수적 최대 비용. 계산할 수 없으면 undefined다(0으로 대체하지 않는다). */
  maxCostUsd?: number;
  perArmMaxCostUsd: { arm: ArmId; maxUsd?: number; basis?: string }[];
}

/**
 * 카드 상태.
 *
 * `READY_FOR_APPROVAL` 하나였을 때의 문제: 오프라인 검사만 통과한 상태와 실제 호출까지
 * 확인한 상태가 같은 단어로 표시됐다. 앞의 것으로 유료 실행을 승인하면 "레지스트리에
 * 있으므로 사용 가능"을 승인 근거로 쓰는 것이다.
 *
 *  - `BLOCKED` — 고쳐야 할 것이 있다. probe를 돌려도 해결되지 않는다.
 *  - `READY_FOR_MODEL_PROBE` — 오프라인으로 확인할 수 있는 것은 전부 확인됐다.
 *    다음 행동은 `gate:g:probe-models`다. **아직 유료 pilot을 승인할 수 없다.**
 *  - `READY_FOR_PAID_RUN` — 실제 호출로 모델·모델 ID·구조화 출력까지 확인됐다.
 */
export type CardStatus = "READY_FOR_PAID_RUN" | "READY_FOR_MODEL_PROBE" | "BLOCKED";

export interface RunCard {
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
   * 이 카드가 승인하는 **한 단계**. P0와 P1을 한 카드에 넣으면 승인 하나가 두 단계를
   * 덮으므로, "P0가 정상일 때만 P1을 승인한다"는 절차가 카드 수준에서 성립하지 않는다.
   */
  stage: StagePlan;
  /** 실제 API 호출 수 — 카드를 만드는 명령은 항상 0이다. */
  realApiCalls: 0;
  abortConditions: string[];
  runCommand: string;
  resumeCommand: string;
  generatedAt: string;
  /** 이 단계 앞에 사람이 확인해야 하는 것. P1 카드는 "P0가 완전히 정상"을 여기 담는다. */
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
  let maxExecutorCalls = 0;
  let maxReviewerCalls = 0;

  for (const spec of armSpecs) {
    // 호출 수는 **arm 정의와 루프 상한에서 유도한다.** 상수로 적어두면 arm을 추가하거나
    // 루프 상한을 바꿀 때 카드가 조용히 틀린 수를 말한다.
    const calls = maxCallsPerRecord(spec.arm, spec.providers.length);
    const records = input.fixtures.length * input.repetitions;
    maxExecutorCalls += calls.executor * records;
    maxReviewerCalls += calls.reviewer * records;

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

  return {
    stage: input.stage,
    label: input.label,
    fixtureIds: input.fixtures.map((f) => f.manifest.fixtureId),
    arms: armSpecs.map((a) => a.arm),
    repetitions: input.repetitions,
    plannedRecords: input.fixtures.length * armSpecs.length * input.repetitions,
    maxProviderCallsTotal: maxExecutorCalls + maxReviewerCalls,
    maxExecutorCalls,
    maxReviewerCalls,
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
  "기록에서 자격증명처럼 보이는 값 탐지",
  "oracle 하네스 실패",
  "네이티브 툴체인 실패 (toolchain_unavailable)",
  "예산 예약 실패 — 승인 상한을 넘길 수 있는 호출은 시작하지 않음",
  "검수자 독립성 위반 (executor와 reviewer가 같은 공급자)",
  "예상하지 못한 모델 대체 — run metadata에 고정된 모델과 다른 모델이 응답",
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
  /** **이 단계만의** 승인 상한. */
  approvedLimitUsd?: number;
  models: ModelPlan | { blockers: string[]; probeGaps: string[] };
  extraBlockers?: string[];
  generatedAt: string;
  contextTokenBudget?: number;
  /** 이 단계를 시작하기 전에 사람이 확인해야 하는 선행 조건(P1은 P0 결과다). */
  prerequisites?: string[];
}

/**
 * **한 단계에 대한 카드 하나.**
 *
 * 예전에는 카드 하나가 P0와 P1 두 단계를 담고 승인 상한도 하나였다. 그러면 "P0가 완전히
 * 정상일 때만 P1을 승인한다"는 절차가 카드 수준에서 성립하지 않는다 — 승인 하나가 두 단계를
 * 덮고, 출력 디렉터리도 하나이므로 P0의 기록과 P1의 기록이 섞인다. 단계마다 카드·승인·
 * 디렉터리를 분리하는 것이 그 절차를 구조로 만드는 방법이다.
 */
export function buildStageCard(input: StageCardInput): RunCard {
  const blockers = [...(input.extraBlockers ?? []), ...input.models.blockers];
  const probeGaps = [...input.models.probeGaps];
  const models = "executor" in input.models ? input.models : undefined;

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
      // 가장 비싼 arm 한 건조차 예약할 수 없으면 아무것도 못 돌린다.
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
      // 승인 상한이 단계 전체를 감당하지 못하는 것 자체는 blocker가 아니다 — 예약이
      // 남은 예산에서 멈추므로 안전하다. 다만 **중간에 멈춘다는 사실**은 미리 알려야 한다.
      if (stage.maxCostUsd > input.approvedLimitUsd) {
        probeGaps.push(
          `승인 상한 $${input.approvedLimitUsd}는 ${input.stage} 전체 보수적 최대 ` +
            `$${stage.maxCostUsd.toFixed(2)}보다 작습니다 — 상한에 도달하면 남은 기록을 실행하지 않고 멈춥니다`
        );
      }
    }
  }

  const status: CardStatus =
    blockers.length > 0 ? "BLOCKED" : probeGaps.length > 0 ? "READY_FOR_MODEL_PROBE" : "READY_FOR_PAID_RUN";

  const card: RunCard = {
    status,
    nextAction: describeNextAction(status, input.stage),
    blockers,
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
    stage,
    realApiCalls: 0,
    abortConditions: [...ABORT_CONDITIONS],
    runCommand: stageCommand(input),
    resumeCommand: `${stageCommand(input)} --resume`,
    generatedAt: input.generatedAt,
    ...(input.prerequisites && input.prerequisites.length > 0 ? { prerequisites: [...input.prerequisites] } : {}),
  };

  // 카드에 자격증명이 섞이면 승인 절차 자체가 유출 경로가 된다. 만들자마자 확인한다.
  const leaked = findSecretLike(card);
  if (leaked) {
    throw new Error(`Run Card에 비밀값처럼 보이는 값이 있습니다 (${leaked}) — 생성하지 않았습니다`);
  }
  return card;
}

/** 단계 → 실행 스크립트. `smoke`도 pilot 스크립트를 쓰지만 `--stage`로 구별된다. */
function scriptFor(stage: Stage): string {
  return stage === "confirmatory" ? "gate:g:run" : "gate:g:pilot";
}

/**
 * 이 카드를 승인했을 때 실제로 돌릴 명령.
 *
 * 카드가 계획을 말하고 사용자가 손으로 다른 명령을 조립하면 둘이 어긋난다. 그래서 카드가
 * **자기 계획을 재현하는 명령**을 그대로 싣는다 — fixture 목록과 seed까지 포함해서다.
 */
function stageCommand(input: StageCardInput): string {
  const parts = [`npm run ${scriptFor(input.stage)} --`, `--stage ${input.stage}`];
  // 전체 fixture가 아닌 단계는 목록을 명시해야 같은 계획이 재현된다.
  if (input.stage === "smoke") {
    parts.push(`--fixtures ${input.fixtures.map((f) => f.manifest.fixtureId).join(",")}`);
  }
  parts.push(`--arms ${[...input.arms].join(",")}`);
  parts.push(`--repetitions ${input.repetitions}`);
  parts.push(`--max-concurrency ${input.maxConcurrency}`);
  parts.push(`--seed ${input.seed}`);
  parts.push(`--output ${input.outputDir}`);
  parts.push(`--max-cost-usd ${input.approvedLimitUsd ?? "<이 단계의 승인 금액>"}`);
  return parts.join(" ");
}

function describeNextAction(status: CardStatus, stage: Stage): string {
  switch (status) {
    case "BLOCKED":
      return "blocker를 해결하세요. 실제 probe를 돌려도 해결되지 않습니다.";
    case "READY_FOR_MODEL_PROBE":
      return (
        "`npm run gate:g:probe-models`로 모델을 실제 확인하세요. " +
        "오프라인 사실만으로는 유료 실행을 승인할 수 없습니다."
      );
    case "READY_FOR_PAID_RUN":
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
  models: ModelPlan | { blockers: string[]; probeGaps: string[] };
  extraBlockers?: string[];
  generatedAt: string;
  contextTokenBudget?: number;
  /** 경로 결합 — 테스트가 플랫폼과 무관하게 검증할 수 있어야 한다. */
  joinPath?: (a: string, b: string) => string;
}): { p0: RunCard; p1: RunCard } {
  const join = input.joinPath ?? ((a: string, b: string): string => `${a}/${b}`);
  const common = {
    arms: input.arms,
    seed: input.seed,
    maxConcurrency: input.maxConcurrency,
    models: input.models,
    generatedAt: input.generatedAt,
    ...(input.extraBlockers ? { extraBlockers: input.extraBlockers } : {}),
    ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
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
      prerequisites: [
        "P0 smoke가 완전히 정상이어야 합니다 — 인프라 실패 0건, 비용 측정 가능, 구조화 출력 성공",
        "P0에서 요청한 모델 ID와 응답 모델 ID가 같았음이 기록으로 확인되어야 합니다",
      ],
    }),
  };
}

export function renderRunCard(card: RunCard): string[] {
  const lines: string[] = [];
  const money = (v: number | undefined): string => (v === undefined ? "(계산 불가)" : `$${v.toFixed(2)}`);

  lines.push(`=== Run Card — Stage ${card.stage.stage} ===`);
  lines.push(`상태: ${card.status}`);
  lines.push(`다음 행동: ${card.nextAction}`);
  lines.push(`생성 시각: ${card.generatedAt}`);
  lines.push(`실제 API 호출: ${card.realApiCalls}건`);
  lines.push("");
  lines.push(`protocol version: v${card.protocolVersion}`);
  lines.push(`판정 기준 해시: ${card.criteriaHash}`);
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
  // **총 상한이 먼저 나온다.** executor만 센 수치를 "최대"라고 부르면 승인 근거가 틀린다.
  lines.push(`  최대 provider 호출 수(총 상한): ${stage.maxProviderCallsTotal}회`);
  lines.push(`      내역 — executor(초안 1 + fix loop 3): ${stage.maxExecutorCalls}회`);
  lines.push(`      내역 — reviewer(검수 1 + revise 2): ${stage.maxReviewerCalls}회`);
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
  lines.push(`실행 명령: ${card.runCommand}`);
  lines.push(`재개 명령: ${card.resumeCommand}`);
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
    lines.push("BLOCKED — 다음이 해결되어야 합니다 (probe로는 해결되지 않습니다):");
    for (const blocker of card.blockers) lines.push(`  - ${blocker}`);
  }
  if (card.probeGaps.length > 0) {
    lines.push("");
    lines.push("실제 확인이 필요한 것 (gate:g:probe-models):");
    for (const gap of card.probeGaps) lines.push(`  - ${gap}`);
  }
  return lines;
}
