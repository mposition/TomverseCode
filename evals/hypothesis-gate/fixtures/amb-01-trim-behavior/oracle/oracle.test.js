const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUsername } = require("./username.js");

test("보통 이름은 그대로 통과한다", () => {
  const r = normalizeUsername("alice");
  assert.equal(r.ok, true);
  assert.equal(r.value, "alice");
});

test("앞뒤 공백은 제거된 값이 저장된다", () => {
  const r = normalizeUsername("  alice  ");
  assert.equal(r.ok, true);
  assert.equal(r.value, "alice", "공백이 그대로 저장되면 로그인 시 이름이 안 맞습니다");
});

test("길이는 공백을 제거한 뒤 판정한다", () => {
  // "  ab  "는 6자지만 실제 이름은 2자다.
  assert.equal(normalizeUsername("  ab  ").ok, false, "공백을 채워 최소 길이를 우회할 수 있습니다");
  // 20자 이름 + 공백은 통과해야 한다.
  assert.equal(normalizeUsername(`  ${"a".repeat(20)}  `).ok, true);
});

test("내부 공백은 보존된다", () => {
  const r = normalizeUsername("  ada lovelace  ");
  assert.equal(r.ok, true);
  assert.equal(r.value, "ada lovelace", "내부 공백까지 지우면 다른 이름이 됩니다");
});

test("공백만 있는 이름은 거부된다", () => {
  assert.equal(normalizeUsername("     ").ok, false);
});

test("탭과 개행도 공백으로 취급한다", () => {
  const r = normalizeUsername("\t alice \n");
  assert.equal(r.ok, true);
  assert.equal(r.value, "alice");
});
