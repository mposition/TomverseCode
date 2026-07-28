const test = require("node:test");
const assert = require("node:assert/strict");
const { cartTotal } = require("./cart.js");
const { formatCents } = require("./format.js");
const { priceOf } = require("./pricing.js");

test("합계는 센트 정수다", () => {
  assert.equal(cartTotal(["apple", "bread"]), 470);
  assert.equal(cartTotal([]), 0);
  assert.equal(cartTotal(["milk", "milk", "milk"]), 747);
});

test("표시 단계에서 정확히 한 번만 나눈다", () => {
  assert.equal(formatCents(cartTotal(["apple", "bread"])), "$4.70");
  assert.equal(formatCents(cartTotal(["milk"])), "$2.49");
});

test("pricing의 단위 계약은 유지된다", () => {
  assert.equal(priceOf("apple"), 150);
});
