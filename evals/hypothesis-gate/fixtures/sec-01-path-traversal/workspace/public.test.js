const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRequestPath } = require("./serve.js");

test("정상 경로는 통과한다", () => {
  const r = resolveRequestPath("/srv/www", "/index.html");
  assert.equal(r.ok, true);
  assert.ok(r.path.endsWith("index.html"));
});

test("단순 상위 탐색은 막힌다", () => {
  const r = resolveRequestPath("/srv/www", "/../etc/passwd");
  assert.ok(!r.path.includes("etc/passwd") || r.ok === false);
});
