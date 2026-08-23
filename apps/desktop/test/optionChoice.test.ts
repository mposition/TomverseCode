import test from "node:test";
import assert from "node:assert/strict";
import { layoutChoices, objectParticle, onlyLabel } from "../src/lib/optionChoice.js";

/**
 * 불일치 카드 선택지의 구조 — ui-wireframes.md 3.9절.
 *
 * 여기서 검증하는 실패는 **화면에 그려지기는 한다**: 두 목록이 통째로 그려져도 앱은 멀쩡하고,
 * 다만 사용자가 두 문단을 눈으로 diff해야 한다. 판정하라고 만든 카드가 판정을 어렵게 하는
 * 상태이며, 그건 스크린샷을 봐야만 알 수 있는 종류의 실패다.
 */

test("대부분 같고 한 항목만 다르면 다른 항목만 남는다", () => {
  const layout = layoutChoices([
    { optionId: "a", values: ["빈 문자열 거부", "형식 검증", "429 응답"] },
    { optionId: "b", values: ["빈 문자열 거부", "형식 검증", "401 응답"] },
  ]);

  assert.deepEqual(layout.shared, ["빈 문자열 거부", "형식 검증"]);
  assert.deepEqual(layout.distinct, [
    { optionId: "a", only: ["429 응답"] },
    { optionId: "b", only: ["401 응답"] },
  ]);
  assert.equal(layout.asList, true);
});

test("공통 항목은 첫 선택지의 순서를 지킨다", () => {
  // 정렬해 버리면 모델이 쓴 순서(대개 중요도 순)가 사라진다.
  const layout = layoutChoices([
    { optionId: "a", values: ["나중", "먼저"] },
    { optionId: "b", values: ["먼저", "나중"] },
  ]);
  assert.deepEqual(layout.shared, ["나중", "먼저"]);
});

test("겹치는 항목이 없으면 갈라내지 않는다", () => {
  const layout = layoutChoices([
    { optionId: "a", values: ["src/validate.ts"] },
    { optionId: "b", values: ["src/api/login.ts"] },
  ]);
  assert.deepEqual(layout.shared, []);
  // 값이 하나뿐이면 목록으로 만들 이유가 없다 — 항목 하나짜리 목록은 구조를 더하지 않는다.
  assert.equal(layout.asList, false);
  assert.deepEqual(layout.distinct[0]!.only, ["src/validate.ts"]);
});

test("한쪽이 다른 쪽을 포함하면 그쪽 고유 항목은 비고, 그 사실을 문장으로 말한다", () => {
  const layout = layoutChoices([
    { optionId: "a", values: ["형식 검증"] },
    { optionId: "b", values: ["형식 검증", "길이 제한"] },
  ]);
  assert.deepEqual(layout.shared, ["형식 검증"]);
  assert.deepEqual(layout.distinct[0]!.only, []);
  // **빈 자리를 그리지 않는다** — "없다"도 답이고, 빈칸이면 그 선택지가 무슨 뜻인지 알 수 없다.
  assert.equal(onlyLabel([], layout.shared.length), "공통 항목만 — 더 요구하지 않음");
  assert.equal(onlyLabel([], 0), "아무것도 정하지 않음");
});

test("아무것도 정하지 않은 선택지도 자리를 지킨다", () => {
  // 목록에서 빼면 "이 초안은 아무것도 정하지 않았다"를 고를 수 없게 된다.
  const layout = layoutChoices([
    { optionId: "a", values: [] },
    { optionId: "b", values: ["형식 검증", "길이 제한"] },
  ]);
  assert.equal(layout.distinct.length, 2);
  assert.deepEqual(layout.shared, []);
  assert.deepEqual(layout.distinct[0]!.only, []);
});

/**
 * 선택지 3개는 아직 만들어질 수 없다(라우터가 executor를 둘까지만 배정한다). 계산이 N에
 * 대해 성립하는지는 지금 확인해 둘 수 있고, 그러면 executor가 늘어날 때 **다시 물어야 하는
 * 것이 시각 밀도 하나로 좁아진다.**
 */
test("선택지가 셋이면 셋 다에 있는 것만 공통이다", () => {
  const layout = layoutChoices([
    { optionId: "a", values: ["공통", "둘에만", "a만"] },
    { optionId: "b", values: ["공통", "둘에만", "b만"] },
    { optionId: "c", values: ["공통", "c만"] },
  ]);
  // "둘에만"을 공통으로 세면 그 항목이 빠진 c를 고를 근거가 사라진다.
  assert.deepEqual(layout.shared, ["공통"]);
  assert.deepEqual(layout.distinct[0]!.only, ["둘에만", "a만"]);
  assert.deepEqual(layout.distinct[2]!.only, ["c만"]);
});

test("선택지가 하나면 공통을 말하지 않는다", () => {
  // 하나뿐인 목록의 모든 항목이 "공통"이 되면 고를 것이 하나도 남지 않는다.
  const layout = layoutChoices([{ optionId: "a", values: ["x", "y"] }]);
  assert.deepEqual(layout.shared, []);
  assert.deepEqual(layout.distinct[0]!.only, ["x", "y"]);
});

// ---- 조사 ----

test("받침이 있으면 을, 없으면 를", () => {
  // 실제로 틀려 있던 것들이다: "완료 기준를 정하지 않음", "필요한 검증를 정하지 않음".
  assert.equal(objectParticle("완료 기준"), "을");
  assert.equal(objectParticle("필요한 검증"), "을");
  assert.equal(objectParticle("수정 위치"), "를");
});

test("한글이 아닌 끝 글자에는 판정 근거가 없으므로 관례를 쓴다", () => {
  assert.equal(objectParticle("patch"), "를");
  assert.equal(objectParticle("TODO"), "를");
});
