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

/**
 * **프런트엔드는 브라우저 영속 저장소를 열지 않는다** — 착지 기준 `uiNeverHoldsTheKey`.
 *
 * # 왜 지금 이 검사를 만드는가
 *
 * Credential Store가 생기면서 **화면이 처음으로 키를 손에 쥔다**(입력창에서 Rust로 넘기는
 * 그 한 순간). 그 값을 `localStorage`에 넣는 것은 한 줄이고, 넣으면 "다시 입력할 필요 없어
 * 편하다"가 된다. 그리고 그 순간 키가 **디스크에 평문으로** 남는다 — 웹뷰의 저장소는 DPAPI를
 * 지나지 않는다. 착지 기준 `noPlaintextAtRest`가 금지하는 바로 그것이 앱 디렉터리가 아니라
 * 웹뷰 프로필에 생긴다.
 *
 * # 왜 저장소 API 자체를 막는가
 *
 * "키만 넣지 않으면 된다"로 좁힐 수도 있다. 그러려면 **무엇이 키인지**를 이 검사가 알아야
 * 하는데, 변수 이름으로 그걸 판정하는 것은 언제나 통과하는 방식으로 고장 난다.
 * 지금 프런트엔드는 이 API를 하나도 쓰지 않으므로 잃는 것이 없다 — 필요해지면 그때 이
 * 검사를 좁히되, **좁히는 사람이 그 결정을 내리게** 한다. 지금 열어두면 키가 그리로 갈 때
 * 아무도 모른다.
 */
test("프런트엔드는 브라우저 영속 저장소를 쓰지 않는다", () => {
  // needle을 런타임에 조립한다 — 소스에 그대로 적으면 이 파일이 자기 자신에 걸린다.
  const needles = ["local" + "Storage", "session" + "Storage", "indexed" + "DB"];
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (needles.some((n) => line.includes(n))) offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `프런트엔드가 브라우저 저장소를 씁니다: ${offenders.join(", ")} — ` +
      "자격증명이 지나는 프로세스에 영속 저장소를 열지 않습니다(착지 기준 uiNeverHoldsTheKey)"
  );
});

/**
 * **화면이 키를 저장하는 명령은 하나뿐이고, 되읽는 명령은 없다.**
 *
 * 이 검사가 보는 것은 화면이 `invoke`하는 **이름**이다. Rust 쪽에서 값이 나오지 않는다는
 * 보장은 `credentialBoundary.test.ts`가 소스로 확인하고, 여기서는 화면이 그런 이름을
 * 부르려 시도조차 하지 않는지를 본다 — 새 command를 만들면서 화면부터 쓰는 순서가 흔하다.
 */
test("화면은 자격증명 값을 되읽는 명령을 부르지 않는다", () => {
  const allowed = new Set([
    "set_provider_credential",
    "delete_provider_credential",
    // 아래 셋은 값을 돌려주지 않는다: 상태·허용 목록·무료 조회 결과다(multi-engine-routing 17절).
    "provider_status",
    "set_allowed_providers",
    "probe_providers",
  ]);
  const called = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) {
      const name = match[1]!;
      if (name.includes("credential") || name.includes("provider")) called.add(name);
    }
  }
  assert.ok(called.size > 0, "자격증명 관련 invoke를 하나도 찾지 못했습니다 — 스캔이 깨졌습니다");
  const unexpected = [...called].filter((n) => !allowed.has(n));
  assert.deepEqual(
    unexpected,
    [],
    `화면이 알려지지 않은 자격증명 명령을 부릅니다: ${unexpected.join(", ")} — ` +
      "값을 돌려주는 명령이 아닌지 확인하고, 아니라면 이 목록에 넣으세요"
  );
});
