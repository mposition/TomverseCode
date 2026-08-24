import test from "node:test";
import assert from "node:assert/strict";
import { describeWithdrawal, summarize, toViews, type DecisionRow } from "../src/lib/carriedDecisions.js";

function row(overrides: Partial<DecisionRow>): DecisionRow {
  return {
    taskId: "task-1",
    criterionId: "c-1",
    text: "1페이지는 첫 항목부터",
    decidedAt: "2026-01-01T00:00:00Z",
    inForce: true,
    withdrawable: true,
    ...overrides,
  };
}

/**
 * **거둔 것이 목록에서 사라지지 않는다.** 사라지면 "사라졌다"와 "거뒀다"가 화면에서 같은
 * 모양이 되고, 사용자는 자기가 무엇을 거뒀는지 확인할 방법이 없다.
 */
test("거둔 판정도 목록에 남고 상태로 구별된다", () => {
  const views = toViews([
    row({ criterionId: "c-1" }),
    row({ criterionId: "c-2", inForce: false, withdrawable: false, refusal: "already_withdrawn", withdrawnAt: "2026-02-02T00:00:00Z" }),
  ]);
  assert.equal(views.length, 2);
  assert.equal(views[0].status, "in_force");
  assert.equal(views[1].status, "withdrawn");
});

/** 이유마다 사용자가 다음에 할 일이 다르다 — "안 됨"으로 뭉개면 그 차이가 사라진다. */
test("거둘 수 없는 이유가 이유마다 다른 문장이 된다", () => {
  const running = toViews([row({ withdrawable: false, refusal: "task_still_running" })])[0];
  const already = toViews([row({ inForce: false, withdrawable: false, refusal: "already_withdrawn" })])[0];
  assert.ok(running.blockedReason?.includes("진행 중"), `${running.blockedReason}`);
  assert.ok(already.blockedReason?.includes("이미"), `${already.blockedReason}`);
  assert.notEqual(running.blockedReason, already.blockedReason);
});

test("거둘 수 있으면 막는 이유가 없다", () => {
  assert.equal(toViews([row({})])[0].blockedReason, null);
});

/** **두 수를 한 값에 뭉개지 않는다** — 합쳐서 "N건"만 보이면 무엇이 실리는지 알 수 없다. */
test("실리는 개수와 거둔 개수를 따로 센다", () => {
  const summary = summarize([
    row({ criterionId: "c-1" }),
    row({ criterionId: "c-2" }),
    row({ criterionId: "c-3", inForce: false }),
  ]);
  assert.equal(summary.inForce, 2);
  assert.equal(summary.withdrawn, 1);
  assert.ok(summary.headline.includes("2건"), summary.headline);
  assert.ok(summary.headline.includes("거둔 1건"), summary.headline);
});

/** 하나도 없을 때 "0건이 실립니다"라고 쓰면 있었는데 전부 빠진 것처럼 읽힌다. */
test("판정이 없으면 개수를 세지 않고 없다고 말한다", () => {
  const summary = summarize([]);
  assert.equal(summary.inForce, 0);
  assert.ok(!summary.headline.includes("0건"), summary.headline);
  assert.ok(summary.headline.includes("아직 없습니다"), summary.headline);
});

/**
 * **"삭제했습니다"라고 쓰지 않는다.** 지워지지 않는다 — 그 태스크의 기준 기록은 남고,
 * 바뀌는 것은 다음 태스크로 나르는가 하나다.
 */
test("성공 문장이 무엇이 남는지까지 말한다", () => {
  const text = describeWithdrawal({ withdrawn: true });
  assert.ok(!text.includes("삭제"), text);
  assert.ok(text.includes("실리지 않습니다"), text);
  assert.ok(text.includes("기록은 그대로 남습니다"), text);
});

/** 원인을 지어내지 않는다 — 호스트가 준 사유를 그대로 쓰고, 없으면 없다고 쓴다. */
test("거절 문장은 호스트가 준 사유를 그대로 쓴다", () => {
  assert.equal(
    describeWithdrawal({ withdrawn: false, detail: "이미 거둔 판정입니다" }),
    "이미 거둔 판정입니다"
  );
  assert.ok(describeWithdrawal({ withdrawn: false }).includes("기록되지 않았습니다"));
});
