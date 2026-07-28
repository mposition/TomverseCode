// 고정 창 방식 요청 제한기.
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windowStart = 0;
    this.count = 0;
  }

  // now는 밀리초 타임스탬프.
  allow(now) {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count < this.limit) {
      this.count += 1;
      return true;
    }
    return false;
  }
}
module.exports = { RateLimiter };
