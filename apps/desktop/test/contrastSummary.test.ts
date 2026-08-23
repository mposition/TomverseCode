import test from "node:test";
import assert from "node:assert/strict";
import { summarizeContrast } from "../src/lib/contrastSummary.js";

/**
 * 대조 결과 표시 — state-machine-and-protocol.md 17절.
 *
 * 여기서 검증하는 실패는 **화면이 조용한 것**이다. 조용하면 아무도 버그 리포트를 쓰지 않고,
 * 사용자는 "아무 문제 없었다"로 읽는다 — 두 모델이 같은 방식으로 틀린 경우가 정확히 그렇게
 * 보인다(9.2-B 상관된 오류).
 */

test("대조에 도달하기 전에는 아무 주장도 하지 않는다", () => {
  // 빈 패널을 그리면 실행 초반부터 "대조하지 않았다"를 주장하게 된다.
  assert.equal(summarizeContrast({}), null);
});

test("대조를 드롭했으면 그 사실과 사유를 말한다", () => {
  const summary = summarizeContrast({
    appliedPolicies: ["contrast_dropped — 독립 공급자가 하나뿐입니다"],
  })!;
  assert.equal(summary.kind, "not_contrasted");
  assert.ok(summary.note.includes("독립 공급자가 하나뿐"), summary.note);
  // **없는 정보를 없다고 말한다.** "문제 없음"으로 읽히면 안 된다.
  assert.ok(summary.note.includes("아무것도 말하지 않습니다"), summary.note);
});

test("일치를 검증으로 말하지 않는다", () => {
  const summary = summarizeContrast({
    detected: { contrasted: true, agreedFields: ["doneCriteria", "targetPaths"], disagreements: [] },
  })!;
  assert.equal(summary.kind, "agreed");
  assert.deepEqual(summary.agreedFields, ["doneCriteria", "targetPaths"]);
  assert.ok(summary.note.includes("일치는 검증이 아닙니다"), summary.note);
  // 3.9절: 이 카드에서 초록색은 사용자가 직접 판정한 항목에만 쓴다.
  assert.equal(summary.positiveTone, false);
});

/**
 * **침묵을 동의로 세지 않는다.**
 *
 * 대조 코드는 양쪽이 모두 비어 있는 필드를 `agreedFields`에 넣지 않는다. 화면이 그 경우를
 * "일치"로 합치면 그 규율이 마지막 한 걸음에서 무효가 된다.
 */
test("비교할 값이 없었던 것과 같았던 것은 다른 결말이다", () => {
  const nothing = summarizeContrast({ detected: { contrasted: true, agreedFields: [], disagreements: [] } })!;
  assert.equal(nothing.kind, "nothing_to_compare");
  assert.ok(nothing.note.includes("같았다는 뜻이 아닙니다"), nothing.note);

  const agreed = summarizeContrast({
    detected: { contrasted: true, agreedFields: ["doneCriteria"], disagreements: [] },
  })!;
  assert.notEqual(nothing.kind, agreed.kind);
});

test("갈렸으면 몇 건이 필수였고 몇 건이 참고였는지까지 말한다", () => {
  const summary = summarizeContrast({
    detected: {
      contrasted: true,
      agreedFields: ["requiredTests"],
      disagreements: [{ field: "doneCriteria" }, { field: "targetPaths" }],
      askedCount: 1,
      advisoryCount: 1,
    },
  })!;
  assert.equal(summary.kind, "disagreed");
  assert.deepEqual(summary.disagreedFields, ["doneCriteria", "targetPaths"]);
  assert.equal(summary.askedCount, 1);
  assert.equal(summary.advisoryCount, 1);
  // 갈린 카드에서도 "같았던 것"이 검증으로 읽히면 안 된다.
  assert.ok(summary.note.includes("일치는 검증이 아닙니다"), summary.note);
});

test("어떤 결말에서도 성공 톤을 허용하지 않는다", () => {
  const inputs = [
    { appliedPolicies: ["contrast_dropped x"] },
    { detected: { contrasted: true, agreedFields: [], disagreements: [] } },
    { detected: { contrasted: true, agreedFields: ["doneCriteria" as const], disagreements: [] } },
    { detected: { contrasted: true, disagreements: [{ field: "doneCriteria" as const }] } },
  ];
  for (const input of inputs) {
    const summary = summarizeContrast(input)!;
    assert.equal(summary.positiveTone, false, JSON.stringify(summary));
  }
});
