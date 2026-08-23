import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 저장 계층 접근이 **실패에 이름을 붙이는가** — ui-wireframes.md 6.5절.
 *
 * # 왜 소스를 훑는가
 *
 * 이 규칙은 원래 타입이 지킨다: `with_store`가 `StoreOp`를 요구하므로 이름 없이는 저장 계층에
 * 닿을 수 없다. 그런데 **그 코드가 사는 껍데기 크레이트는 이 개발 환경에서 컴파일되지 않는다**
 * (process-architecture.md 10.3절). 즉 여기서 도는 `verify`는 그 보장에 대해 아무것도
 * 말해주지 않는다.
 *
 * 그래서 컴파일러가 잡을 것을 **한 겹 더 얕게** 여기서도 본다. 이건 타입 검사의 대체물이
 * 아니라, Windows에서 컴파일할 때까지 회귀를 늦게 발견하지 않기 위한 그물이다.
 */

function findUp(name: string, from: string): string {
  let current = from;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`${from}에서 ${name} 디렉터리를 찾지 못했습니다`);
}

function sessionSource(): string {
  const shell = findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url)));
  return readFileSync(path.join(shell, "src", "session.rs"), "utf8");
}

/** `name(` 호출의 첫 인자만 잘라낸다. 인자 안의 괄호는 세지 않는다 — 첫 콤마까지면 충분하다. */
function firstArgs(source: string, name: string): string[] {
  const needle = name + "(";
  const found: string[] = [];
  let cursor = source.indexOf(needle);
  while (cursor !== -1) {
    const start = cursor + needle.length;
    const comma = source.indexOf(",", start);
    found.push(source.slice(start, comma === -1 ? start : comma).trim());
    cursor = source.indexOf(needle, start);
  }
  return found;
}

test("저장 계층 읽기는 전부 StoreOp로 이름이 붙어 있다", () => {
  const source = sessionSource();
  // `with_store_prose`가 `with_store`에 걸리지 않도록 정의부와 산문 변형을 먼저 지운다.
  const calls = [...firstArgs(source, ".with_store"), ...firstArgs(source, ".read_store")];

  // 빈 집합에 대해 통과하는 검사를 허용하지 않는다 — 파싱이 깨지면 "위반 없음"과
  // "호출 없음"이 같은 초록색으로 보인다.
  assert.ok(calls.length >= 8, `호출을 읽지 못했습니다: ${JSON.stringify(calls)}`);

  const unnamed = calls.filter((arg) => !arg.startsWith("StoreOp::") && !arg.startsWith("op"));
  assert.deepEqual(unnamed, [], `이름 없는 저장 계층 접근: ${unnamed.join(" | ")}`);
});

/**
 * 산문으로 되돌리는 자리는 **있어도 되지만 보여야 한다.** 이 검사가 확인하는 것은 그 자리가
 * 별도 함수로 드러나 있다는 사실이다 — 봉투를 빠뜨리는 것은 보이지 않지만, 이 이름을 쓰는
 * 것은 보인다.
 */
test("봉투로 나가지 않는 자리는 별도 이름으로 드러나 있다", () => {
  const source = sessionSource();
  const prose = firstArgs(source, ".with_store_prose");
  assert.ok(prose.length > 0, "with_store_prose를 쓰는 자리가 없습니다 — 검사가 무의미해졌습니다");
  // 첫 인자는 사람이 읽는 설명이어야 한다. `StoreOp`가 오면 코드를 만들어 놓고 산문으로
  // 흘리는 것이고, 그러면 카탈로그에 도착하지 않는 코드가 생긴다.
  for (const arg of prose) {
    assert.ok(arg.startsWith('"'), `설명이 아니라 ${arg}가 왔습니다`);
  }
});
