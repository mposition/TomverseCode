import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **`#[tauri::command]`를 쓰고 등록하지 않으면 화면에서 그 명령이 없다** —
 * ui-wireframes.md 배선 규칙.
 *
 * # 왜 이 검사가 필요한가
 *
 * Tauri 명령은 두 곳에 적힌다: 함수에 `#[tauri::command]`를 붙이고, `generate_handler![...]`에
 * 이름을 넣는다. 하나만 하면 **컴파일은 통과한다** — 붙이기만 하면 "안 쓰는 함수"고, 이름만
 * 넣으면 컴파일이 깨지므로 실제로 일어나는 실수는 언제나 전자다.
 *
 * 그 실수는 조용하다. 화면이 `invoke("이름")`을 부르면 런타임에 "command not found"가 나는데,
 * 그건 **앱을 띄워야만** 보인다. 이 저장소의 개발 환경은 Linux라 tauri 껍데기 크레이트가
 * 컴파일되지도 않으므로(GUI 시스템 라이브러리 부재 — CLAUDE.md), 앱을 띄워 보는 것으로
 * 대신할 수도 없다.
 *
 * # 무엇을 검사하고 무엇을 검사하지 않는가
 *
 * 검사하는 것: 선언과 등록이 **같은 집합인가**. 양방향으로 본다 — 등록되지 않은 명령과,
 * 명령이 아닌데 등록된 이름 둘 다 잡는다.
 *
 * 검사하지 못하는 것: 화면이 `invoke`하는 이름이 실제로 존재하는가. 그건 이 검사의 반대편이고
 * (TypeScript 문자열 ↔ Rust 이름), 별도로 볼 값어치가 있지만 여기서는 하지 않는다 —
 * `invoke` 호출이 변수로 조립될 수 있어 소스에서 유도하는 것이 신뢰할 수 없다.
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

const LIB_RS = path.join(
  findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))),
  "src-tauri",
  "src",
  "lib.rs"
);

