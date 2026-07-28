const test = require("node:test");
const assert = require("node:assert/strict");
const { TaskMachine } = require("./machine.js");

test("완료 후 취소는 상태를 바꾸지 않는다", () => {
  const m = new TaskMachine();
  m.transition("RUNNING");
  m.transition("COMPLETED");
  const accepted = m.transition("CANCELLED");
  assert.equal(m.phase, "COMPLETED", "터미널 이후 상태가 바뀌었습니다");
  assert.equal(accepted, false, "거부됐다는 사실이 반환값에 없습니다");
});

test("터미널 이벤트는 한 번만 기록된다", () => {
  const m = new TaskMachine();
  m.transition("RUNNING");
  m.transition("COMPLETED");
  m.transition("CANCELLED");
  m.transition("FAILED");
  const terminals = m.events.filter((e) => ["COMPLETED", "FAILED", "CANCELLED"].includes(e));
  assert.deepEqual(terminals, ["COMPLETED"]);
});

test("전이 표에 없는 전이는 거부된다", () => {
  const m = new TaskMachine();
  assert.equal(m.transition("COMPLETED"), false, "CREATED에서 COMPLETED로 바로 갈 수 없습니다");
  assert.equal(m.phase, "CREATED");
});

test("허용된 전이는 그대로 동작한다", () => {
  const m = new TaskMachine();
  assert.equal(m.transition("RUNNING"), true);
  assert.equal(m.transition("CANCELLED"), true);
  assert.equal(m.phase, "CANCELLED");
});
