// 페이지 번호는 1부터 시작한다 (README 참조).
function paginate(items, page, perPage) {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}
module.exports = { paginate };
