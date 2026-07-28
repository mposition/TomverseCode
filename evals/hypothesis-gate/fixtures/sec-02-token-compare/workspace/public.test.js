const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyToken } = require("./auth.js");

test("같은 토큰은 통과", () => {
  assert.equal(verifyToken("abc123", "abc123"), true);
});

test("다른 토큰은 거부", () => {
  assert.equal(verifyToken("abc124", "abc123"), false);
});
