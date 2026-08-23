import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **프런트엔드는 자격증명을 읽지 않는다** — process-architecture.md 2절 원칙 3.
 *
 * # 왜 지금 검사를 만드는가
 *
 * 지금은 프런트엔드가 하나뿐이라 이 규칙이 "React 코드가 그러지 않는다"로 지켜지고 있다.
 * 그런데 IDE 확장이 생기면 **같은 등급의 프런트엔드가 하나 더** 생기고(product-strategy 8.5절),
 * 확장 호스트는 사용자가 설치한 다른 확장과 프로세스를 공유한다 — 규칙이 깨졌을 때의 대가가
 * 지금보다 크다.
 *
 * 규칙을 사람이 기억하는 상태로 두면 두 번째 프런트엔드에서 잊는다. 그래서 **첫 번째
 * 프런트엔드에 대해 기계로 고정해 두고**, 새 프런트엔드가 생기면 이 검사를 그쪽에도 건다.
 *
 * # 무엇을 검사하고 무엇을 검사하지 않는가
 *
 * 검사하는 것: 환경변수를 **읽는 코드**가 없다는 것. 이름을 화면에 적는 것은 읽기가 아니다 —
 * 실제로 App.tsx는 "`OPENAI_API_KEY` 환경변수를 설정하세요"라고 안내한다. 문자열을 금지하면
 * 그 안내를 못 하게 되고, 그건 이 규칙이 지키려는 것과 아무 상관이 없다.
 *
 * 검사하지 못하는 것: 자격증명이 **다른 경로로** 프런트엔드에 들어오는 것(예: Rust가 이벤트에
 * 실어 보내는 경우). 그건 Rust 쪽에서 막고 있고(값은 이벤트에 남기지 않는다 —
 * state-machine 18절), 여기서 잡을 수 있는 종류가 아니다. **이 검사가 통과했다고 자격증명이
 * 화면에 없다는 뜻은 아니다.**
 */

/**
 * **컴파일된 위치가 아니라 저장소의 소스를 본다.**
 *
 * 이 테스트는 `dist-test/test/`에서 도므로 상대 경로로 `../src`를 잡으면 컴파일 산출물(.js)을
 * 가리키고, `.ts`만 세는 이 검사는 **파일 0개에 대해 통과**한다. 그래서 저장소에만 있는
 * 표식(`src-tauri`)을 위로 찾아 올라간다 — `storeAccess.test.ts`와 같은 방법이다.
 */
function findUp(name: string, from: string): string {
  let current = from;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, name))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`${from}에서 ${name}을 가진 디렉터리를 찾지 못했습니다`);
}

const SRC = path.join(findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("프런트엔드 소스가 존재한다 — 빈 집합에 대해 통과하지 않는다", () => {
  assert.ok(existsSync(SRC), `${SRC}가 없습니다`);
  assert.ok(sourceFiles(SRC).length >= 5, "소스를 읽지 못했습니다");
});

test("프런트엔드는 환경변수를 읽지 않는다", () => {
  // needle을 런타임에 조립한다 — 소스에 그대로 적으면 이 파일이 자기 자신에 걸린다.
  const needles = ["process" + ".env", "import.meta" + ".env"];
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    if (needles.some((n) => source.includes(n))) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(
    offenders,
    [],
    `프런트엔드가 환경변수를 읽습니다: ${offenders.join(", ")}. ` +
      `자격증명은 Rust만 다룬다(process-architecture 2절 원칙 3) — 이 규칙은 IDE 확장에도 그대로 적용된다.`
  );
});

/**
 * 자격증명 **이름**을 화면에 적는 것은 금지가 아니다. 이 테스트는 위 검사가 문자열까지
 * 금지하는 쪽으로 조여지는 것을 막는다 — 조이면 사용자에게 무엇을 설정해야 하는지 말할 수
 * 없게 되고, 그건 규칙이 지키려던 것과 정반대다.
 */
test("자격증명 이름을 안내 문구로 쓰는 것은 허용된다", () => {
  const mentions = sourceFiles(SRC).filter((f) => readFileSync(f, "utf8").includes("API_KEY"));
  assert.ok(mentions.length > 0, "안내 문구가 사라졌습니다 — 이 테스트가 지키려던 대상이 없습니다");
});
