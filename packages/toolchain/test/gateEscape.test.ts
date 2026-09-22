import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **타임아웃 없는 게이트에는 탈출구가 하나뿐이다** — state-machine 72.11·72.12절.
 *
 * # 왜 이 검사가 필요한가
 *
 * 사용자 게이트 둘(계획 승인, 검증 체크리스트)에는 타임아웃이 없다. 72.12절이 그렇게 정한
 * 이유는 분명하다 — 10분 무응답을 거부로 읽으면 점심 먹으러 간 사이에 작업이 사라진다.
 *
 * 그 대가로 **무응답은 영원한 대기**가 된다. `UiUserGateway::request_gate`의 `recv()`에는
 * 시한이 없고, 자리를 뜬 사용자에게 남는 탈출구는 **취소뿐**이다. 그래서 태스크를 취소하는
 * 코드는 반드시 `PendingGates::cancel_waiting`까지 닿아야 한다.
 *
 * 닿지 않으면 증상이 고약하다: 취소 명령은 **성공을 돌려주고**, 구성원은 카드 앞에 그대로
 * 서 있으며, 스케줄러는 `Done`을 받지 못해 멈추고, 예약은 풀리지 않는다. 화면에는
 * "취소했습니다"라고 적힌다.
 *
 * 독립 검토가 이것을 P0로 잡았다. `cancel_task`에는 이 처리가 있었는데 `cancel_fleet`과
 * `cancel_fleet_member`에는 없었다 — **같은 규칙을 세 곳에 손으로 지키고 있었고, 두 곳이
 * 빠졌다.** 그래서 사람이 지키는 규칙을 검사로 바꾼다.
 *
 * # 무엇을 검사하지 못하는가
 *
 * `cancel_waiting`이 **올바른 task_id로** 불리는가. 그건 글자가 아니라 값의 문제이고,
 * `approvals.rs`의 단위 테스트가 그 함수의 범위(하나만 닫고 이웃은 닫지 않는다)를 지킨다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 컴파일된 자리는 `packages/toolchain/dist/test`다.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SESSION_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "src", "session.rs");

/** 검사 대상 토큰을 assertion 안에 그대로 적으면 자기 자신을 센다 — 런타임에 조립한다. */
const CANCELS_TASK = ".cancel_task" + "(";
const WAKES_GATE = "cancel_waiting" + "(";

/**
 * `pub fn` 하나의 본문. 중괄호 깊이로 끊는다 — 다음 `pub fn`까지로 자르면 **마지막 함수가
 * 파일 끝까지** 삼키고, 그러면 검사가 언제나 통과한다.
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

test("태스크를 취소하는 모든 경로가 게이트 대기도 깨운다 (72.12절)", () => {
  const source = readFileSync(SESSION_RS, "utf8");
  const cancellers = functionBodies(source).filter((fn) => fn.body.includes(CANCELS_TASK));

  // **분모가 비면 검사가 공허하다.** 함수를 끊는 방식이 깨지면 여기서 드러난다.
  assert.ok(
    cancellers.length >= 3,
    `취소하는 함수를 ${cancellers.length}개만 찾았습니다 — 본문을 끊는 방식이 깨졌습니다`
  );

  for (const fn of cancellers) {
    assert.ok(
      fn.body.includes(WAKES_GATE),
      `${fn.name}이 태스크를 취소하면서 게이트 대기를 깨우지 않습니다 — ` +
        `카드 앞에 선 태스크가 취소에 반응하지 않고, 취소 명령은 성공을 돌려줍니다(72.12절)`
    );
  }
});
