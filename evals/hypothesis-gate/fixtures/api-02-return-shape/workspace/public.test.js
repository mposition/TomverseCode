const test = require("node:test");
const assert = require("node:assert/strict");
const { search } = require("./search.js");

test("결과가 있으면 배열", () => {
  const r = search(["apple", "banana"], "an");
  assert.ok(Array.isArray(r.results ?? r));
});
