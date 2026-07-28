// 순서 보장 이벤트 버스.
class EventBus {
  constructor() {
    this.handlers = [];
  }

  subscribe(handler) {
    this.handlers.push(handler);
  }

  // 각 핸들러를 호출한다.
  emit(event) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
module.exports = { EventBus };
