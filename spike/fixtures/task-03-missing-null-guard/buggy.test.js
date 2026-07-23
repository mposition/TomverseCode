const test = require("node:test");
const assert = require("node:assert/strict");
const { getFirstName } = require("./buggy.js");

test("returns the first word of a full name", () => {
  assert.equal(getFirstName({ name: "Jane Doe" }), "Jane");
});

test("returns empty string when name is undefined", () => {
  assert.equal(getFirstName({}), "");
});

test("returns empty string when name is null", () => {
  assert.equal(getFirstName({ name: null }), "");
});
