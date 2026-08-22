import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bannerFor, knownCodes, renderCode, reopenTarget, type BackendStatus } from "../src/lib/backendStatus.js";

/**
 * 백엔드 상태 배너 — process-architecture.md 5.1절 / 10절.
 *
 * 여기서 검증하는 실패는 화면에서 **정상으로 보인다**: 없어도 되는 배너는 그냥 배너로 보이고,
 * 눌러도 아무 일이 없는 버튼은 그냥 버튼으로 보인다.
 */

/** `name` 디렉터리를 가진 조상을 찾는다. 없으면 예외 — "없는 경로"와 "빈 결과"는 다른 사실이다. */
function findUp(name: string, from: string): string {
  let current = from;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`${from}에서 ${name} 디렉터리를 찾지 못했습니다`);
}

test("살아 있으면 배너가 없다", () => {
  assert.equal(bannerFor({ state: "alive" }), null);
});

test("워크스페이스를 안 연 것은 백엔드 고장이 아니다", () => {
  // 같은 칸에 넣으면 앱을 켜자마자 "백엔드에 문제가 있습니다"가 뜬다.
  assert.equal(bannerFor({ state: "noWorkspace" }), null);
});

/**
 * **"죽어 있다"가 곧 "사용자가 개입해야 한다"는 아니다.** 상한이 남아 있으면 다음 작업에서
 * 자동으로 다시 뜨므로 배너를 띄우면 필요 없는 조치를 요구하는 것이고, 그러면 사용자는
 * 배너를 무시하는 법을 배운다.
 */
test("자동으로 다시 뜰 상태에서는 배너를 띄우지 않는다", () => {
  assert.equal(bannerFor({ state: "willRespawn", remaining: 2 }), null);
});

/** 문장은 **코드와 파라미터에서 만든다** — Rust가 준 원문을 그대로 쓰지 않는다. */
test("개입이 필요하면 코드로 문장을 만든다", () => {
  const banner = bannerFor({
    state: "unavailable",
    code: "respawnLimit",
    params: { attempts: 2 },
    message: "(원문 — 쓰이면 안 된다)",
    recovery: "reopenWorkspace",
  });
  assert.ok(banner?.message.includes("2번"), banner?.message);
  assert.equal(banner?.untranslated, false);
  assert.notEqual(banner?.message, "(원문 — 쓰이면 안 된다)", "카탈로그를 두고 원문을 썼습니다");
  assert.equal(banner?.canReopen, true);
});

/**
 * 모르는 코드는 **원문으로 떨어진다.** 반쪽 번역은 나쁘지만, 반쪽 번역과 빈 화면 중에서는
 * 반쪽 번역이 낫다 — 빈 배너는 사용자가 앱이 멈춘 이유를 알 방법을 없앤다.
 */
test("카탈로그가 모르는 코드는 원문으로 떨어지고 그 사실을 표시한다", () => {
  const banner = bannerFor({
    state: "unavailable",
    code: "아직-없는-코드",
    params: {},
    message: "Rust가 준 원문",
    recovery: "none",
  });
  assert.equal(banner?.message, "Rust가 준 원문");
  assert.equal(banner?.untranslated, true, "번역되지 않았다는 사실을 감췄습니다");
});

test("빈 문장을 그리지 않는다", () => {
  const rendered = renderCode("아직-없는-코드", {}, "대체 문장");
  assert.ok(rendered.message.length > 0);
});

/**
 * **Rust가 내는 코드를 카탈로그가 전부 알아야 한다.**
 *
 * 모르면 원문으로 떨어지므로 앱이 깨지지는 않지만, 그 사실이 조용하면 새 코드는 영원히
 * 번역되지 않는다 — "빠진 것은 실패하지 않으므로 빠진 사실이 드러나지 않는다".
 * 판정 기준은 사람이 적은 또 다른 목록이 아니라 **Rust 소스에서 유도한 코드 목록**이다.
 */
