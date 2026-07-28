const test = require("node:test");
const assert = require("node:assert/strict");
const { runWithRetries } = require("./loop.js");

test("성공하면 바로 끝난다", () => {
  const result = runWithRetries(() => "done", 3);
  assert.equal(result.status, "ok");
  assert.equal(result.value, "done");
});
