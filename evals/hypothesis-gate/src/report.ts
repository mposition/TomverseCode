import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ARMS } from "./arms.js";
import { CRITERIA, describeCriteria } from "./criteria.js";
import { PRICING_SNAPSHOT_DATE } from "./preflight.js";
import type { GateEvaluation } from "./stats.js";
import type { GateRunRecord } from "./types.js";

/**
 * 산출물 생성 (§15).
 *
 * # 무엇을 저장소에 커밋하는가
 *
 * 커밋: fixture, manifest, 참조 patch, 하네스 코드, 사전 등록 기준, **비밀값 없는 집계 리포트**.
 * 커밋하지 않음: 원본 실행 기록(JSONL), 모델 응답 전문, oracle 출력.
 *
 * 이유: 원본 기록에는 모델이 생성한 코드와 명령 출력이 들어 있다. 그건 (a) 크고 (b) 저장소에
 * 영구히 남을 이유가 없으며 (c) fixture가 어떤 환경에서 돌았는지 같은 부수 정보를 담을 수 있다.
 * `reports/`는 `.gitignore`에 있고, 집계 결과만 필요하면 손으로 옮긴다.
 */

export interface ReportPaths {
  summaryJson: string;
  armCsv: string;
  pairedCsv: string;
  markdown: string;
}

