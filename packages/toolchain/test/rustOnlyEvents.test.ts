import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **sidecar가 낼 수 없는 이벤트**의 목록이 실제로 그 성질을 갖는지 확인한다 —
 * [state-machine 30.4절](../../../docs/design/state-machine-and-protocol.md).
 *
 * # 무엇을 지키는가
 *
 * `host.rs`의 `NODE_MAY_NOT_EMIT`은 `db.appendEvent`가 거절하는 이벤트 종류다. 그 목록의
 * 근거는 "Rust가 낸다"가 아니라 **"오케스트레이터가 관여하지 않는 사용자 행위다"**이고,
 * 그 성질이 참이라는 증거는 sidecar 소스에 있다: 그 이벤트를 낼 코드가 없다.
 *
 * 목록에 있는데 sidecar가 실제로 내고 있으면, 이 거부는 보안 장치가 아니라 **기능을 끄는
 * 버그**다. 증상이 고약한 이유는 거절이 조용하다는 점이다 — 그 이벤트를 못 남긴 오케스트레이터는
 * 대개 그 자리에서 죽지 않고, 로그에 구멍이 생긴 채 계속 돈다.
 *
 * 반대 방향(목록에 없는데 Rust만 내는 것)은 검사하지 않는다. 그건 결함이 아니라 **아직 좁히지
 * 않은 것**이고, 좁히려면 Node가 그것을 낼 이유가 없다는 판단이 먼저 필요하다.
 *
 * # 판정 기준을 손으로 적지 않는다
 *
 * 목록을 여기 한 번 더 적으면 갈라질 곳이 하나 늘어난다. 두 소스에서 유도한다:
 *
 *  - Rust의 `NODE_MAY_NOT_EMIT` 배열 (`core/src/host.rs`)
 *  - sidecar가 실제로 발행하는 이벤트 이름 (`packages/sidecar/src/**` 의 `emit("...")`)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const HOST_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src", "host.rs");
const SIDECAR_SRC = path.join(REPO_ROOT, "packages", "sidecar", "src");

/** `NODE_MAY_NOT_EMIT` 배열의 항목들. */
function rustOnlyEvents(): string[] {
  const source = readFileSync(HOST_RS, "utf8");
  const marker = "NODE_MAY_NOT_EMIT: &[&str] = &[";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${HOST_RS}에서 NODE_MAY_NOT_EMIT 정의를 찾지 못했습니다`);
  const end = source.indexOf("];", start);
  assert.notEqual(end, -1, "NODE_MAY_NOT_EMIT 배열이 닫히지 않았습니다");
  const body = source.slice(start + marker.length, end);
  return [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** sidecar가 발행하는 이벤트 이름 → 그것이 적힌 파일. */
function sidecarEmittedEvents(): Map<string, string> {
  const found = new Map<string, string>();
  // needle을 런타임에 조립한다 — 리터럴로 적으면 이 파일 자체가 검사에 걸릴 수 있다.
  const pattern = new RegExp(`${"emit"}\\(\\s*"([A-Z_]+)"`, "g");
  for (const file of tsFiles(SIDECAR_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      if (!found.has(match[1])) found.set(match[1], path.relative(REPO_ROOT, file));
    }
  }
  return found;
}

test("NODE_MAY_NOT_EMIT은 비어 있지 않다", () => {
  // 빈 집합에 대한 전칭 명제는 언제나 참이다 — 목록이 비면 아래 검사가 아무 말도 하지 않는다.
  assert.ok(rustOnlyEvents().length > 0, "거절 목록이 비었습니다");
});

/**
 * **이 검사가 공허하지 않다는 증거.** 추출이 깨져 빈 집합을 보고 있으면 위아래 단언이
 * 전부 통과한다 — sidecar가 이벤트를 실제로 내고 있다는 사실을 먼저 확인한다.
 */
test("sidecar가 발행하는 이벤트를 실제로 찾아낸다", () => {
  const emitted = sidecarEmittedEvents();
  assert.ok(emitted.size > 5, `sidecar에서 찾은 이벤트가 너무 적습니다: ${[...emitted.keys()].join(", ")}`);
  // 오케스트레이터가 정당하게 내는 것의 대표. 이게 안 잡히면 추출이 틀린 것이다.
  assert.ok(emitted.has("USER_DECISION_RECORDED"), `${[...emitted.keys()].join(", ")}`);
});

/**
 * 목록에 있는 이벤트를 sidecar가 내면 안 된다.
 *
 * **`USER_DECISION_RECORDED`가 목록에 없는 것이 이 규칙의 경계다** — 사용자가 답했다는
 * 기록이지만 오케스트레이터가 던진 질문의 회신이라 그 경로를 지나는 것이 맞다. 막으면
 * 재질문 왕복 자체가 성립하지 않는다.
 */
test("거절 목록의 이벤트는 sidecar 어디에서도 발행되지 않는다", () => {
  const emitted = sidecarEmittedEvents();
  for (const event of rustOnlyEvents()) {
    const where = emitted.get(event);
    assert.equal(
      where,
      undefined,
      `${event}은 Rust가 거절하는데 sidecar가 발행합니다 (${where}) — 보안 장치가 아니라 기능을 끄는 버그입니다`
    );
  }
});

/**
 * 오케스트레이터가 정당하게 내는 이벤트를 목록에 넣으면 안 된다.
 *
 * 위 검사와 방향이 같아 보이지만 **말하는 것이 다르다**: 위는 "지금 갈라져 있지 않다"이고,
 * 이것은 "이 규칙이 오케스트레이터 왕복을 막는 데 쓰이면 안 된다"이다. 사용자 답변을 Node가
 * 못 내게 만드는 변경은 이 단언에서 멈춘다.
 */
test("사용자 답변의 회신 경로는 거절 목록에 들어가지 않는다", () => {
  const denied = new Set(rustOnlyEvents());
  for (const event of ["USER_DECISION_RECORDED", "USER_MESSAGE_RECEIVED", "PHASE_CHANGED"]) {
    assert.ok(!denied.has(event), `${event}을 거절하면 오케스트레이터 왕복이 성립하지 않습니다`);
  }
});
