const test = require("node:test");
const assert = require("node:assert/strict");
const { paginate } = require("./buggy.js");

test("returns exactly pageSize items for a full page", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const page = paginate(items, 3, 0);
  assert.deepEqual(page, [0, 1, 2]);
});

test("second page starts at the correct offset", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const page = paginate(items, 3, 1);
  assert.deepEqual(page, [3, 4, 5]);
});

test("last partial page returns only the remaining items", () => {
  const items = Array.from({ length: 8 }, (_, i) => i);
  const page = paginate(items, 3, 2);
  assert.deepEqual(page, [6, 7]);
});
