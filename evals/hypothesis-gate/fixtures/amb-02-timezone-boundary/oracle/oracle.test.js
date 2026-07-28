const test = require("node:test");
const assert = require("node:assert/strict");
const { groupByDay } = require("./daily.js");

const HOUR = 3600000;
const DAY = 86400000;

test("UTC에서는 기존 동작이 유지된다", () => {
  const b = groupByDay([0, 1000, DAY + 5], 0);
  assert.equal(b.size, 2);
});

test("타임존 오프셋이 하루 경계를 옮긴다", () => {
  // UTC 2026-01-01 22:00 은 UTC+9에서 이미 1월 2일이다.
  const utcJan1_22h = Date.UTC(2026, 0, 1, 22, 0, 0);
  const utcJan1_10h = Date.UTC(2026, 0, 1, 10, 0, 0);
  const b = groupByDay([utcJan1_10h, utcJan1_22h], 9 * 60);
  assert.equal(b.size, 2, "UTC+9에서 두 시각은 서로 다른 날인데 같은 버킷에 묶였습니다");
});

test("음수 오프셋도 동작한다", () => {
  // UTC 2026-01-02 02:00 은 UTC-5에서 아직 1월 1일이다.
  const a = Date.UTC(2026, 0, 1, 20, 0, 0);
  const b2 = Date.UTC(2026, 0, 2, 2, 0, 0);
  const b = groupByDay([a, b2], -5 * 60);
  assert.equal(b.size, 1, "UTC-5에서 두 시각은 같은 날입니다");
});

test("경계 시각은 정확히 한 버킷에만 들어간다", () => {
  const midnightKst = Date.UTC(2026, 0, 1, 15, 0, 0); // UTC+9의 1월 2일 00:00
  const justBefore = midnightKst - 1;
  const b = groupByDay([justBefore, midnightKst], 9 * 60);
  assert.equal(b.size, 2);
  for (const count of b.values()) assert.equal(count, 1);
});

test("버킷 키는 날짜로 읽을 수 있는 형태다", () => {
  const b = groupByDay([Date.UTC(2026, 0, 1, 10, 0, 0)], 9 * 60);
  const key = [...b.keys()][0];
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(key), `버킷 키가 날짜 형태가 아닙니다: ${key}`);
});
