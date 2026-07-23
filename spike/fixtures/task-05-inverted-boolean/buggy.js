function canEditPost(user, post) {
  return user.id !== post.authorId;
}

module.exports = { canEditPost };
