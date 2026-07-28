const CURRENT_VERSION = 2;

// v1: { version: 1, name, retries }
// v2: { version: 2, name, limits: { retries, timeoutMs } }
function migrate(config) {
  return {
    version: CURRENT_VERSION,
    name: config.name,
    limits: {
      retries: config.retries,
      timeoutMs: 30000,
    },
  };
}
module.exports = { migrate, CURRENT_VERSION };
