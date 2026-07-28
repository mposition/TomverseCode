import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashDirectory, listFixtureIds, loadAllFixtures, loadFixture, parseManifest } from "../src/manifest.js";
import { touchedForbiddenPaths } from "../src/workspace.js";
import { FIXTURE_CATEGORIES } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures");

test("fixture가 24개 이상이고 8개 카테고리를 모두 덮는다", () => {
  const fixtures = loadAllFixtures(FIXTURES);
  assert.ok(fixtures.length >= 24, `fixture가 ${fixtures.length}개뿐입니다 (기준 24)`);

  const byCategory = new Map<string, number>();
  for (const fixture of fixtures) {
    byCategory.set(fixture.manifest.category, (byCategory.get(fixture.manifest.category) ?? 0) + 1);
  }
  for (const category of FIXTURE_CATEGORIES) {
    assert.ok((byCategory.get(category) ?? 0) >= 3, `${category} 카테고리가 ${byCategory.get(category) ?? 0}개뿐입니다 (기준 3)`);
  }
});

test("최소 두 개 기술 스택을 포함한다", () => {
  const languages = new Set(loadAllFixtures(FIXTURES).map((f) => f.manifest.language));
  assert.ok(languages.size >= 2, `언어가 ${[...languages].join(", ")}뿐입니다`);
});

test("모든 fixture가 oracle을 workspace 밖에 둔다", () => {
  // loadFixture가 위반 시 던지므로, 전부 로드되는 것 자체가 이 불변식의 확인이다.
  assert.doesNotThrow(() => loadAllFixtures(FIXTURES));
});

test("fixture 해시는 내용에만 의존한다 (timestamp 무관)", () => {
  const fixtures = loadAllFixtures(FIXTURES);
  const first = fixtures[0]!;
  const copy = mkdtempSync(path.join(tmpdir(), "gate-hash-"));
  try {
    cpSync(first.workspaceDir, copy, { recursive: true });
    assert.equal(hashDirectory(copy), first.fixtureHash, "복사본의 해시가 다릅니다 — timestamp에 의존합니다");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("같은 fixture를 두 번 로드하면 같은 해시", () => {
  const ids = listFixtureIds(FIXTURES);
  const a = loadFixture(FIXTURES, ids[0]!);
  const b = loadFixture(FIXTURES, ids[0]!);
  assert.equal(a.fixtureHash, b.fixtureHash);
});

test("모든 fixture의 prompt가 서로 다르다", () => {
  const prompts = loadAllFixtures(FIXTURES).map((f) => f.manifest.taskPrompt);
  assert.equal(new Set(prompts).size, prompts.length, "중복된 prompt가 있습니다");
});

test("manifest는 셸 메타문자가 든 명령을 거부한다", () => {
  assert.throws(
    () =>
      parseManifest(
        {
          fixtureId: "x",
          category: "multi_file_contract",
          language: "typescript",
          taskPrompt: "p",
          publicVerificationCommands: [{ program: "sh", args: ["node test.js; rm -rf /"] }],
          oracleVerificationCommands: [{ program: "node", args: ["--test"] }],
          forbiddenPaths: [],
          expectedInvariant: "i",
          timeoutMs: 60000,
        },
        "x"
      ),
    /셸 메타문자/
  );
});

test("manifest는 workspace 밖 cwd를 거부한다", () => {
  assert.throws(
    () =>
      parseManifest(
        {
          fixtureId: "x",
          category: "multi_file_contract",
          language: "typescript",
          taskPrompt: "p",
          publicVerificationCommands: [{ program: "node", args: ["--test"], cwd: "../.." }],
          oracleVerificationCommands: [{ program: "node", args: ["--test"] }],
          forbiddenPaths: [],
          expectedInvariant: "i",
          timeoutMs: 60000,
        },
        "x"
      ),
    /상대 경로/
  );
});

test("manifest의 fixtureId가 디렉터리 이름과 다르면 거부한다", () => {
  assert.throws(
    () =>
      parseManifest(
        {
          fixtureId: "other",
          category: "multi_file_contract",
          language: "typescript",
          taskPrompt: "p",
          publicVerificationCommands: [{ program: "node", args: ["--test"] }],
          oracleVerificationCommands: [{ program: "node", args: ["--test"] }],
          forbiddenPaths: [],
          expectedInvariant: "i",
          timeoutMs: 60000,
        },
        "x"
      ),
    /디렉터리 이름과 다릅니다/
  );
});

test("oracle 파일이 workspace에 있으면 로드가 실패한다", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-bad-fixture-"));
  try {
    const fid = "leaky";
    const root = path.join(dir, fid);
    const ids = listFixtureIds(FIXTURES);
    cpSync(path.join(FIXTURES, ids[0]!), root, { recursive: true });
    // oracle 파일을 workspace에도 놓는다 — 모델이 정답을 볼 수 있는 상태.
    writeFileSync(path.join(root, "workspace", "oracle.test.js"), "// leaked\n");
    writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")), fixtureId: fid })
    );
    assert.throws(() => loadFixture(dir, fid), /모델이 정답 테스트를 볼 수 있게 됩니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("금지 경로 판정이 디렉터리와 파일을 모두 다룬다", () => {
  assert.deepEqual(touchedForbiddenPaths(["public.test.js"], ["src/a.js", "public.test.js"]), ["public.test.js"]);
  assert.deepEqual(touchedForbiddenPaths(["tests/"], ["tests/public.rs", "src/lib.rs"]), ["tests/public.rs"]);
  assert.deepEqual(touchedForbiddenPaths(["tests"], ["tests/public.rs"]), ["tests/public.rs"]);
  assert.deepEqual(touchedForbiddenPaths(["public.test.js"], ["src/public.test.js.bak"]), []);
});

test("모든 fixture가 공개 테스트를 금지 경로로 보호한다", () => {
  // 공개 테스트를 지워서 통과하는 것을 막는 두 번째 방어선.
  // (첫 번째는 oracle이 workspace 밖에 있다는 구조 자체다.)
  for (const fixture of loadAllFixtures(FIXTURES)) {
    assert.ok(
      fixture.manifest.forbiddenPaths.length > 0,
      `${fixture.manifest.fixtureId}에 forbiddenPaths가 없습니다`
    );
  }
});
