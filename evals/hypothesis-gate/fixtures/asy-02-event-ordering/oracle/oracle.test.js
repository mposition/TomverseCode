const test = require("node:test");
const assert = require("node:assert/strict");
const { EventBus } = require("./bus.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("비동기 핸들러에서도 발행 순서가 유지된다", async () => {
  const bus = new EventBus();
  const seen = [];
  // 첫 이벤트가 느리게 처리되어도 두 번째가 추월하면 안 된다.
  bus.subscribe(async (e) => {
    await delay(e === 1 ? 30 : 1);
    seen.push(e);
  });
  await Promise.all([bus.emit(1), bus.emit(2), bus.emit(3)]);
  assert.deepEqual(seen, [1, 2, 3], "핸들러 실행이 서로 추월했습니다");
});

test("핸들러 실행이 겹치지 않는다", async () => {
  const bus = new EventBus();
  let active = 0;
  let maxActive = 0;
  bus.subscribe(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(5);
    active -= 1;
  });
  await Promise.all([bus.emit("a"), bus.emit("b"), bus.emit("c")]);
  assert.equal(maxActive, 1, "같은 구독자의 핸들러가 동시에 실행됐습니다");
});

test("한 핸들러의 실패가 다른 구독자를 막지 않는다", async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe(async () => { throw new Error("boom"); });
  bus.subscribe(async (e) => { seen.push(e); });
  await bus.emit("x");
  assert.deepEqual(seen, ["x"]);
});
