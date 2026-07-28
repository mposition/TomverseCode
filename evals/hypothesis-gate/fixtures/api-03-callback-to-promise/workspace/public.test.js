const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAll } = require("./fetchAll.js");

test("콜백으로 결과를 받는다", (t, done) => {
  const store = new Map([["a", 1]]);
  fetchAll(store, ["a"], (err, values) => {
    assert.equal(err, null);
    assert.deepEqual(values, [1]);
    done();
  });
});
