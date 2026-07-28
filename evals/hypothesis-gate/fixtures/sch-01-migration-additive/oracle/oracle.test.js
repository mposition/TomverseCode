const test = require("node:test");
const assert = require("node:assert/strict");
const { migrate } = require("./migrate.js");

test("v1 → v2 변환이 값을 보존한다", () => {
  const out = migrate({ version: 1, name: "app", retries: 3 });
  assert.equal(out.version, 2);
  assert.equal(out.name, "app");
  assert.equal(out.limits.retries, 3);
});

test("이미 v2인 설정은 그대로 유지된다", () => {
  const v2 = { version: 2, name: "app", limits: { retries: 7, timeoutMs: 1234 } };
  const out = migrate(v2);
  assert.equal(out.limits.retries, 7, "v2를 다시 마이그레이션해 값을 잃었습니다");
  assert.equal(out.limits.timeoutMs, 1234, "기존 timeoutMs가 기본값으로 덮였습니다");
});

test("마이그레이션은 멱등이다", () => {
  const once = migrate({ version: 1, name: "app", retries: 3 });
  const twice = migrate(once);
  assert.deepEqual(twice, once);
});

test("모르는 미래 버전은 조용히 낮추지 않는다", () => {
  assert.throws(
    () => migrate({ version: 99, name: "app" }),
    "미래 버전을 조용히 현재 버전으로 표시하면 데이터가 손상됩니다"
  );
});

test("v1에 retries가 없으면 기본값을 쓴다", () => {
  const out = migrate({ version: 1, name: "app" });
  assert.equal(typeof out.limits.retries, "number");
});
