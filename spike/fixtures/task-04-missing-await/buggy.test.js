const test = require("node:test");
const assert = require("node:assert/strict");
const { getTotal } = require("./buggy.js");

test("sums item prices from an async fetchItems", async () => {
  const fetchItems = async () => [{ price: 10 }, { price: 5 }, { price: 2.5 }];
  const total = await getTotal("cart-1", fetchItems);
  assert.equal(total, 17.5);
});

test("returns 0 for an empty cart", async () => {
  const fetchItems = async () => [];
  const total = await getTotal("cart-2", fetchItems);
  assert.equal(total, 0);
});
