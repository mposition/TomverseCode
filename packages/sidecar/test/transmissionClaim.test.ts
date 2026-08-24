import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 전송 투명성이 서 있는 **검사되지 않은 주장** — product-strategy.md 7절.
 *
 * # 무엇이 문제였나
 *
 * `core/src/transmission.rs`의 모듈 주석은 이렇게 말한다:
 *
 * > 모든 프롬프트가 같은 스냅샷을 싣기 때문에(`providers/prompts.ts`의 네 빌더가 전부
 * > `renderSnapshot`을 쓴다) "이 파일들이 이 공급자들 각각에게 갔다"고 말할 수 있다.
 *
 * 그 문장은 **TypeScript 코드에 대한 주장을 Rust 주석에 적어둔 것**이고 아무도 검사하지
 * 않았다. 다섯 번째 빌더가 생기거나 한 빌더가 `renderSnapshot`을 멈추면, 전송 화면은
 * **가지 않은 파일이 갔다**고 말하거나 실제로 간 파일을 빠뜨린다.
 *
 * 그리고 그 화면은 게이트 G가 실패해도 살아남는 차별화 넷 중 하나다(13절). 차별화의
 * 정확성이 사람의 기억에 달려 있으면 안 된다.
 *
 * # 판정 기준은 손으로 적은 목록이 아니다
 *
 * "네 빌더"를 여기 다시 적으면 같은 문제가 한 겹 밑으로 옮겨갈 뿐이다 — 다섯 번째가 생겨도
 * 이 목록이 안 늘면 검사는 조용히 통과한다. 그래서 **소스에서 빌더를 찾아** 대조한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 컴파일 결과가 아니라 사람이 쓰는 코드를 본다 — 우회는 소스에 들어온다.
const PROMPTS = path.resolve(__dirname, "..", "..", "src", "providers", "prompts.ts");

/** `export function buildXxxPrompt(` 를 소스에서 찾는다. */
function promptBuilders(source: string): { name: string; body: string }[] {
  // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일의 문장이 검사 대상처럼 보인다.
  const marker = "export function " + "build";
  const found: { name: string; body: string }[] = [];
  let at = source.indexOf(marker);
  while (at !== -1) {
    const nameEnd = source.indexOf("(", at);
    const name = source.slice(at + "export function ".length, nameEnd).trim();
    const next = source.indexOf(marker, at + marker.length);
    found.push({ name, body: source.slice(at, next === -1 ? source.length : next) });
    at = next;
  }
  return found;
}

test("프롬프트 빌더를 소스에서 찾을 수 있다", () => {
  const builders = promptBuilders(readFileSync(PROMPTS, "utf8"));
  // 0개면 아래 검사가 빈 집합에 대해 통과한다 — 파일이 옮겨지거나 형식이 바뀐 경우다.
  assert.ok(builders.length >= 4, `빌더를 ${builders.length}개밖에 찾지 못했습니다. prompts.ts 형식이 바뀌었습니까?`);
  for (const b of builders) assert.ok(b.name.endsWith("Prompt"), `빌더 이름이 아닙니다: ${b.name}`);
});

test("모든 프롬프트 빌더가 같은 스냅샷을 싣는다 — 전송 화면이 그 위에 서 있다", () => {
  const builders = promptBuilders(readFileSync(PROMPTS, "utf8"));
  const needle = "renderSnapshot" + "(";
  for (const builder of builders) {
    assert.ok(
      builder.body.includes(needle),
      `${builder.name}이 renderSnapshot을 쓰지 않습니다. ` +
        "그러면 transmission.rs가 '이 파일들이 각 공급자에게 갔다'고 말할 근거를 잃습니다 — " +
        "전송 화면이 가지 않은 것을 갔다고 말하거나 간 것을 빠뜨립니다(product-strategy 7절)."
    );
  }
});

test("Rust 주석이 가리키는 함수 이름이 실제로 있다", () => {
  // 이름이 바뀌면 위 두 검사는 통과하면서 Rust 주석만 낡는다. 그 갈라짐을 여기서 막는다.
  const source = readFileSync(PROMPTS, "utf8");
  assert.ok(source.includes("export function " + "renderSnapshot"), "renderSnapshot이 export되지 않습니다");
});
