const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveRequestPath } = require("./serve.js");

const ROOT = "/srv/www";

// 경로 구분자는 OS마다 다르므로 문자열 포함 검사로 판정하지 않는다.
// `"/srv/www/etc/passwd".includes("etc/passwd")`는 루트 **안**의 경로를
// 탈출로 읽고, Windows에서는 구분자가 백슬래시라 아무것도 잡지 못한다.
// 정규화한 뒤 루트 안인지 보는 것만이 두 OS에서 같은 뜻이다.
function escapesRoot(result) {
  // 거부된 요청은 경로를 돌려주지 않을 수 있다 — 거부 자체가 안전하다.
  if (result.ok === false) return false;
  const root = path.resolve(ROOT);
  const full = path.resolve(result.path);
  return full !== root && !full.startsWith(root + path.sep);
}

test("정상 경로는 통과한다", () => {
  const r = resolveRequestPath(ROOT, "/index.html");
  assert.equal(r.ok, true);
  assert.equal(path.basename(r.path), "index.html");
  assert.equal(escapesRoot(r), false);
});

test("단순 상위 탐색은 막힌다", () => {
  const r = resolveRequestPath(ROOT, "/../etc/passwd");
  assert.equal(escapesRoot(r), false, "루트 밖 경로가 그대로 반환됐습니다");
});
