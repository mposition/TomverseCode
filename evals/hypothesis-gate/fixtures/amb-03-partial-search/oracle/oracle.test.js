const test = require("node:test");
const assert = require("node:assert/strict");
const { findMatches } = require("./find.js");

const DOCS = ["hello world", "Price: $9.99", "config[dev].json", "GOODBYE", "  padded  "];

test("기본 부분 문자열 검색은 유지된다", () => {
  assert.deepEqual(findMatches(DOCS, "world"), ["hello world"]);
});

test("대소문자를 구별하지 않는다", () => {
  assert.deepEqual(findMatches(DOCS, "goodbye"), ["GOODBYE"], "대소문자 때문에 못 찾습니다");
});

test("검색어 앞뒤 공백은 무시한다", () => {
  assert.deepEqual(findMatches(DOCS, "  world  "), ["hello world"]);
});

test("정규식 메타문자를 문자 그대로 찾는다", () => {
  assert.deepEqual(findMatches(DOCS, "$9.99"), ["Price: $9.99"], "$가 정규식 앵커로 해석됐습니다");
  assert.deepEqual(findMatches(DOCS, "config[dev]"), ["config[dev].json"], "[]가 문자 클래스로 해석됐습니다");
});

test("잘못된 정규식으로도 터지지 않는다", () => {
  assert.doesNotThrow(() => findMatches(DOCS, "("), "검색어가 정규식으로 해석되어 예외가 났습니다");
  assert.deepEqual(findMatches(DOCS, "("), []);
});

test("빈 검색어는 아무것도 찾지 않는다", () => {
  assert.deepEqual(findMatches(DOCS, "   "), []);
});
