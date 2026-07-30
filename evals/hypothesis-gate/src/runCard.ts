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
   * 최대 provider 호출 수 — **executor 파이프라인 기준**(초안 1 + fix loop 3).
   * 계획 규모를 말하는 수치이고, `plannedRecords × 4`다.
   */
  maxProviderCalls: number;
  /**
   * 검수자 호출까지 포함한 상한. Arm C/D는 검수 1 + revise 2가 더 붙을 수 있으므로
   * 위 수치보다 크다. **비용 예약은 이쪽을 쓴다** — 예약은 넘치는 쪽으로 틀려야 안전하다.
   */
  maxProviderCallsIncludingReviewer: number;
  /** 보수적 최대 비용. 계산할 수 없으면 undefined다(0으로 대체하지 않는다). */
  maxCostUsd?: number;
  perArmMaxCostUsd: { arm: ArmId; maxUsd?: number; basis?: string }[];
}

export interface RunCard {
  status: "READY_FOR_APPROVAL" | "BLOCKED";
  blockers: string[];
  protocolVersion: number;
  criteriaHash: string;
  fixtureHashes: { fixtureId: string; category: string; language: string; hash: string }[];
  arms: { arm: ArmId; label: string; providers: string[]; reviewMode?: string; draftSource: string }[];
  models?: {
    executor: ModelPlan["executor"];
    reviewer: ModelPlan["reviewer"];
    providerIndependent: boolean;
    probes: ModelPlan["probes"];
  };
  seed: number;
  maxConcurrency: number;
  outputDir: string;
  approvedLimitUsd?: number;
  stages: StagePlan[];
  /** 실제 API 호출 수 — 이 명령은 항상 0이다. */
  realApiCalls: 0;
  abortConditions: string[];
  resumeCommand: string;
  generatedAt: string;
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
  let maxCallsWithReviewer = 0;

  for (const spec of armSpecs) {
    const calls = maxCallsPerRecord(spec.arm, spec.providers.length);
    maxCallsWithReviewer += (calls.executor + calls.reviewer) * input.fixtures.length * input.repetitions;

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
    maxProviderCalls: input.fixtures.length * armSpecs.length * input.repetitions * MAX_EXECUTOR_CALLS_PER_RECORD,
    maxProviderCallsIncludingReviewer: maxCallsWithReviewer,
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

export function buildRunCard(input: {
  fixtures: readonly LoadedFixture[];
  arms: readonly ArmId[];
  seed: number;
  maxConcurrency: number;
  outputDir: string;
  approvedLimitUsd?: number;
  models: ModelPlan | { blockers: string[] };
  extraBlockers?: string[];
  generatedAt: string;
  contextTokenBudget?: number;
}): RunCard {
  const blockers = [...(input.extraBlockers ?? []), ...input.models.blockers];
  const models = "executor" in input.models ? input.models : undefined;

  const smokeFixtures = selectSmokeFixtures(input.fixtures);
  const stages: StagePlan[] = [
    planStage({
      stage: "smoke",
      label: "Stage P0 — 유료 smoke (실행 경로 확인. 품질 측정 아님)",
      fixtures: smokeFixtures,
      arms: input.arms,
      repetitions: 1,
      ...(models ? { models } : {}),
      ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
    }),
    planStage({
      stage: "pilot",
      label: "Stage P1 — 전체 pilot (표본 부족 → 항상 INCONCLUSIVE)",
      fixtures: input.fixtures,
      arms: input.arms,
      repetitions: 1,
      ...(models ? { models } : {}),
      ...(input.contextTokenBudget !== undefined ? { contextTokenBudget: input.contextTokenBudget } : {}),
    }),
  ];

  // 승인 상한이 없는 카드는 승인 대상이 아니다. 이 판정을 CLI가 아니라 여기 두는 이유:
  // 카드를 만드는 다른 경로가 생겨도 같은 규칙이 적용되어야 하기 때문이다.
  if (input.approvedLimitUsd === undefined) {
    blockers.push("--max-cost-usd가 지정되지 않았습니다 — 유료 실행에는 승인 상한이 필수입니다");
  }

  // 승인 상한이 P0 한 건도 감당하지 못하면 시작할 수 없다 — 카드에서 미리 막는다.
  if (input.approvedLimitUsd !== undefined && models) {
    const smoke = stages[0]!;
    if (smoke.maxCostUsd === undefined) {
      blockers.push("P0 최대 비용을 계산할 수 없습니다 — 가격 정보가 없는 모델이 포함되어 있습니다");
    } else {
      const ledger = createBudgetLedger(input.approvedLimitUsd);
      // 가장 비싼 arm 한 건조차 예약할 수 없으면 아무것도 못 돌린다.
      const worst = Math.max(
        ...smoke.perArmMaxCostUsd.map((a) => (a.maxUsd ?? 0) / Math.max(1, smoke.fixtureIds.length))
      );
      const probe = ledger.reserve({ maxUsd: worst, basis: "P0 최악 arm 1건" }, "preflight");
      if (!probe.ok) {
        blockers.push(
          `승인 상한 $${input.approvedLimitUsd}로는 P0 한 건도 예약할 수 없습니다 ` +
            `(가장 비싼 arm 1건 최대 $${worst.toFixed(4)})`
        );
      }
    }
  }

  const card: RunCard = {
    status: blockers.length === 0 ? "READY_FOR_APPROVAL" : "BLOCKED",
    blockers,
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
            probes: models.probes,
          },
        }
      : {}),
    seed: input.seed,
    maxConcurrency: input.maxConcurrency,
    outputDir: input.outputDir,
    ...(input.approvedLimitUsd !== undefined ? { approvedLimitUsd: input.approvedLimitUsd } : {}),
    stages,
    realApiCalls: 0,
    abortConditions: [...ABORT_CONDITIONS],
    resumeCommand: `npm run gate:g:pilot -- --output ${input.outputDir} --max-cost-usd <같거나 더 큰 값> --resume`,
    generatedAt: input.generatedAt,
  };

  // 카드에 자격증명이 섞이면 승인 절차 자체가 유출 경로가 된다. 만들자마자 확인한다.
  const leaked = findSecretLike(card);
  if (leaked) {
    throw new Error(`Run Card에 비밀값처럼 보이는 값이 있습니다 (${leaked}) — 생성하지 않았습니다`);
  }
  return card;
}

