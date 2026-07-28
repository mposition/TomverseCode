const test = require("node:test");
const assert = require("node:assert/strict");
const { findMatches } = require("./find.js");

test("부분 문자열을 찾는다", () => {
  assert.deepEqual(findMatches(["hello world", "goodbye"], "world"), ["hello world"]);
});
