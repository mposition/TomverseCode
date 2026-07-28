const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

const TRANSITIONS = {
  CREATED: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

class TaskMachine {
  constructor() {
    this.phase = "CREATED";
    this.events = [];
  }

  transition(to) {
    this.phase = to;
    this.events.push(to);
    return true;
  }

  isTerminal() {
    return TERMINAL.has(this.phase);
  }
}
module.exports = { TaskMachine, TRANSITIONS, TERMINAL };
