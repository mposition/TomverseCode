const test = require("node:test");
const assert = require("node:assert/strict");
const { buildQuery } = require("./query.js");

test("새 객체 형태가 동작한다", () => {
  const q = buildQuery({ sort: { field: "name", direction: "desc" } });
  assert.equal(q.field, "name");
  assert.equal(q.direction, "desc");
});

test("예전 문자열 형태가 계속 동작한다", () => {
  const q = buildQuery({ sort: "name" });
  assert.equal(q.field, "name", "예전 호출자가 깨졌습니다");
  assert.equal(q.direction, "asc", "예전 API의 기본은 오름차순이었습니다");
});

test("예전 형태를 쓰면 경고가 남는다", () => {
  const q = buildQuery({ sort: "name" });
  assert.ok(
    Array.isArray(q.warnings) && q.warnings.some((w) => /deprecat|더 이상|권장/i.test(w)),
    "조용히 받아주기만 하면 호출자가 옮겨갈 이유가 없습니다"
  );
});

test("새 형태에는 경고가 없다", () => {
  const q = buildQuery({ sort: { field: "name", direction: "asc" } });
  assert.deepEqual(q.warnings ?? [], []);
});

test("sort가 없으면 기본 정렬을 쓴다", () => {
  const q = buildQuery({});
  assert.equal(typeof q.field, "string");
  assert.ok(["asc", "desc"].includes(q.direction));
});

test("direction이 빠진 객체는 오름차순으로 채운다", () => {
  const q = buildQuery({ sort: { field: "age" } });
  assert.equal(q.direction, "asc");
});
