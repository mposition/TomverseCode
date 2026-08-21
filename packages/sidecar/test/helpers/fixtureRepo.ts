import { execFileSync } from "node:child_process";
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

/**
 * 오래 도는 테스트 스크립트 — 취소 시나리오(A)용.
 *
 * **자기 PID를 파일에 쓴다.** 이게 핵심이다: `npm test`는 `node`를 자식으로 띄우므로
 * 직접 자식만 죽이면 이 프로세스가 살아남는다. 취소 후 이 PID가 실제로 죽었는지 확인해야
 * "프로세스 트리를 죽였다"는 주장이 검증된다 (proctree.rs).
 */
const SLOW_TEST_SOURCE = `const fs = require("node:fs");
const path = require("node:path");

fs.writeFileSync(path.join(__dirname, "slow-test.pid"), String(process.pid));
// 취소가 없으면 테스트 타임아웃까지 버틴다 — 취소가 실제로 끊었는지 시간으로도 드러난다.
setTimeout(() => {
  console.log("slow test finished without being cancelled");
}, 60_000);
`;

/**
 * 픽스처를 **실제 git 저장소**로 만든다 — 커밋 통합 e2e에 필요하다.
 *
 * 초기 커밋을 만드는 이유: 커밋이 하나도 없으면 `git status -b`가 "No commits yet on ..."을
 * 내고 브랜치 파싱이 그 문장을 브랜치 이름으로 읽는다. 실제 저장소는 대개 커밋이 있으므로,
 * 그 상태를 재현하는 편이 테스트가 검증하는 상황에 가깝다.
 *
 * `user.email`/`user.name`을 저장소 로컬로 박는 이유: CI나 컨테이너에는 전역 git identity가
 * 없는 경우가 흔하고, 그러면 `git commit`이 실패한다 — **테스트하려는 것과 무관한 이유로**
 * 실패하는 것이 가장 나쁘다. `commit.gpgsign=false`도 같은 이유다(서명 키가 없으면 실패한다).
 */
function initGitRepo(root: string): void {
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Tomverse Fixture"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "-m", "initial"]);
}

export function createFixtureRepo(
  options: { withPassingTest?: boolean; slowTest?: boolean; gitRepo?: boolean } = {}
): FixtureRepo {
  const root = mkdtempSync(path.join(tmpdir(), "tomverse-fixture-"));

  writeFileSync(path.join(root, "paginate.js"), options.withPassingTest ? FIXED_SOURCE : BUGGY_SOURCE);
  writeFileSync(path.join(root, "paginate.test.js"), TEST_SOURCE);
  if (options.slowTest) writeFileSync(path.join(root, "slow-test.js"), SLOW_TEST_SOURCE);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        version: "1.0.0",
        private: true,
        scripts: { test: options.slowTest ? "node slow-test.js" : "node --test paginate.test.js" },
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

  if (options.gitRepo) {
    initGitRepo(root);
  }

  return {
    root,
    read: (relative) => readFileSync(path.join(root, relative), "utf8"),
    exists: (relative) => existsSync(path.join(root, relative)),
    write: (relative, content) => writeFileSync(path.join(root, relative), content),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
