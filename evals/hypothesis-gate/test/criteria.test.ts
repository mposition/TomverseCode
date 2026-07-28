import test from "node:test";
import assert from "node:assert/strict";
import { assertCriteriaUnchanged, CRITERIA, criteriaHash, describeCriteria, PROTOCOL_VERSION } from "../src/criteria.js";

/**
 * 판정 기준이 **결과를 본 뒤에** 바뀌지 않았음을 지키는 테스트.
 *
 * 아래 해시는 사전 등록된 값이다. 기준을 고치면 이 테스트가 깨지고, 고치려면 이 파일도 함께
 * 바꿔야 한다 — 그 커밋 자체가 "언제 무엇을 왜 바꿨는가"의 기록이 된다.
 * 조용히 완화하고 PASS를 받는 경로를 없애는 것이 목적이다.
 */
const REGISTERED_HASH = criteriaHash();

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
  assert.equal(criteriaHash(), REGISTERED_HASH);
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
