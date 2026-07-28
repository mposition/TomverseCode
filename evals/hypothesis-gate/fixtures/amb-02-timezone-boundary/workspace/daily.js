// 타임스탬프를 일별로 묶는다.
//
// timestamps는 epoch 밀리초, tzOffsetMinutes는 대상 타임존의 UTC 오프셋(분).
function groupByDay(timestamps, tzOffsetMinutes) {
  const buckets = new Map();
  for (const ts of timestamps) {
    // UTC 기준으로 날짜를 만든다.
    const day = Math.floor(ts / 86400000);
    const key = String(day);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return buckets;
}
module.exports = { groupByDay };
