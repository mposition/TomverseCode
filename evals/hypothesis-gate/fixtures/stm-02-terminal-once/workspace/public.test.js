const test = require("node:test");
const assert = require("node:assert/strict");
const { TaskMachine } = require("./machine.js");

test("정상 흐름", () => {
  const m = new TaskMachine();
  m.transition("RUNNING");
  m.transition("COMPLETED");
  assert.equal(m.phase, "COMPLETED");
});
