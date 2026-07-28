const test = require("node:test");
const assert = require("node:assert/strict");
const { AsyncCache } = require("./cache.js");

test("두 번째 호출은 캐시에서 온다", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (k) => { calls += 1; return k.toUpperCase(); });
  assert.equal(await cache.get("a"), "A");
  assert.equal(await cache.get("a"), "A");
  assert.equal(calls, 1);
});
