import test from "node:test";
import assert from "node:assert/strict";
import { bannerFor, reopenTarget, type BackendStatus } from "../src/lib/backendStatus.js";

/**
 * 백엔드 상태 배너 — process-architecture.md 5.1절 / 10절.
 *
 * 여기서 검증하는 실패는 화면에서 **정상으로 보인다**: 없어도 되는 배너는 그냥 배너로 보이고,
 * 눌러도 아무 일이 없는 버튼은 그냥 버튼으로 보인다.
 */

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

test("개입이 필요하면 사유를 그대로 보여준다", () => {
  const banner = bannerFor({
    state: "unavailable",
    reason: "백엔드가 2번 다시 시작한 뒤에도 계속 종료됩니다.",
    recovery: "reopenWorkspace",
  });
  assert.equal(banner?.message, "백엔드가 2번 다시 시작한 뒤에도 계속 종료됩니다.");
  assert.equal(banner?.canReopen, true);
});

/**
 * **`recovery: "none"`이면 버튼을 주지 않는다.** 프로토콜 위반은 다시 열어도 같은 위반이
 * 반복되므로 눌러도 같은 결과가 나온다 — 목록이 전진하지 않는 "더 보기"와 같은 거짓말이다.
 */
test("다시 열어도 달라지지 않는 실패에는 버튼이 없다", () => {
  const banner = bannerFor({
    state: "unavailable",
    reason: "백엔드와의 통신이 프로토콜 위반으로 끊겼습니다.",
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
  const reason = "같은 문장";
  const a = bannerFor({ state: "unavailable", reason, recovery: "reopenWorkspace" });
  const b = bannerFor({ state: "unavailable", reason, recovery: "none" });
  assert.equal(a?.message, b?.message);
  assert.notEqual(a?.canReopen, b?.canReopen);
});

/**
 * 버튼을 그려도 **다시 열 경로를 모르면** 누를 수 없다. 그 상태에서 버튼만 그리면
 * 누른 뒤에 아무 일도 일어나지 않는다.
 */
test("다시 열 경로가 없으면 대상도 없다", () => {
  const banner = bannerFor({ state: "unavailable", reason: "…", recovery: "reopenWorkspace" });
  assert.equal(reopenTarget(banner, null), null);
  assert.equal(reopenTarget(banner, "   "), null, "공백만 있는 경로를 대상으로 삼았습니다");
  assert.equal(reopenTarget(banner, "C:\\work\\repo"), "C:\\work\\repo");
});

test("버튼이 없으면 경로가 있어도 대상이 없다", () => {
  const banner = bannerFor({ state: "unavailable", reason: "…", recovery: "none" });
  assert.equal(reopenTarget(banner, "C:\\work\\repo"), null);
});

/** 상태를 아직 못 읽은 경우(호출 실패 등)는 배너 없음이다 — 모르는 것을 고장이라고 하지 않는다. */
test("상태를 모르면 배너를 지어내지 않는다", () => {
  const unknown: BackendStatus | null = null;
  assert.equal(bannerFor(unknown), null);
});
