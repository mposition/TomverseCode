const test = require("node:test");
const assert = require("node:assert/strict");
const { BatchWriter } = require("./writer.js");

function failingStore(failOnKey) {
  const data = new Map();
  return {
    data,
    get: (k) => data.get(k),
    has: (k) => data.has(k),
    delete: (k) => data.delete(k),
    set: (k, v) => {
      if (k === failOnKey) throw new Error(`쓰기 실패: ${k}`);
      data.set(k, v);
    },
  };
}

test("모두 성공하면 다 써진다", () => {
  const store = failingStore(null);
  const result = new BatchWriter(store).writeAll([["a", 1], ["b", 2]]);
  assert.equal(result.ok, true);
  assert.equal(store.get("a"), 1);
});

test("중간에 실패하면 아무것도 남지 않는다", () => {
  const store = failingStore("b");
  const result = new BatchWriter(store).writeAll([["a", 1], ["b", 2], ["c", 3]]);
  assert.equal(result.ok, false, "실패가 보고되지 않았습니다");
  assert.equal(store.has("a"), false, "앞서 쓴 a가 남아 있습니다 — 부분 적용됐습니다");
  assert.equal(store.has("c"), false);
});

test("기존 값이 있었다면 원래 값으로 복원된다", () => {
  const store = failingStore("b");
  store.data.set("a", "원래값");
  const result = new BatchWriter(store).writeAll([["a", "새값"], ["b", 2]]);
  assert.equal(result.ok, false);
  assert.equal(store.get("a"), "원래값", "덮어쓴 값이 복원되지 않았습니다");
});

test("실패 사유가 결과에 남는다", () => {
  const store = failingStore("b");
  const result = new BatchWriter(store).writeAll([["a", 1], ["b", 2]]);
  assert.ok(String(result.reason ?? "").includes("b"));
});
