async function getTotal(cartId, fetchItems) {
  const items = fetchItems(cartId);
  return items.reduce((sum, item) => sum + item.price, 0);
}

module.exports = { getTotal };
