const test = require("node:test");
const assert = require("node:assert/strict");
const { search } = require("./search.js");

const INDEX = ["apple", "banana", "cherry"];

test("결과가 있으면 항상 같은 형태로 준다", () => {
  const r = search(INDEX, "an");
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, ["banana"]);
});

test("결과가 없어도 배열을 준다 (null이 아니다)", () => {
  const r = search(INDEX, "zzz");
  assert.equal(r.ok, true, "빈 결과는 오류가 아닙니다");
  assert.deepEqual(r.results, [], "빈 결과에 null을 주면 호출자가 매번 방어해야 합니다");
});

test("오류는 빈 결과와 구별된다", () => {
  const r = search(INDEX, 42);
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === "string" && r.error.length > 0);
  // 오류일 때도 results를 순회할 수 있어야 한다 — 호출자의 방어 코드를 줄이는 것이 목적이다.
  assert.deepEqual(r.results, []);
});

test("반환값을 그대로 순회해도 터지지 않는다", () => {
  for (const term of ["an", "zzz", 42, null]) {
    const r = search(INDEX, term);
    assert.doesNotThrow(() => r.results.map((x) => x));
  }
});
