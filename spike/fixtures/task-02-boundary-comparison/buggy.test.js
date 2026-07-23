const test = require("node:test");
const assert = require("node:assert/strict");
const { isAdult } = require("./buggy.js");

test("exactly 18 is considered an adult", () => {
  assert.equal(isAdult(18), true);
});

test("17 is not an adult", () => {
  assert.equal(isAdult(17), false);
});

test("25 is an adult", () => {
  assert.equal(isAdult(25), true);
});
