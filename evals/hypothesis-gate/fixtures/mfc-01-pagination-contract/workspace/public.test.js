const test = require("node:test");
const assert = require("node:assert/strict");
const { listUsers } = require("./listUsers.js");

const users = ["a", "b", "c", "d", "e"];

test("1페이지는 첫 두 명", () => {
  assert.deepEqual(listUsers(users, 1, 2), ["a", "b"]);
});
