// 주문 요청 검증.
// v2에서 `deliveryWindow`와 `couponCode`를 추가했다.
function validateOrder(body) {
  const errors = [];
  if (typeof body.itemId !== "string" || body.itemId.length === 0) errors.push("itemId가 필요합니다");
  if (typeof body.quantity !== "number" || body.quantity < 1) errors.push("quantity가 1 이상이어야 합니다");
  if (typeof body.deliveryWindow !== "string") errors.push("deliveryWindow가 필요합니다");
  if (typeof body.couponCode !== "string") errors.push("couponCode가 필요합니다");
  return { ok: errors.length === 0, errors };
}
module.exports = { validateOrder };
