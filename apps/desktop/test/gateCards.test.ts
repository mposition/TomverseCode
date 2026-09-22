import test from "node:test";
import assert from "node:assert/strict";
import {
  checklistSummary,
  costLines,
  countByGrade,
  formatUsd,
  gradeLabel,
  sourceLabel,
  subtaskLine,
} from "../src/lib/gateCards.js";
import type { PlanApprovalCardData, VerificationChecklistCardData } from "../src/types.js";

/**
 * 게이트 카드의 문장 — docs/design/state-machine-and-protocol.md 72.4·72.8절.
 *
 * *"사용자가 비용을 보고 승인한다"*가 72절 전체와 product-strategy 13.0.2의 뒤집기를
 * 떠받치는 문장이다. **근거로 쓰는 문장의 실체를 적지 않으면 그 근거는 확인될 수 없다** —
 * 이 파일이 그 실체를 고정한다.
 */

function card(overrides: Partial<PlanApprovalCardData> = {}): PlanApprovalCardData {
  return {
    summary: "요약",
    steps: [],
    subtasks: [],
    estimatedCostUsd: 0.5,
    unpricedAssignments: [],
    estimateCaveats: [],
    escalation: { maxCalls: 2, grade: "frontier", budgetUsd: 0.5 },
    notes: [],
    workspaceFingerprint: null,
    ...overrides,
  };
}

// ---- 금액 ----

test("추정을 실측처럼 보여주지 않는다", () => {
  assert.match(costLines(card()).metered, /추정/);
});

/**
 * **환산되지 않는 배정을 0으로 합산하지 않는다**(72.4절).
 *
 * 합산하면 카드가 "이만큼만 듭니다"라고 거짓을 말한다 — 구독 용량에는 쿼터가 있고
 * 소진되면 어떻게 되는지 그 CLI가 정하지 우리가 모른다.
 */
test("환산되지 않는 배정은 금액이 아니라 따로 말한다", () => {
  const lines = costLines(card({ unpricedAssignments: ["executor: 구독 경로"] }));
  assert.ok(lines.unpriced !== null);
  assert.match(lines.unpriced!, /환산되지 않는/);
  // 그리고 계량 금액 문장에는 섞이지 않는다.
  assert.ok(!lines.metered.includes("구독"));
});

test("환산 불가 배정이 없으면 그 문장을 만들지 않는다", () => {
  // 없는 것을 "0원"으로 적으면 있는 것과 구별되지 않는다.
  assert.equal(costLines(card()).unpriced, null);
});

test("금액이 0인 것은 '공짜'가 아니라 '계량 과금 배정이 없다'이다", () => {
  assert.match(formatUsd(0), /계량 과금/);
  assert.match(formatUsd(0.25), /\$0\.2500/);
  assert.match(formatUsd(Number.NaN), /알 수 없음/);
});

test("봉투는 금액을 말할 수 없으면 횟수만 말한다", () => {
  const unpriceable = costLines(card({ escalation: { maxCalls: 3, grade: "frontier", budgetUsd: null } }));
  assert.match(unpriceable.envelope, /3회/);
  assert.ok(!unpriceable.envelope.includes("$"));
});

// ---- 서브태스크와 등급 ----

/**
 * **`unmeasured`를 `economy`로 접지 않는다**(multi-engine 21.4절).
 * 싸다는 것은 가격에 대한 사실이고 등급은 품질에 대한 사실이다.
 */
test("미측정 등급은 경제형으로 접히지 않는다", () => {
  assert.notEqual(gradeLabel("unmeasured"), gradeLabel("economy"));
});

test("위험 하한선이 올렸으면 무엇 때문인지 말한다", () => {
  const line = subtaskLine({ subtaskId: "s1", intent: "결제 코드", grade: "frontier", riskSegments: ["payment"] });
  // 말하지 않으면 사용자는 "왜 이 조각만 비싼가"에 답을 얻지 못하고, `economy`를 골랐는데
  // `frontier`가 배정된 것을 우리 실수로 읽는다.
  assert.match(line, /payment/);
});

test("하한선이 걸리지 않았으면 사유를 지어내지 않는다", () => {
  const line = subtaskLine({ subtaskId: "s1", intent: "문서 수정", grade: "economy", riskSegments: [] });
  assert.ok(!line.includes("위험"), line);
});

// ---- 체크리스트 ----

function checklist(items: VerificationChecklistCardData["items"]): VerificationChecklistCardData {
  return { items, notes: [], unplannedPaths: [] };
}

/**
 * **미확인을 먼저 말한다**(72.8절).
 *
 * "3/5 확인됨"으로 적으면 분수가 진행률처럼 읽히고 나머지는 "아직 안 한 것"이 된다.
 * 이 경로에서 미확인은 **정상 상태**다(17.9절).
 */
test("요약은 미확인을 먼저 말한다", () => {
  const summary = checklistSummary(
    checklist([
      { text: "a", grade: "verified", source: "plan_outline" },
      { text: "b", grade: "unverified", source: "user_decision" },
    ])
  );
  assert.ok(summary.indexOf("확인하지 못했습니다") < summary.indexOf("확인했습니다"), summary);
});

/**
 * **`flagged_by_review`는 확인이 아니라 경고다.**
 *
 * 이 자리가 가장 조용히 썩을 수 있는 곳이다 — 뚫리면 "측정하지 않은 것을 검증됐다고 말하지
 * 않는다"가 제품 안에서 깨지는데, 증상이 "화면이 더 안심시켜 준다"라 아무도 신고하지 않는다.
 */
test("검토가 지목한 항목은 확인으로 세지 않는다", () => {
  const counts = countByGrade([{ text: "a", grade: "flagged_by_review", source: "plan_outline" }]);
  assert.equal(counts.verified, 0);
  assert.equal(counts.flagged, 1);
});

test("모르는 등급은 미확인으로 센다 — 좋은 쪽으로 접지 않는다", () => {
  const counts = countByGrade([{ text: "a", grade: "looks_fine", source: "plan_outline" }]);
  assert.equal(counts.verified, 0);
  assert.equal(counts.unverified, 1);
});

test("기준이 하나도 없으면 그 사실을 말한다 — 빈 목록을 '전부 확인됨'으로 읽히게 두지 않는다", () => {
  assert.match(checklistSummary(checklist([])), /없습니다/);
});

/**
 * **출처마다 권위가 다르다**(72.2.1절). 섞이면 사용자가 자기가 정한 것과 모델이 추측한 것을
 * 구별하지 못한다.
 */
test("기준의 출처를 구별해 말한다", () => {
  const labels = ["user_decision", "plan_outline", "draft_proposal", "user_message"].map(sourceLabel);
  assert.equal(new Set(labels).size, labels.length, labels.join(" | "));
});
