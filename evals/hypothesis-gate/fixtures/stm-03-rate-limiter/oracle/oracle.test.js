const test = require("node:test");
const assert = require("node:assert/strict");
const { RateLimiter } = require("./limiter.js");

test("창 경계에서 두 배가 통과하지 않는다", () => {
  const l = new RateLimiter(3, 1000);
  // 창 끝에 3개
  assert.equal(l.allow(900), true);
  assert.equal(l.allow(950), true);
  assert.equal(l.allow(999), true);
  // 다음 창 시작 직후 3개 — 고정 창이면 100ms 안에 6개가 통과한다.
  const allowedRightAfter = [1000, 1001, 1002].filter((t) => l.allow(t)).length;
  assert.ok(
    allowedRightAfter <= 0,
    `창 경계 직후 ${allowedRightAfter}개가 더 통과했습니다 — 100ms 구간에 상한의 2배가 지나갑니다`
  );
});

test("어떤 1초 구간에서도 상한을 넘지 않는다", () => {
  const l = new RateLimiter(5, 1000);
  const accepted = [];
  for (let t = 0; t < 3000; t += 50) {
    if (l.allow(t)) accepted.push(t);
  }
  for (const start of accepted) {
    const inWindow = accepted.filter((t) => t >= start && t < start + 1000).length;
    assert.ok(inWindow <= 5, `${start}ms부터 1초 안에 ${inWindow}개가 통과했습니다`);
  }
});

test("충분히 시간이 지나면 다시 허용된다", () => {
  const l = new RateLimiter(2, 1000);
  assert.equal(l.allow(0), true);
  assert.equal(l.allow(1), true);
  assert.equal(l.allow(2), false);
  assert.equal(l.allow(1500), true);
});
