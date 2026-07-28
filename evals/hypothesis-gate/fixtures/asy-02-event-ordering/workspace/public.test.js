const test = require("node:test");
const assert = require("node:assert/strict");
const { EventBus } = require("./bus.js");

test("구독자가 이벤트를 받는다", () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  bus.emit(1);
  assert.deepEqual(seen, [1]);
});
