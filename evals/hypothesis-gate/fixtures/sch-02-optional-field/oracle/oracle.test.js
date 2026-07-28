const test = require("node:test");
const assert = require("node:assert/strict");
const { validateOrder } = require("./validate.js");

test("v2 요청은 계속 통과한다", () => {
  const r = validateOrder({ itemId: "x", quantity: 1, deliveryWindow: "morning", couponCode: "SALE" });
  assert.equal(r.ok, true);
});

test("새 필드가 없는 예전 요청도 통과한다", () => {
  const r = validateOrder({ itemId: "x", quantity: 2 });
  assert.equal(r.ok, true, `예전 클라이언트가 거부됩니다: ${r.errors.join(", ")}`);
});

test("필수 필드가 없으면 여전히 거부한다", () => {
  assert.equal(validateOrder({ quantity: 1 }).ok, false);
  assert.equal(validateOrder({ itemId: "x", quantity: 0 }).ok, false);
});

test("새 필드가 있으면 형식을 검사한다", () => {
  const r = validateOrder({ itemId: "x", quantity: 1, deliveryWindow: 42 });
  assert.equal(r.ok, false, "선택 필드라도 잘못된 타입은 거부해야 합니다");
});

test("null은 미지정과 같게 다룬다", () => {
  const r = validateOrder({ itemId: "x", quantity: 1, couponCode: null });
  assert.equal(r.ok, true);
});
