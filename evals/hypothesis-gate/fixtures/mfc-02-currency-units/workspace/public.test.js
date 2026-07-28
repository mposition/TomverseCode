const test = require("node:test");
const assert = require("node:assert/strict");
const { cartTotal } = require("./cart.js");

test("사과 하나는 150센트", () => {
  assert.equal(cartTotal(["apple"]), 150);
});
