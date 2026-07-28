const test = require("node:test");
const assert = require("node:assert/strict");
const { replay } = require("./replay.js");

test("입출금이 반영된다", () => {
  const s = replay([
    { type: "DEPOSIT", payload: { amountCents: 500 } },
    { type: "WITHDRAW", payload: { amountCents: 200 } },
  ]);
  assert.equal(s.balance, 300);
});
