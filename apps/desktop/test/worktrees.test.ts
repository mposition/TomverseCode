import test from "node:test";
import assert from "node:assert/strict";
import { confirmRemoval, labelTree, summarizeTrees, type WorktreeRow } from "../src/lib/worktrees.js";

const row = (over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path: "/state/worktrees/tomverse-b",
  branch: "b",
  ours: true,
  dirty: false,
  active: false,
  ...over,
});

/** **지금 도는 트리를 지우면 게이트 루트가 사라진 채로 세션이 산다.** 버튼을 내지 않는다. */
test("지금 도는 트리는 정리 대상이 아니다", () => {
  const label = labelTree(row({ active: true }));
  assert.equal(label.removable, false);
  assert.match(label.reason ?? "", /도는 트리/);
});

/** 남의 트리는 **목록에는 남고** 정리 대상에서만 빠진다 — 브랜치를 잡고 있는 이유가 된다. */
test("우리가 만들지 않은 트리는 손대지 않는다", () => {
  const label = labelTree(row({ ours: false }));
  assert.equal(label.removable, false);
  assert.match(label.reason ?? "", /만든 트리가 아닙니다/);
});

/** 더러운 트리도 **지울 수는 있다** — 다만 무엇을 버리는지 먼저 말한다. */
test("더러운 트리는 버릴 것을 먼저 말한다", () => {
  const label = labelTree(row({ dirty: true }));
  assert.equal(label.removable, true);
  assert.equal(label.needsForce, true);
  const text = confirmRemoval(row({ dirty: true }));
  assert.match(text, /되돌릴 수 없습니다/);
  // 깨끗한 트리에는 그 경고를 붙이지 않는다 — 매번 나오는 경고는 읽히지 않는다.
  assert.doesNotMatch(confirmRemoval(row()), /되돌릴 수 없습니다/);
});

/** **두 수를 따로 센다.** 합치면 "3개 정리 가능"이 거짓이 된다. */
test("더러운 트리 수를 따로 센다", () => {
  const summary = summarizeTrees([row(), row({ path: "/x", branch: "c", dirty: true })]);
  assert.match(summary.headline, /2개/);
  assert.match(summary.headline, /1개/);
});

/** 남의 트리는 **가르되 버리지 않는다.** */
test("남의 트리도 목록에 남는다", () => {
  const summary = summarizeTrees([row(), row({ path: "/mine", branch: "hand", ours: false })]);
  assert.equal(summary.ours.length, 1);
  assert.equal(summary.theirs.length, 1);
  // headline이 세는 것은 **우리 것**이다 — 남의 것을 세면 정리 가능 개수가 부풀려진다.
  assert.match(summary.headline, /1개/);
});

test("비어 있으면 0개라고 쓰지 않는다", () => {
  const summary = summarizeTrees([]);
  assert.doesNotMatch(summary.headline, /0개/);
});