test("Rust가 내는 모든 백엔드 코드가 카탈로그에 있다", () => {
  // 컴파일된 테스트는 `dist-test/test/`에서 돌고 원본은 `test/`에서 돌므로, **상대 경로를
  // 고정하지 않고** `src-tauri`를 가진 디렉터리를 찾아 올라간다. 못 찾으면 실패한다 —
  // 조용히 건너뛰면 이 검사는 언제나 통과하는 방식으로 고장 난다.
  const sidecarRs = findUp("src-tauri", path.dirname(fileURLToPath(import.meta.url)));
  const source = readFileSync(path.join(sidecarRs, "core", "src", "sidecar.rs"), "utf8");

  // `code()`가 돌려주는 문자열 리터럴만 뽑는다. needle을 런타임에 조립해 이 파일 자신이
  // 검색 대상이 될 때 개수가 어긋나지 않게 한다.
  const block = source.slice(source.indexOf("fn " + "code(&self)"));
  const arm = new RegExp('=> "([a-zA-Z]+)"', "g");
  const codes = [...block.slice(0, block.indexOf("\n    }")).matchAll(arm)].map((m) => m[1]!).sort();

  assert.ok(codes.length >= 3, `Rust에서 코드를 읽지 못했습니다: ${JSON.stringify(codes)}`);
  const missing = codes.filter((code) => !knownCodes().includes(code));
  assert.deepEqual(missing, [], `카탈로그에 없는 코드: ${missing.join(", ")}`);
});

/**
 * **`recovery: "none"`이면 버튼을 주지 않는다.** 프로토콜 위반은 다시 열어도 같은 위반이
 * 반복되므로 눌러도 같은 결과가 나온다 — 목록이 전진하지 않는 "더 보기"와 같은 거짓말이다.
 */
test("다시 열어도 달라지지 않는 실패에는 버튼이 없다", () => {
  const banner = bannerFor({
    state: "unavailable",
    code: "protocolViolation",
    params: { reason: "한 줄이 너무 깁니다" },
    message: "(원문)",
    recovery: "none",
  });
  assert.equal(banner?.canReopen, false, "다시 열어도 소용없는데 버튼을 줬습니다");
  // 배너 자체는 있어야 한다 — 아무 말도 안 하면 사용자는 앱이 멈춘 이유를 모른다.
  assert.ok(banner, "사유를 말하지 않았습니다");
});

/**
 * 판정을 **문장이 아니라 `recovery` 값**이 한다. 같은 문장이라도 값이 다르면 결과가 달라져야
 * 하고, 그래야 문구를 다듬을 때 버튼이 사라지지 않는다.
 */
test("버튼 여부는 문장이 아니라 recovery 값이 정한다", () => {
  const base = { state: "unavailable" as const, code: "respawnLimit", params: { attempts: 2 }, message: "x" };
  const a = bannerFor({ ...base, recovery: "reopenWorkspace" });
  const b = bannerFor({ ...base, recovery: "none" });
  assert.equal(a?.message, b?.message);
  assert.notEqual(a?.canReopen, b?.canReopen);
});

/**
 * 버튼을 그려도 **다시 열 경로를 모르면** 누를 수 없다. 그 상태에서 버튼만 그리면
 * 누른 뒤에 아무 일도 일어나지 않는다.
 */
test("다시 열 경로가 없으면 대상도 없다", () => {
  const banner = bannerFor({ state: "unavailable", code: "respawnLimit", params: {}, message: "…", recovery: "reopenWorkspace" });
  assert.equal(reopenTarget(banner, null), null);
  assert.equal(reopenTarget(banner, "   "), null, "공백만 있는 경로를 대상으로 삼았습니다");
  assert.equal(reopenTarget(banner, "C:\\work\\repo"), "C:\\work\\repo");
});

test("버튼이 없으면 경로가 있어도 대상이 없다", () => {
  const banner = bannerFor({ state: "unavailable", code: "respawnLimit", params: {}, message: "…", recovery: "none" });
  assert.equal(reopenTarget(banner, "C:\\work\\repo"), null);
});

/** 상태를 아직 못 읽은 경우(호출 실패 등)는 배너 없음이다 — 모르는 것을 고장이라고 하지 않는다. */
test("상태를 모르면 배너를 지어내지 않는다", () => {
  const unknown: BackendStatus | null = null;
  assert.equal(bannerFor(unknown), null);
});
