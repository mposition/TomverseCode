import test from "node:test";
import assert from "node:assert/strict";
import { readDeadline } from "../src/lib/deadline.js";

/** **기본값을 만들지 않는다.** 대신 그 선택의 결과를 말한다. */
test("비워 두면 상한 없이 돈다고 말한다", () => {
  const choice = readDeadline("", true);
  assert.equal(choice.secs, null);
  assert.equal(choice.problem, undefined);
  assert.match(choice.notice, /상한 없이/);
});

/**
 * **사람이 붙어 있으면 시계를 걸지 않는다.** 사용자가 답을 쓰는 동안에도 시간이 가면 그건
 * 태스크의 시간이 아니다.
 */
test("무인 실행이 아니면 적어 둔 시한도 걸지 않고, 그 사실을 말한다", () => {
  const choice = readDeadline("30", false);
  assert.equal(choice.secs, null);
  assert.match(choice.notice, /무인 실행이 아니므로/);
  // 비워 둔 경우와 **다른 문장**이어야 한다 — 적어 둔 값이 무시된다는 것이 요점이다.
  assert.notEqual(choice.notice, readDeadline("", false).notice);
});

/** **읽지 못한 것은 거부한다.** 상한 없음으로 바꾸면 사용자는 걸었다고 믿는다. */
test("읽지 못한 입력은 상한 없음이 아니라 거부다", () => {
  for (const bad of ["삼십", "1.5", "-5", "30분"]) {
    const choice = readDeadline(bad, true);
    assert.ok(choice.problem, `${bad}이 통과했습니다`);
    assert.equal(choice.secs, null);
  }
});

/** 0은 "즉시 멈춘다"이고 그건 시한이 아니라 실행하지 않는 것이다. */
test("0분은 거부한다", () => {
  const choice = readDeadline("0", true);
  assert.ok(choice.problem);
});

test("분을 초로 바꿔 보낸다", () => {
  const choice = readDeadline("30", true);
  assert.equal(choice.secs, 1800);
  assert.match(choice.notice, /30분/);
  // 사용자 취소와 다른 사유로 기록된다는 것을 **미리** 말한다(24.2절과 같은 이유).
  assert.match(choice.notice, /다른 사유/);
});
