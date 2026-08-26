import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { declaresSection, PYTEST_SECTIONS } from "../src/context/engine.js";

/**
 * **감지가 두 곳에 있다 — 그러면 갈린다** (state-machine 49.3절).
 *
 * Rust의 `python.rs`는 **실행할 명령**을 정하고(그게 자동 승인의 근거다 — 24.5절),
 * `engine.ts`는 **프롬프트에 실을 사실**을 정한다. 이중화는 의도지만, 두 목록이 갈리면
 * 프롬프트가 없는 테스트를 있다고 하거나 있는 테스트를 없다고 한다.
 *
 * `transmissionClaim.test.ts`와 같은 모양이다: 판정 기준을 여기 다시 적지 않고 **양쪽
 * 소스에서 유도해** 대조한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_RS = path.resolve(
  __dirname,
  "..", "..", "..", "..",
  "apps", "desktop", "src-tauri", "core", "src", "python.rs"
);

/** `python.rs`의 pytest 선언 블록만 잘라낸다 — lint/typecheck 섹션이 섞이면 대조가 무의미하다. */
function pytestBlock(): string {
  const source = readFileSync(PYTHON_RS, "utf8");
  const start = source.indexOf('"pytest"');
  assert.notEqual(start, -1, "python.rs에서 pytest 선언을 찾지 못했습니다");
  const end = source.indexOf('"ruff"', start);
  assert.notEqual(end, -1, "python.rs에서 ruff 선언을 찾지 못했습니다 (형식이 바뀌었습니까?)");
  return source.slice(start, end);
}

test("pytest 선언 근거가 Rust와 Node에서 같다", () => {
  const block = pytestBlock();

  // 빈 집합에 대한 전칭 명제는 언제나 참이다 — 무엇을 셌는지 먼저 확인한다.
  assert.ok(PYTEST_SECTIONS.length >= 3, `Node 쪽 목록이 ${PYTEST_SECTIONS.length}개뿐입니다`);

  for (const [file, section] of PYTEST_SECTIONS) {
    assert.ok(block.includes(`"${file}"`), `python.rs에 ${file}이 없습니다`);
    assert.ok(block.includes(`"${section}"`), `python.rs에 ${section}이 없습니다`);
  }

  // 반대 방향 — Rust에만 있는 섹션이 있으면 프롬프트가 그 프로젝트를 "테스트 없음"으로 말한다.
  const rustSections = [...block.matchAll(/"(\[[^"]+\])"/g)].map((m) => m[1] as string);
  assert.ok(rustSections.length >= 3, `Rust 쪽 섹션을 ${rustSections.length}개만 읽었습니다`);
  const known = PYTEST_SECTIONS.map(([, section]) => section);
  const missing = rustSections.filter((s) => !known.includes(s));
  assert.deepEqual(missing, [], `Node 쪽 목록에 없는 Rust 선언: ${missing.join(", ")}`);

  // 파일 이름 축도 같은 방향으로 본다. `pytest.ini`는 섹션 없이 파일만으로 선언이다.
  assert.ok(block.includes('"pytest.ini"'), "python.rs에 pytest.ini가 없습니다");
});

/** **주석 처리된 선언을 선언으로 읽지 않는다** — 꺼 둔 도구를 우리가 켜게 된다. */
test("주석 처리된 섹션은 선언이 아니다", () => {
  assert.equal(declaresSection("[tool.pytest.ini_options]\n", "[tool.pytest.ini_options]"), true);
  assert.equal(declaresSection("# [tool.pytest.ini_options]\n", "[tool.pytest.ini_options]"), false);
  assert.equal(declaresSection("; [tool.pytest.ini_options]\n", "[tool.pytest.ini_options]"), false);
  // 들여쓰기된 줄도 선언이다 — TOML은 들여쓰기를 허용한다.
  assert.equal(declaresSection("  [tool.pytest.ini_options]\n", "[tool.pytest.ini_options]"), true);
  // 다른 섹션에 걸리지 않는다.
  assert.equal(declaresSection("[tool.ruff]\n", "[tool.pytest.ini_options]"), false);
});
