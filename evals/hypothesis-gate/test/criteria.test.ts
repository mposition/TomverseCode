import test from "node:test";
import assert from "node:assert/strict";
import { assertCriteriaUnchanged, CRITERIA, criteriaHash, describeCriteria, PROTOCOL_VERSION } from "../src/criteria.js";

/**
 * 판정 기준이 **결과를 본 뒤에** 바뀌지 않았음을 지키는 테스트.
 *
 * 아래 해시는 사전 등록된 값이다. 기준을 고치면 이 테스트가 깨지고, 고치려면 이 파일도 함께
 * 바꿔야 한다 — 그 커밋 자체가 "언제 무엇을 왜 바꿨는가"의 기록이 된다.
 * 조용히 완화하고 PASS를 받는 경로를 없애는 것이 목적이다.
 *
 * # 이 값은 **리터럴이어야 한다**
 *
 * 종전에는 `criteriaHash()`를 호출해 채웠다. 그러면 기준을 어떻게 바꾸든 기대값이 함께
 * 움직여서 **이 파일은 언제나 통과한다** — 위 문단이 약속하는 것을 하나도 지키지 못한다.
 * 실제로 `PROTOCOL_VERSION`을 1에서 2로 올렸을 때 이 테스트는 아무 말도 하지 않았다.
 * "대조 검사는 언제나 통과하는 방식으로 고장 난다"의 교과서적 사례다.
 */
const REGISTERED_HASH = "a089e94b57fd97c4";

test("사전 등록된 기준값이 명세 13절과 일치한다", () => {
  assert.equal(CRITERIA.minFixtures, 24);
  assert.equal(CRITERIA.minRepetitions, 3);
  assert.equal(CRITERIA.minOraclePassRateGainPp, 10);
  assert.equal(CRITERIA.bootstrapConfidence, 0.95);
  assert.equal(CRITERIA.bootstrapLowerBoundAbove, 0);
  assert.equal(CRITERIA.maxSecurityRegressions, 0);
  assert.equal(CRITERIA.maxCostMultiplier, 2);
  assert.equal(CRITERIA.maxP95LatencyMultiplier, 2.5);
  assert.equal(CRITERIA.maxInfrastructureFailureRate, 0.05);
  assert.equal(CRITERIA.protocolVersion, PROTOCOL_VERSION);
  // 절차가 바뀌면 이 값도 올라간다 — 상수만 봉인하면 봉인을 절차 쪽으로 우회할 수 있다.
  assert.equal(PROTOCOL_VERSION, 2);
});

test("기준 객체는 런타임에 수정할 수 없다", () => {
  // 하네스가 실행 중에 스스로 기준을 유리하게 바꾸는 경로를 막는다.
  assert.throws(
    () => {
      "use strict";
      (CRITERIA as unknown as Record<string, number>).minFixtures = 1;
    },
    TypeError
  );
  assert.equal(CRITERIA.minFixtures, 24);
});

test("해시는 값에 따라 결정되고 순서에 무관하다", () => {
  assert.equal(
    criteriaHash(),
    REGISTERED_HASH,
    "판정 기준이 바뀌었습니다. 의도한 변경이면 PROTOCOL_VERSION을 올리고 이 파일의 해시도 함께 갱신할 것 — 그 커밋이 기록이 된다."
  );
  const reordered = { ...CRITERIA };
  assert.equal(criteriaHash(reordered), REGISTERED_HASH);
});

test("기준을 바꾸면 해시가 바뀐다", () => {
  const relaxed = { ...CRITERIA, minOraclePassRateGainPp: 1 };
  assert.notEqual(criteriaHash(relaxed), REGISTERED_HASH, "기준을 완화했는데 해시가 그대로입니다");
});

test("실행 중 기준 변경은 예외로 드러난다", () => {
  assert.doesNotThrow(() => assertCriteriaUnchanged(REGISTERED_HASH));
  assert.throws(() => assertCriteriaUnchanged("deadbeefdeadbeef"), /판정 기준이 실행 중에 바뀌었습니다/);
});

test("사람이 읽는 기준 설명이 9개 항목을 모두 담는다", () => {
  const described = describeCriteria();
  assert.equal(described.length, 9);
  assert.ok(described.some((d) => d.includes("24")));
  assert.ok(described.some((d) => d.includes("10%p")));
  assert.ok(described.some((d) => d.includes("95%")));
});
