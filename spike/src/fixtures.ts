import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureTask } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(__dirname, "..", "fixtures");

export async function loadFixtures(): Promise<FixtureTask[]> {
  const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const tasks: FixtureTask[] = [];
  for (const dirName of dirs) {
    const dir = path.join(FIXTURES_ROOT, dirName);
    const files = await readdir(dir);

    const testFileName = files.find((f) => f.endsWith(".test.js"));
    const buggyFileName = files.find((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
    const taskFileName = files.find((f) => f === "task.md");

    if (!testFileName || !buggyFileName || !taskFileName) {
      throw new Error(
        `Fixture "${dirName}" is missing one of: task.md, *.js (buggy file), *.test.js (test file). Found: ${files.join(", ")}`
      );
    }

    const [taskDescription, buggyFileContent, testFileContent] = await Promise.all([
      readFile(path.join(dir, taskFileName), "utf8"),
      readFile(path.join(dir, buggyFileName), "utf8"),
      readFile(path.join(dir, testFileName), "utf8"),
    ]);

    tasks.push({
      id: dirName,
      dir,
      taskDescription: taskDescription.trim(),
      buggyFileName,
      buggyFileContent,
      testFileName,
      testFileContent,
    });
  }

  return tasks;
}
