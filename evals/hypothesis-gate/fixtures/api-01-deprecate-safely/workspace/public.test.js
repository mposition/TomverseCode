const test = require("node:test");
const assert = require("node:assert/strict");
const { buildQuery } = require("./query.js");

test("새 형태가 동작한다", () => {
  const q = buildQuery({ sort: { field: "name", direction: "desc" } });
  assert.equal(q.field, "name");
  assert.equal(q.direction, "desc");
});
