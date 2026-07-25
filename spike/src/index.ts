import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireApiKeys } from "./config.js";
import { loadFixtures } from "./fixtures.js";
import { runTask } from "./runner.js";
import type { TaskRunReport } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtMs(n: number): string {
  return `${(n / 1000).toFixed(1)}s`;
}

function printSummaryTable(reports: TaskRunReport[]): void {
  const rows = reports.map((r) => ({
    task: r.taskId,
    blind_verdict: r.dual.verdict,
    blind_pass: r.dual.test.passed ? "PASS" : "FAIL",
    informed_verdict: r.dualInformed.verdict,
    informed_pass: r.dualInformed.test.passed ? "PASS" : "FAIL",
    diverged: r.anchoring.verdictsDiverged ? "YES" : "-",
    dual_cost: fmtUsd(r.dual.costUsd),
    dual_latency: fmtMs(r.dual.latencyMs),
    baseline_pass: r.baseline.test.passed ? "PASS" : "FAIL",
    baseline_cost: fmtUsd(r.baseline.costUsd),
    baseline_latency: fmtMs(r.baseline.latencyMs),
  }));
  console.table(rows);

  const dualPassRate = reports.filter((r) => r.dual.test.passed).length / reports.length;
  const baselinePassRate = reports.filter((r) => r.baseline.test.passed).length / reports.length;
  const dualTotalCost = reports.reduce((s, r) => s + r.dual.costUsd, 0);
  const baselineTotalCost = reports.reduce((s, r) => s + r.baseline.costUsd, 0);
  const dualTotalLatency = reports.reduce((s, r) => s + r.dual.latencyMs, 0);
  const baselineTotalLatency = reports.reduce((s, r) => s + r.baseline.latencyMs, 0);

  console.log("\n=== Summary ===");
  console.log(
    `Pass rate      — dual_verification: ${(dualPassRate * 100).toFixed(0)}%  |  baseline_single_model: ${(baselinePassRate * 100).toFixed(0)}%`
  );
  console.log(
    `Total cost     — dual_verification: ${fmtUsd(dualTotalCost)}  |  baseline_single_model: ${fmtUsd(baselineTotalCost)}  (${(dualTotalCost / baselineTotalCost).toFixed(2)}x)`
  );
  console.log(
    `Total latency  — dual_verification: ${fmtMs(dualTotalLatency)}  |  baseline_single_model: ${fmtMs(baselineTotalLatency)}  (${(dualTotalLatency / baselineTotalLatency).toFixed(2)}x)`
  );

  const dualCaughtBaselineMissed = reports.filter((r) => r.dual.test.passed && !r.baseline.test.passed);
  const baselineCaughtDualMissed = reports.filter((r) => !r.dual.test.passed && r.baseline.test.passed);
  if (dualCaughtBaselineMissed.length > 0) {
    console.log(
      `\nTasks where dual_verification passed but baseline failed: ${dualCaughtBaselineMissed.map((r) => r.taskId).join(", ")}`
    );
  }
  if (baselineCaughtDualMissed.length > 0) {
    console.log(
      `Tasks where baseline passed but dual_verification failed: ${baselineCaughtDualMissed.map((r) => r.taskId).join(", ")}`
    );
  }

  // product-strategy.md 14절 지표: blind vs informed 판정 불일치율 = anchoring 크기의 직접 측정.
  const verdictDivergences = reports.filter((r) => r.anchoring.verdictsDiverged);
  const outcomeDivergences = reports.filter((r) => r.anchoring.testOutcomesDiverged);
  const informedPassRate = reports.filter((r) => r.dualInformed.test.passed).length / reports.length;

  console.log("\n=== Anchoring probe (blind vs informed review, same draft) ===");
  console.log(
    `Pass rate      — blind: ${(dualPassRate * 100).toFixed(0)}%  |  informed: ${(informedPassRate * 100).toFixed(0)}%`
  );
  console.log(
    `Verdict divergence: ${verdictDivergences.length}/${reports.length}` +
      (verdictDivergences.length > 0 ? ` — ${verdictDivergences.map((r) => r.taskId).join(", ")}` : "")
  );
  console.log(
    `Outcome divergence: ${outcomeDivergences.length}/${reports.length}` +
      (outcomeDivergences.length > 0 ? ` — ${outcomeDivergences.map((r) => r.taskId).join(", ")}` : "")
  );
  if (verdictDivergences.length === 0) {
    console.log(
      "  주의: 불일치 0은 anchoring이 없다는 증명이 아니다 — 태스크가 너무 쉬워 두 모드 모두\n" +
        "  같은 결론에 도달했을 수 있다. 어려운 픽스처에서 다시 측정해야 의미가 있다."
    );
  }
  console.log(
    "  (informed arm은 측정 전용이며 프로덕션 파이프라인에는 존재하지 않는 추가 호출이다)"
  );
}

async function main(): Promise<void> {
  requireApiKeys();

  const tasks = await loadFixtures();
  console.log(`Loaded ${tasks.length} fixture task(s): ${tasks.map((t) => t.id).join(", ")}\n`);

  const reports: TaskRunReport[] = [];
  for (const task of tasks) {
    console.log(`Running "${task.id}"...`);
    const report = await runTask(task);
    reports.push(report);
    console.log(
      `  blind: ${report.dual.verdict}/${report.dual.test.passed ? "PASS" : "FAIL"}` +
        `  |  informed: ${report.dualInformed.verdict}/${report.dualInformed.test.passed ? "PASS" : "FAIL"}` +
        `  |  baseline: ${report.baseline.test.passed ? "PASS" : "FAIL"}` +
        (report.anchoring.verdictsDiverged ? "  ← 판정 불일치" : "")
    );
  }

  console.log("");
  printSummaryTable(reports);

  const resultsDir = path.join(__dirname, "..", "results");
  await mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(reports, null, 2), "utf8");
  console.log(`\nFull results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
