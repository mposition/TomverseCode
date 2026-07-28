const test = require("node:test");
const assert = require("node:assert/strict");
const { RateLimiter } = require("./limiter.js");

test("창 안에서 상한까지 허용한다", () => {
  const l = new RateLimiter(3, 1000);
  assert.equal(l.allow(0), true);
  assert.equal(l.allow(1), true);
  assert.equal(l.allow(2), true);
  assert.equal(l.allow(3), false);
});
