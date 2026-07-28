// 가격은 **센트 단위 정수**로 저장한다 (부동소수점 반올림 오류를 피하려고).
const CATALOG = { apple: 150, bread: 320, milk: 249 };

function priceOf(item) {
  return CATALOG[item];
}
module.exports = { priceOf, CATALOG };
