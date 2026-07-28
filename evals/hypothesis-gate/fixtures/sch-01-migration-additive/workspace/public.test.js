const test = require("node:test");
const assert = require("node:assert/strict");
const { migrate } = require("./migrate.js");

test("v1을 v2로 올린다", () => {
  const out = migrate({ version: 1, name: "app", retries: 3 });
  assert.equal(out.version, 2);
  assert.equal(out.limits.retries, 3);
});
