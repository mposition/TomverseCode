const test = require("node:test");
const assert = require("node:assert/strict");
const { ResourceScope } = require("./cleanup.js");

test("등록한 것이 정리된다", () => {
  const scope = new ResourceScope();
  const done = [];
  scope.register("a", () => done.push("a"));
  scope.disposeAll();
  assert.deepEqual(done, ["a"]);
});
