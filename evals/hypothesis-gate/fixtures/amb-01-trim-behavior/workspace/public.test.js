const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUsername } = require("./username.js");

test("보통 이름은 통과", () => {
  assert.equal(normalizeUsername("alice").ok, true);
});

test("너무 짧으면 거부", () => {
  assert.equal(normalizeUsername("ab").ok, false);
});
