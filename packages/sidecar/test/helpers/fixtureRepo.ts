import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * end-to-end 테스트용 픽스처 저장소.
 *
 * 실제 파일 시스템에 만든다 — Rust Tool Runtime과 Policy Gate가 진짜 경로를 canonicalize하고
 * 진짜 명령을 실행해야 e2e가 의미가 있다.
 *
 * 이 파일이 `node:fs`를 쓰는 것은 예외가 아니다: `test/`는 sidecar 프로덕션 코드가 아니라
 * Rust 쪽 역할(테스트 환경 준비)을 대신하는 하네스다. `src/` 아래에는 `node:fs`가 없다.
 */

export interface FixtureRepo {
  root: string;
  read(relative: string): string;
  exists(relative: string): boolean;
  write(relative: string, content: string): void;
  cleanup(): void;
}

/**
 * 오프바이원 버그가 있는 작은 모듈 + 그것을 잡는 실패하는 테스트.
 * spike/fixtures/task-01-pagination-off-by-one과 같은 성격의 버그다.
 */
export const BUGGY_SOURCE = `function paginate(items, page, perPage) {
  const start = page * perPage;
  const end = start + perPage;
  return items.slice(start, end);
}

module.exports = { paginate };
`;

export const FIXED_SOURCE = `function paginate(items, page, perPage) {
  const start = (page - 1) * perPage;
  const end = start + perPage;
  return items.slice(start, end);
}

module.exports = { paginate };
`;

const TEST_SOURCE = `const test = require("node:test");
const assert = require("node:assert/strict");
const { paginate } = require("./paginate.js");

test("page 1 returns the first slice", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), [1, 2]);
});

test("page 2 returns the second slice", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), [3, 4]);
});
`;

/** 버그를 고치는 unified diff. fake 공급자가 이걸 "제안"한다. */
export const FIX_PATCH = [
  "--- a/paginate.js",
  "+++ b/paginate.js",
  "@@ -1,3 +1,3 @@",
  " function paginate(items, page, perPage) {",
  "-  const start = page * perPage;",
  "+  const start = (page - 1) * perPage;",
  "   const end = start + perPage;",
  "",
].join("\n");

/** 기존 내용과 일치하지 않는 patch — apply_patch가 실패해야 한다. */
export const MISMATCHED_PATCH = [
  "--- a/paginate.js",
  "+++ b/paginate.js",
  "@@ -1,3 +1,3 @@",
  " function paginate(items, page, perPage) {",
  "-  const start = THIS_LINE_DOES_NOT_EXIST;",
  "+  const start = (page - 1) * perPage;",
  "   const end = start + perPage;",
  "",
].join("\n");

/** workspace 밖 파일을 노리는 patch — Policy Gate가 거부해야 한다. */
export const ESCAPE_PATCH = [
  "--- a/../../../../etc/passwd",
  "+++ b/../../../../etc/passwd",
  "@@ -1,1 +1,1 @@",
  "-root:x:0:0",
  "+pwned:x:0:0",
  "",
].join("\n");

export function createFixtureRepo(options: { withPassingTest?: boolean } = {}): FixtureRepo {
  const root = mkdtempSync(path.join(tmpdir(), "tomverse-fixture-"));

  writeFileSync(path.join(root, "paginate.js"), options.withPassingTest ? FIXED_SOURCE : BUGGY_SOURCE);
  writeFileSync(path.join(root, "paginate.test.js"), TEST_SOURCE);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        version: "1.0.0",
        private: true,
        scripts: { test: "node --test paginate.test.js" },
      },
      null,
      2
    ) + "\n"
  );
  writeFileSync(
    path.join(root, "README.md"),
    "# fixture-app\n\n페이지네이션 유틸리티. `npm test`로 검증한다.\n"
  );
  // secret 파일 — 컨텍스트에 절대 들어가면 안 된다.
  writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-fixture-must-never-leak\n");
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\nignored/\n");
  mkdirSync(path.join(root, "ignored"), { recursive: true });
  writeFileSync(path.join(root, "ignored", "junk.js"), "// gitignore된 파일\n");

  return {
    root,
    read: (relative) => readFileSync(path.join(root, relative), "utf8"),
    exists: (relative) => existsSync(path.join(root, relative)),
    write: (relative, content) => writeFileSync(path.join(root, relative), content),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
