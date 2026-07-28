const test = require("node:test");
const assert = require("node:assert/strict");
const { groupByDay } = require("./daily.js");

test("같은 날은 한 버킷", () => {
  const b = groupByDay([0, 1000, 2000], 0);
  assert.equal(b.size, 1);
});
