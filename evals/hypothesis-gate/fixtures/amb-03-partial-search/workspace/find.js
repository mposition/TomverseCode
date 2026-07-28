// 문서에서 검색어를 찾는다.
function findMatches(documents, term) {
  const pattern = new RegExp(term);
  return documents.filter((doc) => pattern.test(doc));
}
module.exports = { findMatches };
