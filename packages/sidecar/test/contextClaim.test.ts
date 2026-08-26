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

// ---- fake와 실제 도구가 같은 사실을 내는가 (state-machine 58절) ----

const TOOLS_RS = path.resolve(
  __dirname,
  "..", "..", "..", "..",
  "apps", "desktop", "src-tauri", "core", "src", "tools", "mod.rs"
);
const FAKE_HOST = path.resolve(
  __dirname,
  "..", "..", "..", "..",
  "packages", "sidecar", "test", "helpers", "fakeHost.ts"
);

/**
 * **fake가 게으르면 검사도 게을러진다** — context-engine 13.6절, state-machine 58절.
 *
 * 단위 테스트는 전부 `FakeHost`를 통해 돈다. 그 대역이 실제 도구와 **다른 사실을 내면**
 * 검사가 실제와 다른 세계를 지킨다 — 통과해도 통과가 아니다.
 *
 * # 무엇을 대조하는가
 *
 * 값이 아니라 **어떤 사실을 내는가**다. 실제 도구의 `search_text` 응답에 있는 키가 fake의
 * 응답에도 있어야 한다. 종전에 fake는 `matches`와 `truncated`만 냈고 `skippedSecretFiles`를
 * 내지 않았는데, 하필 그 값이 58절이 읽기 시작한 값이다 — fake가 내지 않았으므로 그 값을
 * 읽는 코드를 지워도 **단위 테스트로는 아무것도 실패하지 않았을 것**이다.
 *
 * # 이 검사가 못 잡는 것
 *
 * 키가 같아도 **뜻이 다를 수 있다**(실제는 200에서 자르고 fake는 3에서 자른다 — 그건
 * 의도된 차이다). 값의 규칙까지 대조하려면 두 구현을 한 하네스에 태워야 하고, 그건
 * e2e가 하는 일이다.
 */
function searchKeysOf(source: string, open: string, close: string): string[] {
  const at = source.indexOf(open);
  assert.notEqual(at, -1, `${open}를 찾지 못했습니다`);
  const end = source.indexOf(close, at);
  assert.notEqual(end, -1, `${open} 이후 ${close}를 찾지 못했습니다`);
  const body = source.slice(at, end);
  // 두 모양을 모두 받는다: Rust의 `"키": 값`과 TypeScript의 축약 프로퍼티(`{ a, b }`).
  const quoted = [...body.matchAll(/"([a-zA-Z]+)"\s*:/g)].map((m) => m[1] as string);
  // **구분자를 소비하지 않는다.** `{ a, b, c }`에서 `{ a,`가 쉼표를 먹으면 `b`의 앞
  // 구분자가 사라져 건너뛴다 — 실제로 `truncated`를 놓쳤다.
  const shorthand = [...body.matchAll(/[{,]\s*([a-zA-Z]+)\s*(?=[,}])/g)].map((m) => m[1] as string);
  return [...new Set([...quoted, ...shorthand])];
}

test("fake의 search_text가 실제 도구와 같은 사실을 낸다", () => {
  const rust = readFileSync(TOOLS_RS, "utf8");
  // 실제 도구의 응답 조립부 — `matches`로 시작하는 json! 블록.
  const realKeys = searchKeysOf(rust, '"matches": matches,', "}),");
  assert.ok(realKeys.includes("matches"), realKeys.join(", "));
  assert.ok(realKeys.length >= 3, `실제 도구의 응답 키를 ${realKeys.length}개만 읽었습니다`);

  const fake = readFileSync(FAKE_HOST, "utf8");
  const fakeKeys = searchKeysOf(fake, "return ok({ matches", ");");

  const missing = realKeys.filter((k) => !fakeKeys.includes(k));
  assert.deepEqual(
    missing,
    [],
    `fake의 search_text가 실제 도구가 내는 사실을 빠뜨립니다: ${missing.join(", ")}. ` +
      `fake가 내지 않는 값은 단위 테스트로 검증할 수 없고, 그 값을 읽는 코드를 지워도 아무것도 실패하지 않습니다`
  );
});

/**
 * **fake의 비밀값 판정이 손으로 적힌 목록이 아니어야 한다.**
 *
 * 종전에는 `.env`만 보는 정규식이 fake 안에 따로 있었다. 실제 규칙이 늘면 fake만 뒤처지고,
 * 그러면 검사가 **실제보다 넓은 세계**를 지킨다 — 통과하는데 실제로는 막히는 상태다.
 */
test("fake가 비밀값 판정을 다시 구현하지 않는다", () => {
  const fake = readFileSync(FAKE_HOST, "utf8");
  const marker = "classifyFile" + "(";
  assert.ok(fake.includes(marker), "fake가 공용 제외 판정을 쓰지 않습니다");
  // 그리고 `.env`를 직접 보는 정규식이 남아 있지 않아야 한다.
  const needle = "\\.env" + "($";
  assert.ok(!fake.includes(needle), "fake에 손으로 적은 비밀값 정규식이 남아 있습니다");
});
