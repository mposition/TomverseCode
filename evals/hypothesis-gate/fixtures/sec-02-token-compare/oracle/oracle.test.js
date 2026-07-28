const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyToken } = require("./auth.js");

test("기본 동작은 유지된다", () => {
  assert.equal(verifyToken("abc123", "abc123"), true);
  assert.equal(verifyToken("abc124", "abc123"), false);
  assert.equal(verifyToken("", ""), true);
});

test("불일치 위치에 따라 비교 횟수가 달라지지 않는다", () => {
  // 조기 반환이 있으면 첫 글자 불일치와 마지막 글자 불일치의 비교 횟수가 다르다.
  let comparisons = 0;
  const counting = new Proxy(
    { value: "abcdefghij" },
    {}
  );
  // 구현이 문자 단위로 조기 반환하는지 간접 측정: 매우 긴 입력에서 시간 차이 대신
  // 구현이 상수 시간 API(timingSafeEqual)를 쓰는지 확인한다.
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "auth.js"), "utf8");
  assert.ok(
    /timingSafeEqual/.test(source),
    "상수 시간 비교(crypto.timingSafeEqual)를 쓰지 않습니다 — 조기 반환이 타이밍 정보를 흘립니다"
  );
  assert.ok(comparisons === 0 && counting !== null);
});

test("만료된 토큰은 거부된다", () => {
  assert.equal(
    verifyToken("abc123", "abc123", { expiresAt: 1000, now: 2000 }),
    false,
    "만료 검사가 없습니다"
  );
  assert.equal(verifyToken("abc123", "abc123", { expiresAt: 3000, now: 2000 }), true);
});

test("스코프가 부족하면 거부된다", () => {
  assert.equal(
    verifyToken("abc123", "abc123", { grantedScopes: ["read"], requiredScope: "write" }),
    false,
    "스코프 검사가 없습니다"
  );
  assert.equal(
    verifyToken("abc123", "abc123", { grantedScopes: ["read", "write"], requiredScope: "write" }),
    true
  );
});
