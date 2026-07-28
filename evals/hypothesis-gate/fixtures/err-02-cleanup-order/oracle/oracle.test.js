const test = require("node:test");
const assert = require("node:assert/strict");
const { ResourceScope } = require("./cleanup.js");

test("정리는 획득의 역순이다", () => {
  const scope = new ResourceScope();
  const done = [];
  scope.register("a", () => done.push("a"));
  scope.register("b", () => done.push("b"));
  scope.register("c", () => done.push("c"));
  scope.disposeAll();
  assert.deepEqual(done, ["c", "b", "a"], "역순으로 정리되지 않았습니다 — 의존 관계가 깨집니다");
});

test("하나가 실패해도 나머지는 정리된다", () => {
  const scope = new ResourceScope();
  const done = [];
  scope.register("a", () => done.push("a"));
  scope.register("b", () => { throw new Error("b 정리 실패"); });
  scope.register("c", () => done.push("c"));
  scope.disposeAll();
  assert.deepEqual(done, ["c", "a"], "실패 하나가 나머지 정리를 막았습니다 — 리소스가 샙니다");
});

test("모든 실패가 보고된다", () => {
  const scope = new ResourceScope();
  scope.register("a", () => { throw new Error("a 실패"); });
  scope.register("b", () => { throw new Error("b 실패"); });
  const result = scope.disposeAll();
  assert.equal(result.errors.length, 2, "실패가 조용히 삼켜졌습니다");
});

test("두 번 호출해도 중복 정리하지 않는다", () => {
  const scope = new ResourceScope();
  let count = 0;
  scope.register("a", () => { count += 1; });
  scope.disposeAll();
  scope.disposeAll();
  assert.equal(count, 1);
});
