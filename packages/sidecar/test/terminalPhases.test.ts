import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_PHASES } from "@tomverse/protocol";

/**
 * 터미널 phase 목록이 **신뢰 경계 양쪽에 하나씩** 있다 — state-machine-and-protocol.md 2.2절.
 *
 * # "함께 유지할 것"은 검사가 아니라 부탁이다
 *
 * `core/src/store.rs`의 `is_terminal_phase()`에는 이렇게 적혀 있었다: *"Rust와 TypeScript
 * 양쪽에 같은 목록이 있으므로 한쪽만 고치면 갈라진다 — `TERMINAL_PHASES`와 함께 유지할 것."*
 * 갈라지면 Node가 터미널로 보는 phase를 Rust가 아니라고 보게 되고(또는 그 반대), 원자적
 * terminal 확정과 "정확히 한 번" 규칙이 어긋난다. 그런데 그때 실패하는 테스트가 없었다.
 *
 * 부탁이 이미 한 번 어긋난 증거도 있었다: 그 주석은 목록이 `machine.ts`에 있다고 가리켰는데
 * 실제 위치는 `packages/protocol/src/task.ts`다. **손으로 유지하는 포인터는 손으로 유지하는
 * 목록보다 먼저 낡는다.**
 *
 * # 어느 쪽도 이 파일에 다시 적지 않는다
 *
 * 기대 목록을 여기 적으면 셋이 되고, 셋이 되면 갈라질 자리도 셋이 된다. 양쪽 다 **소스에서
 * 유도해서** 대조한다 — TypeScript는 import로, Rust는 `matches!` 팔을 읽어서.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_RS = path.resolve(
  __dirname,
  "..","..","..","..",
  "apps","desktop","src-tauri","core","src","store.rs"
);

/** Rust의 `is_terminal_phase`가 터미널로 보는 phase 문자열. */
function rustTerminalPhases(): string[] {
  const source = readFileSync(STORE_RS, "utf8");
  // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일이 검사 대상처럼 보인다.
  const marker = "fn is_terminal_phase" + "(";
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${STORE_RS}에서 is_terminal_phase를 찾지 못했습니다`);
  const body = source.slice(at, source.indexOf("\n}", at));
  const arm = body.slice(body.indexOf("matches!"));
  return [...arm.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

test("Rust 쪽 터미널 목록을 소스에서 읽을 수 있다", () => {
  const rust = rustTerminalPhases();
  // 0개면 아래 비교가 "빈 집합끼리 같다"로 통과할 수 있다 — 형식이 바뀐 경우다.
  assert.ok(rust.length >= 4, `Rust에서 터미널 phase를 ${rust.length}개밖에 못 읽었습니다`);
});

test("터미널 phase 목록이 Rust와 TypeScript에서 같다", () => {
  const rust = [...rustTerminalPhases()].sort();
  const ts = [...TERMINAL_PHASES].sort();
  assert.deepEqual(
    rust,
    ts,
    "터미널 phase 목록이 갈라졌습니다. 한쪽만 고치면 Node와 Rust가 서로 다른 시점에 태스크를 " +
      "끝난 것으로 보고, 원자적 terminal 확정과 '정확히 한 번' 규칙이 어긋납니다."
  );
});

test("Rust 주석이 가리키는 위치가 실제 위치와 같다", () => {
  // 이 검사가 없으면 위 두 검사는 통과하면서 주석만 낡는다 — 실제로 그렇게 낡아 있었다.
  const source = readFileSync(STORE_RS, "utf8");
  const marker = "fn is_terminal_phase" + "(";
  const doc = source.slice(Math.max(0, source.indexOf(marker) - 900), source.indexOf(marker));
  assert.ok(
    doc.includes("protocol/src/task.ts"),
    "is_terminal_phase 주석이 TypeScript 쪽 목록의 실제 위치를 가리키지 않습니다"
  );
});
