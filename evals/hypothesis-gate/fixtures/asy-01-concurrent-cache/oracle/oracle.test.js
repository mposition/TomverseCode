const test = require("node:test");
const assert = require("node:assert/strict");
const { AsyncCache } = require("./cache.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("동시 요청이 fetch를 한 번만 부른다", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (k) => { calls += 1; await delay(20); return k.toUpperCase(); });
  const results = await Promise.all([cache.get("a"), cache.get("a"), cache.get("a")]);
  assert.deepEqual(results, ["A", "A", "A"]);
  assert.equal(calls, 1, "in-flight 요청이 합쳐지지 않았습니다");
});

test("실패한 요청은 캐시에 남지 않는다", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (k) => {
    calls += 1;
    if (calls === 1) throw new Error("일시적 실패");
    return k.toUpperCase();
  });
  await assert.rejects(() => cache.get("a"));
  assert.equal(await cache.get("a"), "A", "실패가 캐시되어 영구히 실패합니다");
  assert.equal(calls, 2);
});

test("서로 다른 키는 각각 fetch된다", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (k) => { calls += 1; await delay(5); return k; });
  await Promise.all([cache.get("a"), cache.get("b")]);
  assert.equal(calls, 2);
});
