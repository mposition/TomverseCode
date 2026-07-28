const test = require("node:test");
const assert = require("node:assert/strict");
const { replay } = require("./replay.js");

test("기본 재생은 그대로 동작한다", () => {
  const s = replay([
    { type: "DEPOSIT", payload: { amountCents: 1200 } },
    { type: "DEPOSIT", payload: { amountCents: 300 } },
    { type: "WITHDRAW", payload: { amountCents: 450 } },
  ]);
  assert.equal(s.balance, 1050);
  assert.equal(s.applied, 3);
});

test("알 수 없는 이벤트 타입에서 멈추지 않는다", () => {
  // 새 버전이 추가한 이벤트를 예전 코드가 읽는 상황. 재생이 죽으면 계정 전체를 못 연다.
  const s = replay([
    { type: "DEPOSIT", payload: { amountCents: 500 } },
    { type: "TAGGED", payload: { tag: "vip" } },
    { type: "WITHDRAW", payload: { amountCents: 100 } },
  ]);
  assert.equal(s.balance, 400, "알 수 없는 이벤트 때문에 재생이 중단됐습니다");
  assert.ok(Array.isArray(s.skipped) && s.skipped.includes("TAGGED"), "건너뛴 사실이 기록되지 않았습니다");
});

test("예전 payload 형태(amount, 원 단위)도 읽는다", () => {
  const s = replay([{ type: "DEPOSIT", payload: { amount: 5 } }]);
  assert.equal(s.balance, 500, "v1 payload(amount, 원)를 읽지 못했습니다");
});

test("닫힌 계정 이후 거래는 반영하지 않는다", () => {
  const s = replay([
    { type: "DEPOSIT", payload: { amountCents: 100 } },
    { type: "CLOSED", payload: {} },
    { type: "DEPOSIT", payload: { amountCents: 900 } },
  ]);
  assert.equal(s.closed, true);
  assert.equal(s.balance, 100, "닫힌 계정에 입금이 반영됐습니다");
});
