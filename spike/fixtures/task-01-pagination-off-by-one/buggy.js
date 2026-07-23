function paginate(items, pageSize, pageNumber) {
  const start = pageNumber * pageSize;
  const end = start + pageSize + 1;
  return items.slice(start, end);
}

module.exports = { paginate };
