// 비동기 결과를 캐시한다.
class AsyncCache {
  constructor(fetcher) {
    this.fetcher = fetcher;
    this.values = new Map();
  }

  async get(key) {
    if (this.values.has(key)) return this.values.get(key);
    const value = await this.fetcher(key);
    this.values.set(key, value);
    return value;
  }
}
module.exports = { AsyncCache };
