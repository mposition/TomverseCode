import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FixtureTask, TestOutcome } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Writes `candidateFileContent` as the fixture's source file alongside its
 * unmodified test file in a scratch temp dir, then runs `node --test` there.
 */
export async function runTestAgainstCandidate(
  task: FixtureTask,
  candidateFileContent: string
): Promise<TestOutcome> {
  const scratchDir = await mkdtemp(path.join(tmpdir(), `tomverse-spike-${task.id}-`));
  try {
    await Promise.all([
      writeFile(path.join(scratchDir, task.buggyFileName), candidateFileContent, "utf8"),
      writeFile(path.join(scratchDir, task.testFileName), task.testFileContent, "utf8"),
    ]);

    const testFilePath = path.join(scratchDir, task.testFileName);
    try {
      // Pass the test file directly rather than the directory: `node --test <dir>`
      // tries to require() the directory itself (MODULE_NOT_FOUND) instead of
      // discovering *.test.js files inside it.
      const { stdout, stderr } = await execFileAsync("node", ["--test", testFilePath], {
        timeout: 30_000,
      });
      return { passed: true, exitCode: 0, output: stdout + stderr };
    } catch (err: any) {
      // node --test exits non-zero on any failing test; execFile throws in that case.
      const output = (err.stdout ?? "") + (err.stderr ?? "");
      const exitCode = typeof err.code === "number" ? err.code : 1;
      return { passed: false, exitCode, output };
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
