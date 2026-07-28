const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveRequestPath } = require("./serve.js");

const ROOT = path.resolve("/srv/www");

function escapes(requestPath) {
  const r = resolveRequestPath(ROOT, requestPath);
  if (r.ok === false) return false;
  return !path.resolve(r.path).startsWith(ROOT + path.sep) && path.resolve(r.path) !== ROOT;
}

test("정상 경로는 계속 동작한다", () => {
  const r = resolveRequestPath(ROOT, "/assets/app.js");
  assert.equal(r.ok, true);
  assert.equal(path.resolve(r.path), path.join(ROOT, "assets", "app.js"));
});

test("URL 인코딩된 상위 탐색이 막힌다", () => {
  assert.equal(escapes("/%2e%2e/etc/passwd"), false, "%2e%2e가 디코딩되어 탈출했습니다");
  assert.equal(escapes("/..%2fetc%2fpasswd"), false);
});

test("중첩된 상위 탐색이 막힌다", () => {
  // 세그먼트 필터링만 하면 "....//"가 ".." 하나로 접혀 남는다.
  assert.equal(escapes("/....//etc/passwd"), false, "세그먼트 필터를 우회했습니다");
  assert.equal(escapes("/a/../../etc/passwd"), false);
});

test("절대경로 주입이 막힌다", () => {
  assert.equal(escapes("//etc/passwd"), false);
});

test("탈출 시도는 거부로 표시된다", () => {
  const r = resolveRequestPath(ROOT, "/../../etc/passwd");
  assert.equal(r.ok, false, "탈출 시도가 조용히 정상 응답으로 처리됐습니다");
});
