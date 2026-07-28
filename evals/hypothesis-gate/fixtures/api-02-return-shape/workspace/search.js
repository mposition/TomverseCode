// 검색.
//
// 지금은 결과가 없으면 null, 오류면 문자열을 반환한다 — 호출자가 세 가지를 구별해야 한다.
function search(index, term) {
  if (typeof term !== "string") return "잘못된 검색어";
  const hits = index.filter((entry) => entry.includes(term));
  if (hits.length === 0) return null;
  return hits;
}
module.exports = { search };
