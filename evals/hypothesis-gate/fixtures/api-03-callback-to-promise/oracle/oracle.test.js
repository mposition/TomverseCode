const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAll } = require("./fetchAll.js");

const store = new Map([["a", 1], ["b", 2]]);

test("콜백 호출자가 계속 동작한다", (t, done) => {
  fetchAll(store, ["a", "b"], (err, values) => {
    assert.equal(err, null);
    assert.deepEqual(values, [1, 2]);
    done();
  });
});

test("콜백 없이 부르면 Promise를 준다", async () => {
  const values = await fetchAll(store, ["a", "b"]);
  assert.deepEqual(values, [1, 2], "콜백을 생략했을 때 Promise가 아닙니다");
});

test("Promise 경로에서 오류는 reject된다", async () => {
  await assert.rejects(() => fetchAll(store, ["zzz"]), /없는 키/);
});

test("콜백 경로에서 오류는 첫 인자로 온다", (t, done) => {
  fetchAll(store, ["zzz"], (err, values) => {
    assert.ok(err instanceof Error);
    assert.equal(values, undefined);
    done();
  });
});

test("콜백을 준 경우 Promise를 반환하지 않는다", () => {
  const returned = fetchAll(store, ["a"], () => undefined);
  assert.equal(returned, undefined, "콜백 경로에서 unhandled rejection의 원인이 될 Promise를 만들면 안 됩니다");
});
