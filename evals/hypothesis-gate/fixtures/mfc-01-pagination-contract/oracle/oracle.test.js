const test = require("node:test");
const assert = require("node:assert/strict");
const { listUsers } = require("./listUsers.js");
const { paginate } = require("./paginate.js");

const users = ["a", "b", "c", "d", "e"];

test("1-based 규약이 두 모듈에서 일치한다", () => {
  assert.deepEqual(listUsers(users, 1, 2), ["a", "b"]);
  assert.deepEqual(listUsers(users, 2, 2), ["c", "d"]);
  assert.deepEqual(listUsers(users, 3, 2), ["e"]);
});

test("범위를 벗어난 페이지는 빈 배열", () => {
  assert.deepEqual(listUsers(users, 4, 2), []);
  assert.deepEqual(listUsers(users, 99, 2), []);
});

test("paginate 자체 규약은 유지된다", () => {
  assert.deepEqual(paginate(users, 1, 2), ["a", "b"]);
});
