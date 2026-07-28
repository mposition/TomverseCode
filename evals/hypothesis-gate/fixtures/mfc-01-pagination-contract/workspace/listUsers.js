const { paginate } = require("./paginate.js");

// 저장소에서 온 사용자 목록을 페이지로 잘라 준다.
function listUsers(all, page, perPage) {
  // 호출자는 0-based로 넘긴다고 가정하고 1을 더한다.
  return paginate(all, page + 1, perPage);
}
module.exports = { listUsers };
