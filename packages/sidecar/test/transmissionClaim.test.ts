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
const TRANSMISSION_RS = path.resolve(
  __dirname,
  "..","..","..","..",
  "apps","desktop","src-tauri","core","src","transmission.rs"
);

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

/**
 * **파일 목록만으로는 "무엇이 나갔는가"에 답하지 못한다** — product-strategy 7.2절.
 *
 * 전송 화면은 오랫동안 `sentFiles`와 `namedOnlyFiles`만 보여줬다. 그런데 프롬프트에는 파일
 * 말고도 여러 섹션이 실린다 — **프로젝트 규칙은 파일 전문**이고, **저장소 상태에는 커밋되지
 * 않은 변경 요약**(선정되지 않은 파일의 경로를 포함한다)이 들어간다. 둘 다 매 호출에 나가는데
 * 화면에는 없었다. 그 화면을 본 사용자는 자기 `CLAUDE.md`가 나가지 않았다고 믿게 된다.
 *
 * 고친 뒤에도 같은 일이 다시 생길 수 있다: 새 섹션을 프롬프트에 추가하면 그것도 나가는데
 * 집계는 모른다. 그래서 **섹션을 소스에서 뽑아** Rust의 분류 목록과 대조한다.
 *
 * # 축이 둘이 아니었다
 *
 * 처음에는 "집계가 설명하는가"만 물었는데, 섹션을 전부 뽑아 보니 그 문항으로는 답할 수 없는
 * 것들이 있었다. 출력 형식 규칙 같은 **우리 지시문**에는 사용자 데이터가 없고, 반대로
 * 검증 출력처럼 **나가는데 아직 세지 못하는 것**도 있다. 후자를 지시문 칸에 넣으면 거짓이고
 * 설명한다고 적으면 더 큰 거짓이라, "아직 세지 않는다"를 적어 두는 칸을 따로 만들었다.
 */

/** 섹션 제목을 정규화한다 — 제목 뒤에 붙는 내용·설명은 이름이 아니다. */
function normalizeSection(title: string): string {
  return title
    .split("\\n")[0]! // 소스에 escape로 적힌 줄바꿈
    .split("\n")[0]! // 실제 줄바꿈 (템플릿 리터럴)
    .split(" (")[0]!
    .trim();
}

/** `prompts.ts`가 프롬프트에 싣는 모든 섹션. **renderSnapshot만이 아니다** — 프롬프트에
 * 실리는 것은 전부 공급자로 나간다. */
function promptSections(): string[] {
  const source = readFileSync(PROMPTS, "utf8");
  const marker = "## ";
  const found = new Set<string>();
  for (const m of source.matchAll(/"## ([^"]+)"|`## ([^`$]+)/g)) {
    const title = normalizeSection(m[1] ?? m[2] ?? "");
    if (title.length > 0) found.add(title);
  }
  assert.ok(marker.length > 0);
  return [...found];
}

/** Rust의 분류 목록 하나를 읽는다. */
function rustList(name: string): string[] {
  const source = readFileSync(TRANSMISSION_RS, "utf8");
  const at = source.indexOf(name + ":");
  assert.notEqual(at, -1, `${name}을 찾지 못했습니다`);
  const body = source.slice(at, source.indexOf("];", at));
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

const LISTS = ["REPORTED_SECTIONS", "INSTRUCTION_SECTIONS", "UNREPORTED_SECTIONS"];

test("프롬프트 섹션과 분류 목록을 양쪽 소스에서 읽을 수 있다", () => {
  // 0개면 아래 대조가 빈 집합에 대해 통과한다 — 형식이 바뀐 경우다.
  assert.ok(promptSections().length >= 10, `프롬프트 섹션을 ${promptSections().length}개만 읽었습니다`);
  for (const name of LISTS) {
    assert.ok(rustList(name).length >= 2, `${name}을 ${rustList(name).length}개만 읽었습니다`);
  }
});

test("프롬프트에 실리는 모든 섹션이 분류되어 있다", () => {
  const classified = new Set(LISTS.flatMap(rustList));
  const unclassified = promptSections().filter((s) => !classified.has(s));
  assert.deepEqual(
    unclassified,
    [],
    `프롬프트에 실리지만 분류되지 않은 섹션이 있습니다: ${unclassified.join(", ")}. ` +
      `그 내용은 공급자로 나갑니다 — transmission.rs에서 셋 중 하나로 결정하세요: ` +
      `화면이 설명하는가(REPORTED), 우리 지시문인가(INSTRUCTION), 아직 세지 않는가(UNREPORTED). ` +
      `분류하지 않으면 화면이 말하지 않는 전송이 조용히 늘어납니다(7.2절).`
  );
});

test("한 섹션이 두 칸에 들어가지 않는다", () => {
  const seen = new Map<string, string>();
  for (const name of LISTS) {
    for (const section of rustList(name)) {
      const before = seen.get(section);
      assert.equal(before, undefined, `${section}이 ${before}와 ${name} 양쪽에 있습니다`);
      seen.set(section, name);
    }
  }
});

test("분류 목록에 적힌 섹션은 실제로 프롬프트에 있다", () => {
  // 반대 방향. 섹션이 사라졌는데 목록에 남으면 이 검사는 통과하면서 목록만 낡는다 —
  // 특히 UNREPORTED에 낡은 항목이 남으면 "아직 할 일이 있다"고 계속 말하게 된다.
  const rendered = new Set(promptSections());
  const stale = LISTS.flatMap(rustList).filter((s) => !rendered.has(s));
  assert.deepEqual(stale, [], `프롬프트에 없는 섹션이 분류 목록에 남아 있습니다: ${stale.join(", ")}`);
});
