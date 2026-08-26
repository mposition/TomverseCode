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
    // needle은 "읽기 전용 필터"가 아니라 **도구 목록을 여기서 다시 훑는가**다.
    // `is_read_only`로 찾으면 종류 판정 함수 이름(`is_read_only_kind`)에 걸린다 — 검사가
    // 이름의 부분 문자열에 기대면 무관한 이름 하나로 거짓 실패가 난다.
    assert.ok(
      !body.includes("ALL_TOOLS"),
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
test("화면이 start_task에 종류를 보낸다", () => {
  const app = readFileSync(
    path.join(findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))), "src", "App.tsx"),
    "utf8"
  );
  // **불리언이 아니라 종류다**(53절). 종류가 셋이 되면서 `question: boolean`으로는 표현할 수
  // 없어졌다 — 불리언을 하나 더 붙이면 둘 다 true인 상태를 타입이 허용한다.
  assert.ok(app.includes("kind: taskKind"), "App.tsx가 태스크 종류를 보내지 않습니다");
});

/**
 * **읽기 전용 종류의 판정이 한 자리에 있어야 한다** — state-machine 53절.
 *
 * 도구 좁히기와 sidecar로 보내는 값이 각자 `== "question"`을 적으면, 새 읽기 전용 종류가
 * 늘 때 한쪽만 갱신된다. 그리고 **갱신되지 않은 쪽이 좁히지 않는 쪽이면** 계획 태스크가
 * 쓰기 도구를 들고 돈다 — 그 어긋남은 컴파일도 통과하고 이 환경에서는 실행도 되지 않는다.
 */
test("두 진입점 모두 읽기 전용 종류를 한 함수로 판정한다", () => {
  for (const [file, fn] of [
    [SESSION_RS, "is_read_only_kind"],
    [HOST_BIN_RS, "is_read_only_command"],
  ] as const) {
    const source = readFileSync(file, "utf8");
    const marker = `fn ${fn}` + "(";
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `${path.basename(file)}에 ${fn}이 없습니다`);
    const body = source.slice(at, source.indexOf("\n}", at));
    assert.ok(body.includes("plan"), `${path.basename(file)}: ${fn}이 계획을 읽기 전용으로 보지 않습니다`);

    // 그리고 **그 함수 밖에서** 종류를 다시 비교하지 않는다 — 비교가 두 곳이면 갈라진다.
    const outside = source.slice(0, at) + source.slice(source.indexOf("\n}", at));
    const needle = '== "question"';
    assert.ok(!outside.includes(needle), `${path.basename(file)}: 종류 비교가 ${fn} 밖에도 있습니다`);
  }
});

/**
 * **이어 보기는 그 태스크가 돈 정책으로 물어야 한다** — state-machine 59절.
 *
 * 화면의 지금 스위치로 미리보기를 만들면 **다른 질문에 대한 답**을 `blocked`와 나란히 놓는
 * 셈이다. 사용자가 실행 뒤에 스위치를 하나 껐다면 그 미리보기는 그 태스크가 돈 정책이
 * 아니고, 그 상태에서 "예고가 어긋났다"고 말하는 것은 **우리가 만든 거짓 신호**다.
 *
 * 그래서 명령이 둘이다: `autopilot_preview`(지금 스위치)와 `task_autopilot_preview`(고정된
 * 정책). 화면이 잇는 자리에서는 후자를 불러야 한다.
 */
test("이어 보기 패널이 태스크 고정 정책의 미리보기를 부른다", () => {
  const panel = readFileSync(
    path.join(
      findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))),
      "src",
      "components",
      "BlockedPanel.tsx"
    ),
    "utf8"
  );
  const pinned = "task_autopilot_preview" + '"';
  assert.ok(panel.includes(pinned), "BlockedPanel이 고정 정책 미리보기를 부르지 않습니다");
  // **지금 스위치용 명령을 부르면 안 된다.** 그쪽은 시작 화면의 것이다.
  const live = '"autopilot_preview"';
  assert.ok(!panel.includes(live), "BlockedPanel이 화면의 지금 스위치로 미리보기를 부릅니다");
});

/** 그 명령이 **등록**돼 있어야 한다 — 붙이기만 하면 런타임에 없다(이 파일 첫 주석). */
test("고정 정책 미리보기 명령이 등록돼 있다", () => {
  assert.ok(registeredCommands().includes("task_autopilot_preview"), registeredCommands().join(", "));
  assert.ok(declaredCommands().includes("task_autopilot_preview"), declaredCommands().join(", "));
});

/**
 * **이어서 돌리기는 여기서 시작하지 않는다** — state-machine 62절.
 *
 * 한 번의 클릭이 무엇을 넓히는지를 사용자가 읽어야 하고, 그 문장은 시작 화면의 스위치 옆에
 * 있다. 정지 패널에서 바로 시작하면 **경고를 읽지 않은 채 넓어진다.**
 */
test("정지 패널이 이어서 돌리기를 스스로 시작하지 않는다", () => {
  const panel = readFileSync(
    path.join(
      findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))),
      "src",
      "components",
      "BlockedPanel.tsx"
    ),
    "utf8"
  );
  const start = '"start_task"';
  assert.ok(!panel.includes(start), "정지 패널이 태스크를 직접 시작합니다");
  // 대신 위로 넘긴다.
  assert.ok(panel.includes("onFollowUp("), "정지 패널이 이어서 돌리기를 넘기지 않습니다");
});

/** 그 연결이 **감사 기록에 남아야** 한다 — 재개가 아니라는 것이 기록에서도 읽혀야 한다. */
test("화면이 start_task에 followsUp을 보낸다", () => {
  const app = readFileSync(
    path.join(findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url))), "src", "App.tsx"),
    "utf8"
  );
  assert.ok(app.includes("followsUp: followsUp"), "App.tsx가 followsUp을 보내지 않습니다");

  const session = readFileSync(SESSION_RS, "utf8");
  const needle = '"followsUp"' + ":";
  assert.ok(session.includes(needle), "session.rs가 taskRequest에 followsUp을 넣지 않습니다");
});
