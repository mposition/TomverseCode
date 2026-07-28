// 여러 키를 읽는다. 지금은 콜백만 지원한다.
function fetchAll(store, keys, callback) {
  const out = [];
  for (const key of keys) {
    if (!store.has(key)) {
      callback(new Error(`없는 키: ${key}`));
      return;
    }
    out.push(store.get(key));
  }
  callback(null, out);
}
module.exports = { fetchAll };
