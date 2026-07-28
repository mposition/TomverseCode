const test = require("node:test");
const assert = require("node:assert/strict");
const { validateOrder } = require("./validate.js");

test("완전한 v2 요청은 통과", () => {
  const r = validateOrder({ itemId: "x", quantity: 1, deliveryWindow: "morning", couponCode: "SALE" });
  assert.equal(r.ok, true);
});
