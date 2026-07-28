const path = require("node:path");

// 요청 경로를 루트 안의 실제 경로로 바꾼다.
function resolveRequestPath(root, requestPath) {
  // 앞의 슬래시를 떼고 이어 붙인다.
  const cleaned = requestPath.replace(/^\/+/, "");
  // ".."를 지운다.
  const safe = cleaned.split("/").filter((seg) => seg !== "..").join("/");
  const full = path.join(root, safe);
  return { ok: true, path: full };
}
module.exports = { resolveRequestPath };
