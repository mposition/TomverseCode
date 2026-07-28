const { priceOf } = require("./pricing.js");

function cartTotal(items) {
  // priceOf가 원 단위를 준다고 생각하고 센트로 바꾼다.
  return items.reduce((sum, item) => sum + priceOf(item) * 100, 0);
}
module.exports = { cartTotal };
