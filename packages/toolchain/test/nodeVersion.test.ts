import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **선언한 Node 요구 버전과 실제로 막는 버전이 같은가.**
 *
 * 루트 `package.json`의 `engines.node`는 선언이고, Rust `launcher.rs`의 `MIN_NODE_MAJOR`가
 * 강제다. 둘이 갈라지면 "요구한다고 적어둔 버전"과 "실제로 거부하는 버전"이 달라지는데,
 * 그 차이는 아무도 모르는 채로 남는다 — 선언만 올리면 낮은 런타임이 그대로 통과하고,
 * 강제만 올리면 요구 사항을 읽은 사람이 준비한 환경이 거부된다.
 *
 * 판정 기준을 **사람이 적은 세 번째 목록**으로 두지 않는다. 두 파일을 직접 읽어 대조한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LAUNCHER_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src", "launcher.rs");

function declaredMajor(): number {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const range = pkg.engines?.node;
  assert.ok(range, "루트 package.json에 engines.node가 없습니다");
  // `>=20`, `>=20.0.0`, `20.x` 모두 20으로 읽는다. 범위 문법을 전부 다루려는 것이 아니라,
  // **우리가 실제로 쓰는 형태**만 읽고 그 밖은 실패시킨다 — 조용히 0으로 떨어지면 이 테스트가
  // 언제나 통과하는 방식으로 고장 난다.
  const match = /^>=?\s*(\d+)|^(\d+)\./.exec(range.trim());
  assert.ok(match, `engines.node를 해석할 수 없습니다: ${range}`);
  return Number(match[1] ?? match[2]);
}

function enforcedMajor(): number {
  const source = readFileSync(LAUNCHER_RS, "utf8");
  // needle을 런타임에 조립한다 — 상수 이름을 그대로 적으면 이 파일 자신이 검색 대상이 될 때
  // 개수가 어긋난다(CLAUDE.md 함정 기록).
  const needle = new RegExp("MIN_NODE_" + "MAJOR" + ": u32 = ([0-9]+);");
  const match = needle.exec(source);
  assert.ok(match, `launcher.rs에서 최소 버전 상수를 찾지 못했습니다 — 이름이 바뀌었습니까?`);
  return Number(match[1]);
}

test("선언한 Node 요구 버전과 강제하는 버전이 같다", () => {
  const declared = declaredMajor();
  const enforced = enforcedMajor();
  assert.ok(declared > 0 && enforced > 0, `해석 결과가 비었습니다: 선언 ${declared} / 강제 ${enforced}`);
  assert.equal(
    enforced,
    declared,
    `package.json은 Node ${declared} 이상을 요구한다고 적었는데 launcher.rs는 ${enforced} 미만만 막습니다`
  );
});

/** 대조가 **실제로 무언가를 읽는지** 확인한다 — 둘 다 못 읽으면 위 테스트는 언제나 통과한다. */
test("두 값을 실제로 파일에서 읽는다", () => {
  assert.ok(readFileSync(LAUNCHER_RS, "utf8").length > 0);
  assert.ok(Number.isInteger(declaredMajor()));
  assert.ok(Number.isInteger(enforcedMajor()));
});
