const test = require("node:test");
const assert = require("node:assert/strict");
const { canEditPost } = require("./buggy.js");

test("the post author can edit their own post", () => {
  const user = { id: "u1" };
  const post = { authorId: "u1" };
  assert.equal(canEditPost(user, post), true);
});

test("a different user cannot edit someone else's post", () => {
  const user = { id: "u2" };
  const post = { authorId: "u1" };
  assert.equal(canEditPost(user, post), false);
});