export function writeReports(
  outputDir: string,
  evaluation: GateEvaluation,
  records: readonly GateRunRecord[],
  meta: { runId: string; seed: number; generatedAt: string; realApiExecuted: boolean }
): ReportPaths {
  mkdirSync(outputDir, { recursive: true });

  const summaryJson = path.join(outputDir, "summary.json");
  writeFileSync(
    summaryJson,
    JSON.stringify(
      {
        meta: { ...meta, pricingSnapshotDate: PRICING_SNAPSHOT_DATE, criteria: CRITERIA },
        verdict: evaluation.verdict,
        reasons: evaluation.reasons,
        criteriaHash: evaluation.criteriaHash,
        totals: {
          records: records.length,
          realApiRuns: evaluation.realApiRuns,
          fakeRuns: evaluation.fakeRuns,
          fixtures: evaluation.fixtureCount,
          minRepetitionsObserved: evaluation.minRepetitionsObserved,
          infrastructureFailureRate: evaluation.infrastructureFailureRate,
        },
        arms: evaluation.arms,
        strongestSingleArm: evaluation.strongestSingleArm,
        bootstrap: evaluation.bootstrap,
        contributions: evaluation.contributions,
        categoryRates: evaluation.categoryRates,
        blindInformed: {
          verdictDivergence: evaluation.blindInformedVerdictDivergence,
          oracleDivergence: evaluation.blindInformedOracleDivergence,
        },
      },
      null,
      2
    ) + "\n"
  );

  const armCsv = path.join(outputDir, "arms.csv");
  writeFileSync(
    armCsv,
    [
      "arm,label,runs,evaluableRuns,oraclePasses,oraclePassRate,publicPasses,infraFailures,meanCostUsd,costPerSuccessUsd,meanLatencyMs,p50LatencyMs,p95LatencyMs,inputTokens,outputTokens,retryRate",
      ...evaluation.arms.map((a) =>
        [
          a.arm,
          csvEscape(a.label),
          a.runs,
          a.evaluableRuns,
          a.oraclePasses,
          a.oraclePassRate.toFixed(4),
          a.publicPasses,
          a.infraFailures,
          a.meanCostUsd.toFixed(6),
          a.costPerSuccessUsd === null ? "" : a.costPerSuccessUsd.toFixed(6),
          Math.round(a.meanLatencyMs),
          Math.round(a.p50LatencyMs),
          Math.round(a.p95LatencyMs),
          a.totalInputTokens,
          a.totalOutputTokens,
          a.retryRate.toFixed(3),
        ].join(",")
      ),
    ].join("\n") + "\n"
  );

  const pairedCsv = path.join(outputDir, "paired.csv");
  writeFileSync(
    pairedCsv,
    [
      "fixtureId,category,treatmentRate,baselineRate,diff,outcome",
      ...evaluation.paired.map((p) =>
        [p.fixtureId, p.category, p.treatmentRate.toFixed(4), p.baselineRate.toFixed(4), p.diff.toFixed(4), p.outcome].join(",")
      ),
    ].join("\n") + "\n"
  );

  const markdown = path.join(outputDir, "report.md");
  writeFileSync(markdown, renderMarkdown(evaluation, records, meta));

  return { summaryJson, armCsv, pairedCsv, markdown };
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdown(
  evaluation: GateEvaluation,
  records: readonly GateRunRecord[],
  meta: { runId: string; seed: number; generatedAt: string; realApiExecuted: boolean }
): string {
  const lines: string[] = [];
  const verdictBadge =
    evaluation.verdict === "PASS" ? "✅ PASS" : evaluation.verdict === "FAIL" ? "❌ FAIL" : "⚠️ INCONCLUSIVE";

  lines.push("# 가설 게이트 G 결과", "");
  lines.push(`**판정: ${verdictBadge}**`, "");

  if (!meta.realApiExecuted) {
    lines.push(
      "> **실제 API 실험이 실행되지 않았습니다.** 아래 수치는 하네스 검증용이며 가설 판정의 근거가 아닙니다.",
      ""
    );
  }

  lines.push("## 검증하려는 가설", "");
  lines.push(
    "> 어려운 코딩 작업에서 OpenAI 초안 + 독립 Anthropic 검수가",
    "> **가장 강한 단일 모델 실행**보다 결정론적 성공률을 의미 있게 높이는가?",
    ""
  );

  lines.push("## 판정 근거", "");
  for (const reason of evaluation.reasons) lines.push(`- ${reason}`);
  lines.push("");

  lines.push("## 실행 메타", "");
  lines.push("| 항목 | 값 |", "|---|---|");
  lines.push(`| runId | \`${meta.runId}\` |`);
  lines.push(`| seed | ${meta.seed} |`);
  lines.push(`| 생성 시각 | ${meta.generatedAt} |`);
  lines.push(`| 판정 기준 해시 | \`${evaluation.criteriaHash}\` (protocol v${CRITERIA.protocolVersion}) |`);
  lines.push(`| 가격 스냅샷 기준일 | ${PRICING_SNAPSHOT_DATE} |`);
  lines.push(`| 전체 기록 | ${records.length}건 |`);
  lines.push(`| 실제 API 실행 | ${evaluation.realApiRuns}건 |`);
  lines.push(`| fake provider 실행 | ${evaluation.fakeRuns}건 (판정에서 제외) |`);
  lines.push(`| fixture 수 | ${evaluation.fixtureCount} |`);
  lines.push(`| primary arm 최소 반복 | ${evaluation.minRepetitionsObserved}회 |`);
  lines.push(`| 인프라 실패율 | ${pct(evaluation.infrastructureFailureRate)} |`);
  lines.push("");

  lines.push("## Arm 비교", "");
  lines.push(
    "| Arm | 설명 | 유효 실행 | oracle 통과 | 통과율 | 평균 비용 | 성공 1건당 비용 | p50 | p95 |",
    "|---|---|---|---|---|---|---|---|---|"
  );
  for (const arm of evaluation.arms) {
    lines.push(
      `| ${arm.arm} | ${arm.label} | ${arm.evaluableRuns} | ${arm.oraclePasses} | ${pct(arm.oraclePassRate)} | ` +
        `$${arm.meanCostUsd.toFixed(4)} | ${arm.costPerSuccessUsd === null ? "—" : `$${arm.costPerSuccessUsd.toFixed(4)}`} | ` +
        `${Math.round(arm.p50LatencyMs)}ms | ${Math.round(arm.p95LatencyMs)}ms |`
    );
  }
  lines.push("");
  if (evaluation.strongestSingleArm) {
    lines.push(`가장 강한 단일 모델 arm: **${evaluation.strongestSingleArm}**`, "");
  }

  lines.push("## Paired 비교 (fixture 단위)", "");
  if (evaluation.paired.length === 0) {
    lines.push("_paired 비교를 계산할 데이터가 없습니다._", "");
  } else {
    const wins = evaluation.paired.filter((p) => p.outcome === "win").length;
    const losses = evaluation.paired.filter((p) => p.outcome === "loss").length;
    const ties = evaluation.paired.filter((p) => p.outcome === "tie").length;
    lines.push(`승 ${wins} / 패 ${losses} / 무 ${ties}`, "");
    if (evaluation.bootstrap && !evaluation.bootstrap.insufficient) {
      const b = evaluation.bootstrap;
      lines.push(
        `paired bootstrap ${Math.round(b.confidence * 100)}% 신뢰구간: ` +
          `평균 차이 ${b.meanDiff.toFixed(3)}, [${b.lowerBound.toFixed(3)}, ${b.upperBound.toFixed(3)}] (${b.iterations}회 재추출)`,
        ""
      );
    }
    lines.push("| fixture | 카테고리 | 교차검증 | 최강 단일 | 차이 | 결과 |", "|---|---|---|---|---|---|");
    for (const p of evaluation.paired) {
      lines.push(
        `| ${p.fixtureId} | ${p.category} | ${pct(p.treatmentRate)} | ${pct(p.baselineRate)} | ${p.diff >= 0 ? "+" : ""}${(p.diff * 100).toFixed(1)}%p | ${p.outcome} |`
      );
    }
    lines.push("");
  }

  lines.push("## 검수자 기여 (oracle 기준)", "");
  lines.push("| 분류 | 뜻 | 건수 |", "|---|---|---|");
  lines.push(`| correction | 초안 실패 → 검수 후 성공 | ${evaluation.contributions.correction} |`);
  lines.push(`| harm | 초안 성공 → 검수 후 실패 | ${evaluation.contributions.harm} |`);
  lines.push(
    `| no_measurable_correction | 초안 성공 → 검수 후 성공 | ${evaluation.contributions.no_measurable_correction} |`
  );
  lines.push(`| ineffective | 초안 실패 → 검수 후 실패 | ${evaluation.contributions.ineffective} |`);
  lines.push("");
  lines.push(
    "이 분류는 **oracle 결과만으로** 정해진다. 검수자가 무슨 verdict를 냈는지는 판정에 영향을 주지 않는다 —",
    "측정 대상이 자기 점수를 매기게 하면 아무것도 측정하지 못한다.",
    ""
  );

  lines.push("## 카테고리별 통과율", "");
  if (evaluation.categoryRates.length === 0) {
    lines.push("_데이터 없음._", "");
  } else {
    lines.push("| 카테고리 | Arm | 통과율 | n |", "|---|---|---|---|");
    for (const row of evaluation.categoryRates) {
      lines.push(`| ${row.category} | ${row.arm} | ${pct(row.rate)} | ${row.n} |`);
    }
    lines.push("");
  }

  lines.push("## Blind vs Informed", "");
  if (evaluation.blindInformedVerdictDivergence === null) {
    lines.push("_Arm C/D 쌍이 없어 계산하지 않았습니다._", "");
  } else {
    lines.push(`- verdict 불일치율: ${pct(evaluation.blindInformedVerdictDivergence)}`);
    lines.push(`- oracle 결과 불일치율: ${pct(evaluation.blindInformedOracleDivergence ?? 0)}`);
    lines.push("");
  }

  lines.push("## 사전 등록된 판정 기준", "");
  lines.push("결과를 보기 전에 고정된 기준이다. 바꾸려면 protocol version을 올리고 새 실험으로 다시 돌려야 한다.", "");
  for (const line of describeCriteria()) lines.push(`- ${line}`);
  lines.push("");

  lines.push("## Arm 정의", "");
  lines.push("| Arm | 설명 | 공급자 | review mode | 초안 |", "|---|---|---|---|---|");
  for (const arm of ARMS) {
    lines.push(
      `| ${arm.arm} | ${arm.label} | ${arm.providers.join(" + ")} | ${arm.reviewMode ?? "—"} | ` +
        `${arm.draftSource === "replay" ? `Arm ${arm.draftSourceArm} 재사용` : "새로 생성"} |`
    );
  }
  lines.push("");
  lines.push(
    "Arm A/C/D는 **같은 초안**을 공유한다. 그래서 A↔C 차이는 검수 단계의 순효과이고, C↔D 차이는 review mode의 순효과다.",
    "각 arm이 초안을 새로 생성하면 초안 품질의 분산이 효과 추정에 섞인다.",
    ""
  );

  return lines.join("\n");
}
