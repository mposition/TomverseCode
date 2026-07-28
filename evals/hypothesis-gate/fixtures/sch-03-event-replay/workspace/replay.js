// append-only 이벤트 로그를 재생해 현재 상태를 만든다.
function replay(events) {
  let state = { balance: 0, closed: false, applied: 0 };
  for (const event of events) {
    switch (event.type) {
      case "DEPOSIT":
        state.balance += event.payload.amountCents;
        break;
      case "WITHDRAW":
        state.balance -= event.payload.amountCents;
        break;
      case "CLOSED":
        state.closed = true;
        break;
      default:
        throw new Error(`알 수 없는 이벤트 타입: ${event.type}`);
    }
    state.applied += 1;
  }
  return state;
}
module.exports = { replay };
