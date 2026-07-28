// 여러 항목을 저장소에 함께 쓴다.
class BatchWriter {
  constructor(store) {
    this.store = store;
  }

  writeAll(entries) {
    const written = [];
    for (const [key, value] of entries) {
      this.store.set(key, value);
      written.push(key);
    }
    return { ok: true, written };
  }
}
module.exports = { BatchWriter };
