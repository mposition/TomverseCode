const test = require("node:test");
const assert = require("node:assert/strict");
const { BatchWriter } = require("./writer.js");

test("모두 성공하면 다 써진다", () => {
  const store = new Map();
  const w = new BatchWriter(store);
  w.writeAll([["a", 1], ["b", 2]]);
  assert.equal(store.get("a"), 1);
  assert.equal(store.get("b"), 2);
});
