import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **타임아웃 없는 게이트에는 탈출구가 하나뿐이고, 그 탈출구도 한 곳에만 있어야 한다** —
 * state-machine 72.11·72.12·72.12.2절.
 *
 * # 왜 이 검사가 필요한가
 *
 * 사용자 게이트 둘(계획 승인, 검증 체크리스트)에는 타임아웃이 없다. 72.12절이 그렇게 정한
 * 이유는 분명하다 — 10분 무응답을 거부로 읽으면 점심 먹으러 간 사이에 작업이 사라진다.
 *
 * 그 대가로 **무응답은 영원한 대기**가 된다. `UiUserGateway::request_gate`의 `recv()`에는
 * 시한이 없고, 자리를 뜬 사용자에게 남는 탈출구는 **취소뿐**이다.
 *
 * 처음에는 그 탈출구를 취소 **호출자**들이 각자 기억했다. 셋 중 둘이 빠졌고(`cancel_fleet`,
 * `cancel_fleet_member`, 그리고 검사를 쓰자 `force_abandon_task`까지), **빠진 쪽은 성공을
 * 돌려주었다** — 화면에는 "취소했습니다"가 적히고 태스크는 카드 앞에 그대로 선다.
 *
 * 그래서 규칙을 호출자에서 `TaskHost::cancel_task` **하나로** 옮겼다. 이 파일은 그 자리가
 * 유지되는지, 그리고 **다시 호출자로 흩어지지 않는지**를 본다.
 *
 * # 무엇을 검사하지 못하는가
 *
 * `cancel_waiting`이 **올바른 task_id로** 불리는가. 그건 글자가 아니라 값의 문제이고,
 * `approvals.rs`의 단위 테스트가 그 함수의 범위(하나만 닫고 이웃은 닫지 않는다)를 지킨다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 컴파일된 자리는 `packages/toolchain/dist/test`다.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CORE_HOST_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src", "host.rs");
const SESSION_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "src", "session.rs");

/** 검사 대상 토큰을 assertion 안에 그대로 적으면 자기 자신을 센다 — 런타임에 조립한다. */
const WAKES_GATE = "cancel_waiting" + "(";
const CANCELS_TASK = ".cancel_task" + "(";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** 줄 주석을 뺀 소스. 막으려는 것은 **코드**이지 그것을 설명하는 문장이 아니다. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("///"))
    .join("\n");
}

/**
 * `fn` 하나의 본문. 중괄호 깊이로 끊는다 — 다음 `fn`까지로 자르면 **마지막 함수가 파일
 * 끝까지** 삼키고, 그러면 검사가 언제나 통과한다.
 */
function functionBodies(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const signature = /\n {4}(?:pub )?fn ([a-z_0-9]+)/g;
  let match: RegExpExecArray | null;
  while ((match = signature.exec(source)) !== null) {
    const open = source.indexOf("{", match.index);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push({ name: match[1]!, body: source.slice(open, end + 1) });
  }
  return out;
}

test("취소가 지나는 그 한 곳이 게이트 대기를 깨운다 (72.12.2절)", () => {
  const cancel = functionBodies(read(CORE_HOST_RS)).find((fn) => fn.name === "cancel_task");
  assert.ok(cancel, "core의 cancel_task를 찾지 못했습니다 — 본문을 끊는 방식이 깨졌습니다");
  assert.ok(
    codeOnly(cancel.body).includes(WAKES_GATE),
    "TaskHost::cancel_task가 게이트 대기를 깨우지 않습니다 — " +
      "카드 앞에 선 태스크가 취소에 반응하지 않고, 취소 명령은 성공을 돌려줍니다(72.12절)"
  );
});

test("탈출구가 다시 호출자들로 흩어지지 않는다 (72.12.2절 ①)", () => {
  // **한 번 흩어졌고 둘이 빠졌다.** 화면이 직접 부르기 시작하면 그 규칙은 다시 사람이
  // 지키는 것이 되고, 새 취소 진입점은 또 빠뜨린다.
  const source = codeOnly(read(SESSION_RS));
  assert.ok(
    !source.includes(`pending_gates.${WAKES_GATE}`),
    "화면이 게이트 대기를 직접 깨웁니다 — 규칙이 호출자마다 흩어지고, 새 진입점은 빠뜨립니다"
  );
});

test("태스크를 취소하는 모든 경로가 core의 cancel_task를 지난다", () => {
  // 위 두 검사가 성립하려면 **취소가 그 함수를 지나야** 한다. 화면이 취소 토큰을 직접
  // 만지기 시작하면 깨우는 코드를 건너뛰게 된다.
  const source = read(SESSION_RS);
  const cancellers = functionBodies(source).filter((fn) =>
    /cancel_(fleet|task|fleet_member)|force_abandon/.test(fn.name)
  );
  assert.ok(
    cancellers.length >= 4,
    `취소 관련 함수를 ${cancellers.length}개만 찾았습니다 — 본문을 끊는 방식이 깨졌습니다`
  );
  for (const fn of cancellers) {
    const body = codeOnly(fn.body);
    // 취소 토큰을 만지는 함수는 반드시 `cancel_task`를 지난다.
    if (body.includes("cancels.request(") || body.includes("CancellationRegistry")) {
      assert.ok(
        body.includes(CANCELS_TASK),
        `${fn.name}이 취소 토큰을 직접 만집니다 — 게이트를 깨우는 코드를 건너뜁니다`
      );
    }
  }
});