export function renderRunCard(card: RunCard): string[] {
  const lines: string[] = [];
  const money = (v: number | undefined): string => (v === undefined ? "(계산 불가)" : `$${v.toFixed(2)}`);

  lines.push("=== Pilot Run Card ===");
  lines.push(`상태: ${card.status}`);
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
    for (const probe of card.models.probes) {
      lines.push(`  확인(${probe.source}): ${probe.modelId} 사용가능=${probe.available} 구조화출력=${probe.structuredOutputOk}`);
    }
    lines.push("");
  }

  for (const stage of card.stages) {
    lines.push(stage.label);
    lines.push(`  fixture ${stage.fixtureIds.length}개 × arm ${stage.arms.length}개 × 반복 ${stage.repetitions}회`);
    lines.push(`  계획 기록 수: ${stage.plannedRecords}건`);
    lines.push(`  최대 provider 호출 수: ${stage.maxProviderCalls}회 (executor 파이프라인: 초안 1 + fix loop 3)`);
    lines.push(`      검수자 호출까지 포함한 상한: ${stage.maxProviderCallsIncludingReviewer}회 — 비용 예약은 이 값을 쓴다`);
    lines.push(`  보수적 최대 비용: ${money(stage.maxCostUsd)}`);
    for (const arm of stage.perArmMaxCostUsd) {
      lines.push(`      Arm ${arm.arm}: ${money(arm.maxUsd)}`);
    }
    lines.push("");
  }

  if (card.stages[0]?.perArmMaxCostUsd[0]?.basis) {
    lines.push(`비용 산출 근거: ${card.stages[0].perArmMaxCostUsd[0].basis}`);
    lines.push("");
  }

  lines.push(`실행 순서 seed: ${card.seed}`);
  lines.push(`최대 동시 실행: ${card.maxConcurrency} (protocol v1은 순차 실행만 지원)`);
  lines.push(`출력 디렉터리: ${card.outputDir}`);
  lines.push(
    `승인 예산 상한: ${card.approvedLimitUsd === undefined ? "(미지정 — 유료 실행에는 필수)" : `$${card.approvedLimitUsd}`}`
  );
  lines.push("상한 초과 방지: 각 기록의 최대 비용을 **호출 전에 예약**하고, 예약할 수 없으면 호출하지 않는다");
  lines.push(`재개 명령: ${card.resumeCommand}`);
  lines.push("");

  lines.push("중단 조건:");
  for (const condition of card.abortConditions) lines.push(`  - ${condition}`);

  if (card.blockers.length > 0) {
    lines.push("");
    lines.push("BLOCKED — 다음이 해결되어야 승인할 수 있습니다:");
    for (const blocker of card.blockers) lines.push(`  - ${blocker}`);
  }
  return lines;
}
