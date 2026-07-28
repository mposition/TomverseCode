// 목록 질의.
//
// 예전 API: buildQuery({ sort: "name" })      — 항상 오름차순
// 새 API:   buildQuery({ sort: { field: "name", direction: "desc" } })
function buildQuery(options) {
  return {
    field: options.sort.field,
    direction: options.sort.direction,
  };
}
module.exports = { buildQuery };
