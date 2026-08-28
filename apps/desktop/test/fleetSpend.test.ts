import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFleetOutcome, summarizeFleetSpend } from "../src/lib/fleetSpend.js";

/**
 * Fleet 합계 지출 — process-architecture.md 11.6②.
 *
 * 태스크당 상한은 그대로 두되 **합계를 보여줘야 하고, 그 합계가 무엇의 합인지 화면이 말해야
 * 한다.** 아래 검사들은 두 번째 절반을 지킨다 — 첫 절반(더하기)만 지키면 큰 숫자 하나가
 * "이 작업의 비용"으로 읽혀서, 태스크 단위 화면보다 더 틀린 화면이 된다.
 */

const MEMBERS = [
  { branch: "feat-a", costUsd: 0.5, status: "completed" },
  { branch: "feat-b", costUsd: 0.25, status: "failed" },
  { branch: "feat-c", costUsd: 0, status: "not_started" },
];

test("합계는 구성원 지출의 합이다", () => {
  const view = summarizeFleetSpend({ members: MEMBERS, fleetCapUsd: 5, perTaskCapUsd: 2 });
  assert.equal(view.fleetCostUsd, 0.75);
  assert.equal(view.memberCount, 3);
});

/** **첫 줄이 "이것은 합계다"여야 한다.** 없으면 사용자는 이 숫자를 한 작업의 비용으로 읽는다. */
test("합계가 무엇의 합인지 화면이 말한다", () => {
  const view = summarizeFleetSpend({ members: MEMBERS, fleetCapUsd: 5, perTaskCapUsd: 2 });
  assert.match(view.notices[0]!, /합계/);
  assert.match(view.notices[0]!, /어느 한 작업의 금액이 아닙니다/);
});

/**
 * **"상한 안에서 끝났다"와 "상한이 없었다"는 정반대의 사실이다.**
 *
 * 그리고 태스크당 상한이 있는 것을 합계 상한으로 읽지 않게 한다 — 그게 11.2②가 지적한
 * 바로 그 착각이다.
 */
test("합계 상한이 없으면 그렇게 말하고, 태스크당 상한을 합계로 오인하지 않게 한다", () => {
  const view = summarizeFleetSpend({ members: MEMBERS, fleetCapUsd: null, perTaskCapUsd: 2 });
  assert.equal(view.capEnforced, false);
  const text = view.notices.join("\n");
  assert.match(text, /합계 상한이 없었습니다/);
  assert.match(text, /합계를 통제하지 않습니다/);
});

test("합계 상한이 있으면 무엇이 강제됐는지 말한다", () => {
  const view = summarizeFleetSpend({ members: MEMBERS, fleetCapUsd: 5, perTaskCapUsd: 2 });
  assert.equal(view.capEnforced, true);
  const text = view.notices.join("\n");
  assert.match(text, /합계 상한 \$5\.00/);
  assert.match(text, /새 작업을 시작하지 않습니다/);
});

/** 가격을 모르는 호출이 있으면 합계는 **하한이다.** 모르는 비용을 0으로 더하고 정확한 값처럼 쓰지 않는다. */
test("가격을 모르는 호출이 있으면 하한이라고 말한다", () => {
  const view = summarizeFleetSpend({
    members: [{ branch: "a", costUsd: 1, status: "completed", unpricedCalls: 2 }],
    fleetCapUsd: null,
    perTaskCapUsd: null,
  });
  assert.equal(view.approximate, true);
  assert.match(view.notices[0]!, /^≥ /);
  assert.match(view.notices.join("\n"), /하한/);
});

/** **시작되지 않은 것은 실패가 아니다.** 사용자가 다음에 할 일이 다르다. */
test("미시작을 실패와 뭉치지 않는다", () => {
  const view = summarizeFleetSpend({ members: MEMBERS, fleetCapUsd: 5, perTaskCapUsd: 2 });
  assert.equal(view.notStartedCount, 1);
  assert.match(view.notices.join("\n"), /실패와 다른 결말/);
});

/** **부분 실패를 성공으로 접지 않는다.** "완료"는 전부 완료됐을 때만 참이다. */
test("하나라도 완료가 아니면 완료로 접지 않는다", () => {
  const partial = summarizeFleetOutcome(MEMBERS);
  assert.equal(partial.allCompleted, false);
  assert.match(partial.headline, /실패 1/);
  assert.match(partial.headline, /미시작 1/);

  const all = summarizeFleetOutcome([
    { branch: "a", costUsd: 0, status: "completed" },
    { branch: "b", costUsd: 0, status: "completed" },
  ]);
  assert.equal(all.allCompleted, true);
  assert.equal(all.headline, "2개 모두 완료");
});

/** 빈 Fleet을 "모두 완료"로 읽지 않는다 — 아무 일도 없었던 것은 성공이 아니다. */
test("구성원이 없으면 모두 완료가 아니다", () => {
  assert.equal(summarizeFleetOutcome([]).allCompleted, false);
});