/** `#[tauri::command]`가 붙은 함수 이름들. */
function declaredCommands(): string[] {
  const source = readFileSync(LIB_RS, "utf8");
  // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일이 검사 대상처럼 보인다.
  const marker = "#[tauri::" + "command]";
  const names: string[] = [];
  let at = source.indexOf(marker);
  while (at !== -1) {
    // 속성 다음의 첫 `fn` 이름. `async fn`도 있으므로 `fn` 토큰을 찾는다.
    const after = source.slice(at + marker.length, at + marker.length + 400);
    const match = after.match(/\bfn\s+([a-z0-9_]+)\s*\(/);
    assert.ok(match, `${marker} 다음에서 함수 이름을 찾지 못했습니다: ${after.slice(0, 80)}`);
    names.push(match[1] as string);
    at = source.indexOf(marker, at + marker.length);
  }
  return names;
}

/** `generate_handler![...]`에 등록된 이름들. */
function registeredCommands(): string[] {
  const source = readFileSync(LIB_RS, "utf8");
  const marker = "generate_handler!" + "[";
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${LIB_RS}에서 명령 등록 목록을 찾지 못했습니다`);
  const end = source.indexOf("]", at);
  assert.notEqual(end, -1, "등록 목록이 닫히지 않았습니다");
  return source
    .slice(at + marker.length, end)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[a-z0-9_]+$/.test(name));
}

test("양쪽 목록을 소스에서 읽을 수 있다", () => {
  // 0개면 아래 비교가 빈 집합끼리의 비교가 된다 — 형식이 바뀐 경우다.
  assert.ok(declaredCommands().length >= 10, `선언된 명령을 ${declaredCommands().length}개만 읽었습니다`);
  assert.ok(registeredCommands().length >= 10, `등록된 명령을 ${registeredCommands().length}개만 읽었습니다`);
});

test("선언한 명령은 전부 등록되어 있다", () => {
  const registered = new Set(registeredCommands());
  const missing = declaredCommands().filter((name) => !registered.has(name));
  assert.deepEqual(
    missing,
    [],
    `등록되지 않은 명령이 있습니다: ${missing.join(", ")}. ` +
      `컴파일은 통과하지만 화면에서 부르면 런타임에 없습니다 — 앱을 띄워야만 보이는 실패입니다.`
  );
});

test("등록된 이름은 전부 실제 명령이다", () => {
  const declared = new Set(declaredCommands());
  const unknown = registeredCommands().filter((name) => !declared.has(name));
  assert.deepEqual(unknown, [], `명령이 아닌 이름이 등록되어 있습니다: ${unknown.join(", ")}`);
});

/**
 * **질문 경로의 도구 좁히기를 두 진입점이 지난다** — state-machine 51.2절, ui-wireframes 3.26절.
 *
 * 헤드리스 CLI(`bin/host.rs`)와 화면(`session.rs`)이 각자 `allowed_tools_for`를 갖는다.
 * 한 곳에 두지 못하는 이유는 그쪽이 `Args`를 보고 이쪽이 화면의 토글을 보기 때문인데,
 * **판정은 같아야 한다.** 그래서 판정 자체는 코어의 `skills::tools_for_question` 하나이고,
 * 두 진입점에 남는 것은 "질문인가"를 읽어 그 함수를 부르는 배선뿐이다.
 *
 * # 이 검사가 할 수 있는 일과 할 수 없는 일
 *
 * 이 저장소에서 `session.rs`는 **컴파일되지 않고**(tauri가 GUI 시스템 라이브러리를 요구한다 —
 * CLAUDE.md), `bin/host.rs`는 컴파일되지만 여기서는 소스로만 본다. 소스 문자열 검사는
 * **글자가 남아 있는지**만 알 수 있지 **그 글자가 살아 있는지**는 모른다 — 실제로 좁히기가
 * 이 두 파일 안에 있던 동안, 이른 return 하나(`if !question || question`)로 좁히기를 죽여도
 * 이 검사는 통과했다.
 *
 * 그래서 좁히기를 값 비교가 가능한 자리로 옮겼다. 판정의 내용(어떤 도구가 남는가, 스킬과
 * 교집합인가, `run_tests`가 되살아나지 않는가)은 `skills.rs`의 Rust 단위 테스트가 실제 값으로
 * 본다. 여기 남은 것은 소스 검사가 정직하게 할 수 있는 일뿐이다: **부르는가, 그리고
 * 여기서 다시 구현하지 않았는가.**
 */
const SESSION_RS = path.join(
  findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))),
  "src-tauri",
  "src",
  "session.rs"
);
const HOST_BIN_RS = path.join(
  findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))),
  "src-tauri",
  "core",
  "src",
  "bin",
  "host.rs"
);

test("두 진입점 모두 질문 태스크의 좁히기를 코어에 맡긴다", () => {
  for (const file of [SESSION_RS, HOST_BIN_RS]) {
    const source = readFileSync(file, "utf8");
    const marker = "fn allowed_tools_for" + "(";
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `${path.basename(file)}에 allowed_tools_for가 없습니다`);

    const body = source.slice(at, source.indexOf("\n}", at));
    // **좁히기 로직이 여기 있으면 안 된다.** 두 크레이트 모두 이 환경에서 컴파일되지 않으므로
    // 여기 두면 검사 수단이 소스 문자열뿐이고, 그건 좁히기가 **살아 있는지**가 아니라
    // **글자가 남아 있는지**만 본다 — 이른 return 하나로 죽여도 통과한다(실측).
    // 그래서 값 비교가 가능한 코어(skills.rs)로 옮겼고, 소스 검사가 정직하게 할 수 있는 일은
    // "부르는가" 하나뿐이다.
    const call = "skills::tools_for_question" + "(";
    assert.ok(body.includes(call), `${path.basename(file)}: 코어의 좁히기를 부르지 않습니다`);
    assert.ok(
      !body.includes("is_read_only"),
      `${path.basename(file)}: 좁히기를 여기서 다시 구현했습니다 — 검사할 수 없는 자리입니다`
    );

    // 그리고 정책 조립이 실제로 이 함수를 지나야 한다 — 함수만 있고 부르지 않으면 아무 일도 없다.
    const policy = source.slice(source.indexOf("fn task_policy_from"));
    assert.ok(
      policy.includes("allowed_tools: allowed_tools_for("),
      `${path.basename(file)}: task_policy_from이 좁히기를 지나지 않습니다`
    );
  }
});

/** 화면이 그 값을 **보내야** 한다 — 안 보내면 토글이 아무것도 하지 않는다. */
test("화면이 start_task에 question을 보낸다", () => {
  const app = readFileSync(
    path.join(findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))), "src", "App.tsx"),
    "utf8"
  );
  assert.ok(app.includes('question: taskKind === "question"'), "App.tsx가 question을 보내지 않습니다");
});
