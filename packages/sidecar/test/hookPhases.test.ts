import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 훅을 걸 수 있는 phase 목록이 **실제 `TaskPhase`의 부분집합인지** 확인한다 —
 * state-machine-and-protocol.md 25.2절.
 *
 * # 왜 이 검사가 필요한가
 *
 * `HOOKABLE_PHASES`(Rust)는 사용자가 `--hook <phase>=...`에 쓸 수 있는 이름이고, 그 이름은
 * Node가 `PHASE_CHANGED` 이벤트에 싣는 `to` 값과 **글자 그대로** 비교된다. 한쪽에서 phase
 * 이름이 바뀌거나 사라지면 그 훅은 등록은 되는데 **영원히 안 돈다.**
 *
 * 그 실패는 조용하다. 사용자에게는 "훅이 동작하지 않는다"로만 보이고, 원인이 우리 쪽 이름
 * 변경이라는 것을 알 방법이 없다. 등록 시점의 `validate_hooks`도 이걸 못 잡는다 — 그건
 * `HOOKABLE_PHASES`와 대조할 뿐이고, 낡은 쪽이 바로 그 목록이기 때문이다.
 *
 * # 목록을 여기 다시 적지 않는다
 *
 * 기대 목록을 이 파일에 적으면 갈라질 자리가 셋이 된다. 양쪽 다 **소스에서 유도한다** —
 * 터미널 phase 목록에 대해 `terminalPhases.test.ts`가 하는 것과 같은 처리다.
 *
 * # 이 검사가 못 잡는 것
 *
 * 이름이 같은데 **의미가 달라진 경우**는 못 잡는다. `VERIFYING`이 검증 전이 아니라 검증 후에
 * 들어가도록 바뀌면 훅은 계속 돌지만 사용자가 기대한 시점이 아니다. 그건 문장을 읽어야 아는
 * 일이고, 여기서 하는 것은 가장 자주 일어나는 어긋남을 자동으로 막는 것이다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// **컴파일된 위치 기준이다** — 이 파일은 `dist/test/`에서 돈다. 소스 트리 기준으로 세면
// 경로가 조용히 어긋나고, 그러면 파일을 못 읽는다(그건 다행히 시끄러운 실패다).
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HOOKS_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src", "hooks.rs");
const TASK_TS = path.join(REPO_ROOT, "packages", "protocol", "src", "task.ts");

/** Rust가 훅을 걸 수 있다고 말하는 phase들. */
function hookablePhases(): string[] {
  const source = readFileSync(HOOKS_RS, "utf8");
  // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일이 검사 대상처럼 보인다.
  const marker = "HOOKABLE_PHASES" + ":";
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${HOOKS_RS}에서 훅 가능 phase 목록을 찾지 못했습니다`);
  const body = source.slice(at, source.indexOf("];", at));
  return [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

/** TypeScript `TaskPhase` 유니언이 담고 있는 모든 phase. */
function allTaskPhases(): string[] {
  const source = readFileSync(TASK_TS, "utf8");
  const marker = "export type TaskPhase";
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${TASK_TS}에서 TaskPhase를 찾지 못했습니다`);
  // 유니언은 다음 선언 전까지다. `;`로 끝나므로 거기서 자른다.
  const body = source.slice(at, source.indexOf(";", at));
  return [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

test("양쪽 목록을 소스에서 읽을 수 있다", () => {
  // 0개면 아래 부분집합 검사가 "빈 집합은 무엇의 부분집합이든 참"으로 통과한다.
  // **가장 나쁜 실패 방식이다** — 형식이 바뀌어 아무것도 못 읽었는데 초록으로 보인다.
  assert.ok(hookablePhases().length >= 4, `Rust에서 훅 가능 phase를 ${hookablePhases().length}개만 읽었습니다`);
  assert.ok(allTaskPhases().length >= 8, `TypeScript에서 TaskPhase를 ${allTaskPhases().length}개만 읽었습니다`);
});

test("훅을 걸 수 있는 phase는 전부 실제 TaskPhase다", () => {
  const all = new Set(allTaskPhases());
  const missing = hookablePhases().filter((p) => !all.has(p));
  assert.deepEqual(
    missing,
    [],
    `훅 가능 목록에 실제로 존재하지 않는 phase가 있습니다: ${missing.join(", ")}. ` +
      `그 훅은 등록은 되지만 영원히 돌지 않고, 사용자는 원인을 알 방법이 없습니다.`
  );
});

test("훅 가능 목록은 TaskPhase의 진부분집합이다", () => {
  // 전부와 같아지면 목록을 좁혀 둔 의도(사용자가 걸 만한 자리만 연다)가 사라진 것이다 —
  // 그때는 이 검사가 아니라 25.2절의 결정을 다시 봐야 한다.
  const hookable = hookablePhases();
  assert.ok(
    hookable.length < allTaskPhases().length,
    "훅 가능 목록이 TaskPhase 전체와 같아졌습니다 — 좁혀 둔 이유(25.2절)를 다시 확인하세요"
  );
});
