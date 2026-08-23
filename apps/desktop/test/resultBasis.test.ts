import test from "node:test";
import assert from "node:assert/strict";
import { resultBasis } from "../src/lib/resultBasis.js";

/**
 * 결과의 근거 표시 — product-strategy.md 11절 + 16.5절.
 *
 * 여기서 검증하는 실패는 **화면이 멀쩡히 그려진다**: 검증이 침묵한 태스크에 통과 배지를 달아도
 * 앱은 아무 문제 없이 돌고, 사용자만 검증되지 않은 결과를 검증된 것으로 읽는다. 9절 서두가
 * "검증 없는 것보다 나쁘다"고 부른 상태이며, 스크린샷으로만 보이는 종류의 실패다.
 */

test("검증이 실제로 돌아 통과했을 때만 결정론적 근거가 있다", () => {
  const basis = resultBasis({ overall: "pass" });
  assert.equal(basis.kind, "deterministic_pass");
  assert.equal(basis.deterministic, true);
});

test("명령이 없어 침묵한 태스크는 사용자 확인에만 근거한다", () => {
  const basis = resultBasis({
    overall: "not_configured",
    criteria: [{ source: "user_decision" }, { source: "user_decision" }],
  });
  assert.equal(basis.kind, "user_only");
  assert.equal(basis.deterministic, false);
  assert.ok(basis.detail.includes("2개"), basis.detail);
});

/**
 * **산출물이 코드인지 문서인지로 가르지 않는다.**
 *
 * 테스트 스크립트가 없는 저장소의 코드 태스크는 명세를 쓴 태스크와 정확히 같은 자리에 있다.
 * 산출물 종류로 가르면 이쪽이 "코드니까 검증됐겠지"로 읽힌다.
 */
test("검증이 침묵하면 코드 태스크도 문서 태스크와 같은 근거를 받는다", () => {
  const docTask = resultBasis({ overall: "not_configured", criteria: [{ source: "user_decision" }] });
  const codeTaskWithoutTests = resultBasis({
    overall: "not_configured",
    criteria: [{ source: "user_decision" }],
    evaluations: [{ status: "UNVERIFIED" }],
  });
  assert.equal(docTask.kind, codeTaskWithoutTests.kind);
  assert.equal(codeTaskWithoutTests.deterministic, false);
});

test("돌리지 못한 경우도 결정론적 근거가 아니다", () => {
  // 원인은 다르지만(패널이 따로 말한다) 뒷받침하는 것이 없다는 점은 같다.
  const basis = resultBasis({ overall: "could_not_run", criteria: [{ source: "user_decision" }] });
  assert.equal(basis.kind, "user_only");
});

test("리포트가 아예 없어도 통과로 읽히지 않는다", () => {
  const basis = resultBasis({});
  assert.equal(basis.deterministic, false);
  assert.equal(basis.kind, "nothing");
});

/**
 * 모델이 스스로 적은 완료 기준은 "사용자 확인"이 아니다. 그걸 세면 모델이 자기 산출물을
 * 자기가 승인한 것을 근거로 내놓게 된다 — 원칙 4가 검수자에 대해 막는 것과 같은 자기 승인이다.
 */
test("모델이 적은 기준은 사용자 확인으로 세지 않는다", () => {
  const basis = resultBasis({
    overall: "not_configured",
    criteria: [{ source: "draft_proposal" }, { source: "draft_proposal" }],
  });
  assert.equal(basis.kind, "nothing", JSON.stringify(basis));
});

test("근거가 하나도 없으면 침묵하지 않고 그렇게 말한다", () => {
  const basis = resultBasis({ overall: "not_configured", criteria: [] });
  assert.equal(basis.kind, "nothing");
  assert.ok(basis.label.length > 0 && basis.detail.length > 0);
});

/**
 * **검수 모델의 판정은 근거를 바꾸지 않는다** — 11절.
 *
 * 입력에 검수 결과가 아예 없는 것이 그 규칙의 구조적 표현이고, 여기서는 그것이 실제로
 * 동작하는지를 본다: 검수 통과를 넣어도 결과가 그대로여야 한다.
 */
test("검수 모델이 통과시켜도 근거는 달라지지 않는다", () => {
  const withoutReview = resultBasis({ overall: "not_configured", criteria: [{ source: "user_decision" }] });
  const withReview = resultBasis({
    overall: "not_configured",
    criteria: [{ source: "user_decision" }],
    // 타입에 없는 필드를 억지로 넣는다 — 언젠가 누가 필드를 추가했을 때 이 검사가 반응한다.
    ...({ reviewerVerdict: "ACCEPT", reviewPassed: true } as Record<string, unknown>),
  });
  assert.deepEqual(withReview, withoutReview);
});

test("통과한 태스크에서는 몇 개가 테스트로 확인됐는지 함께 말한다", () => {
  const basis = resultBasis({
    overall: "pass",
    evaluations: [{ status: "VERIFIED_BY_TEST" }, { status: "UNVERIFIED" }, { status: "UNVERIFIED" }],
  });
  // "통과"만 보이면 기준 3개 중 1개만 확인된 사실이 사라진다 — 11절이 경계하는 인상 조정이다.
  assert.ok(basis.detail.includes("3개 중 1개"), basis.detail);
});
