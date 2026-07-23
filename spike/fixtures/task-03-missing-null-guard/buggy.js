function getFirstName(user) {
  return user.name.split(" ")[0];
}

module.exports = { getFirstName };
