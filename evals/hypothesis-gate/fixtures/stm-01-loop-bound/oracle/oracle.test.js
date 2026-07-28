const test = require("node:test");
const assert = require("node:assert/strict");
const { runWithRetries } = require("./loop.js");

test("항상 실패하면 상한에서 멈춘다", () => {
  let calls = 0;
  const result = runWithRetries(() => { calls += 1; throw new Error("nope"); }, 3);
  assert.equal(result.status, "failed");
  assert.ok(calls <= 4, `호출이 ${calls}회 — 상한(최초 1 + 재시도 3)을 넘었습니다`);
  assert.ok(result.reason.includes("nope"), "마지막 실패 사유가 없습니다");
});

test("maxAttempts=0이면 한 번만 시도한다", () => {
  let calls = 0;
  const result = runWithRetries(() => { calls += 1; throw new Error("x"); }, 0);
  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
});

test("N번째에 성공하면 그 값을 준다", () => {
  let calls = 0;
  const result = runWithRetries(() => {
    calls += 1;
    if (calls < 3) throw new Error("아직");
    return "성공";
  }, 5);
  assert.equal(result.status, "ok");
  assert.equal(result.value, "성공");
  assert.equal(calls, 3);
});
