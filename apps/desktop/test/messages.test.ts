import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { knownCodes, render } from "../src/lib/messages.js";

/**
 * 사용자 문장 카탈로그 — ui-wireframes.md 6절.
 *
 * 여기서 검증하는 실패는 **조용하다**: 카탈로그가 모르는 코드는 원문으로 떨어져 앱이 깨지지
 * 않으므로, 아무도 알아채지 못한 채 그 문장만 영원히 번역되지 않는다.
 */

/** `name` 디렉터리를 가진 조상을 찾는다. 없으면 예외 — "없는 경로"와 "빈 결과"는 다른 사실이다. */
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

/**
 * core 전체에서 `UserFacing::code`가 돌려주는 문자열을 모은다.
 *
 * **판정 기준은 사람이 적은 목록이 아니라 소스에서 유도한 목록이다.** 새 경계를 전환하면서
 * 카탈로그를 잊으면 여기서 걸린다 — 잊었다는 사실은 런타임에는 드러나지 않는다.
 */
function codesInCore(): string[] {
  const coreSrc = path.join(findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))), "core", "src");
  const files = readdirSync(coreSrc, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => path.join(coreSrc, entry.name));
  assert.ok(files.length > 0, `core 소스를 찾지 못했습니다: ${coreSrc}`);

  // needle을 런타임에 조립한다 — 토큰을 그대로 적으면 이 파일 자신이 검색 대상이 될 때
  // 개수가 어긋난다(CLAUDE.md 함정 기록).
  const signature = "fn " + "code(&self)";
  const arm = new RegExp('=> "([a-zA-Z]+)"', "g");
  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    let cursor = source.indexOf(signature);
    while (cursor !== -1) {
      // `match` 하나가 끝나는 자리 = 함수 본문의 닫는 중괄호. 들여쓰기로 자른다.
      const body = source.slice(cursor);
      const end = body.indexOf("\n    }");
      found.push(...[...body.slice(0, end === -1 ? body.length : end).matchAll(arm)].map((m) => m[1]!));
      cursor = source.indexOf(signature, cursor + signature.length);
    }
  }
  return [...new Set(found)].sort();
}

test("Rust가 내는 모든 사용자 코드가 카탈로그에 있다", () => {
  const codes = codesInCore();
  // 빈 집합에 대해 통과하는 검사를 허용하지 않는다 — 파싱이 깨지면 "빠진 코드 없음"과
  // "코드 없음"이 같은 초록색으로 보인다.
  assert.ok(codes.length >= 6, `core에서 코드를 읽지 못했습니다: ${JSON.stringify(codes)}`);

  const missing = codes.filter((code) => !knownCodes().includes(code));
  assert.deepEqual(missing, [], `카탈로그에 없는 코드: ${missing.join(", ")}`);
});

/**
 * 반대 방향도 본다. 카탈로그에만 있고 Rust에 없는 코드는 **죽은 문장**이고, 그게 쌓이면
 * 번역할 분량이 실제보다 커 보인다.
 */
test("카탈로그에 죽은 코드가 남아 있지 않다", () => {
  const codes = codesInCore();
  const dead = knownCodes().filter((code) => !codes.includes(code));
  assert.deepEqual(dead, [], `Rust에 없는 코드가 카탈로그에 남아 있습니다: ${dead.join(", ")}`);
});

test("아는 코드는 파라미터를 끼워 문장을 만든다", () => {
  const rendered = render({ code: "respawnLimit", params: { attempts: 2 }, message: "(원문)" });
  assert.ok(rendered?.text.includes("2번"), rendered?.text);
  assert.equal(rendered?.untranslated, false);
});

/** 모르는 코드는 원문으로 떨어진다 — **빈 문장을 그리지 않는다.** */
test("모르는 코드는 원문으로 떨어지고 그 사실을 표시한다", () => {
  const rendered = render({ code: "아직-없는-코드", params: {}, message: "Rust가 준 원문" });
  assert.equal(rendered?.text, "Rust가 준 원문");
  assert.equal(rendered?.untranslated, true);
});

/** `params`가 없어도 터지지 않는다 — Rust가 `null`을 줄 수 있고, 그때 화면이 죽으면 안 된다. */
test("파라미터가 없어도 문장을 만든다", () => {
  const rendered = render({ code: "approvalGone", message: "(원문)" });
  assert.ok(rendered && rendered.text.length > 0);
  assert.equal(rendered.untranslated, false);
});

test("봉투가 없으면 아무것도 만들지 않는다", () => {
  assert.equal(render(null), null);
  assert.equal(render(undefined), null);
});
