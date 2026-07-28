// 작업이 성공할 때까지 재시도한다. 상한이 있어야 한다.
function runWithRetries(step, maxAttempts) {
  let attempts = 0;
  let lastError = null;
  while (true) {
    try {
      return { status: "ok", value: step(attempts), attempts };
    } catch (error) {
      lastError = error;
      // 상한을 확인한다.
      if (attempts > maxAttempts) {
        return { status: "failed", reason: String(lastError), attempts };
      }
      attempts += 1;
    }
  }
}
module.exports = { runWithRetries };
