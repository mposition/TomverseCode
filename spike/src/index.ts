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
    dual_verdict: r.dual.verdict,
    dual_pass: r.dual.test.passed ? "PASS" : "FAIL",
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
      `  dual_verification: ${report.dual.verdict} / ${report.dual.test.passed ? "PASS" : "FAIL"}` +
        `  |  baseline: ${report.baseline.test.passed ? "PASS" : "FAIL"}`
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
