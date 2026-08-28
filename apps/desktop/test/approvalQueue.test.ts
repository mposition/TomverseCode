import test from "node:test";
import assert from "node:assert/strict";
import { activeRootsFor, buildApprovalQueue, type PendingApproval } from "../src/lib/approvalQueue.js";

/**
 * 승인 큐 — process-architecture.md 11.6①.
 *
 * 동시 실행의 **선행 조건**이다. 승인 모달이 하나인데 N개가 동시에 승인을 요구하면, 화면이
 * 어느 트리의 것인지 말하지 않는 한 사용자는 사실상 무작위로 승인한다.
 */

function approval(id: string, root: string, at: string, origin?: PendingApproval["origin"]): PendingApproval {
  return { approvalId: id, taskId: `task-${id}`, workspaceRoot: root, createdAt: at, origin };
}

const FLEET: PendingApproval[] = [
  approval("ap-2", "/w/tomverse-feat-b", "2026-01-01T00:00:02Z", {
    fleetId: "f1",
    memberIndex: 2,
    fleetSize: 3,
    branch: "feat-b",
  }),
  approval("ap-1", "/w/tomverse-feat-a", "2026-01-01T00:00:01Z", {
    fleetId: "f1",
    memberIndex: 1,
    fleetSize: 3,
    branch: "feat-a",
  }),
  approval("ap-3", "/w/tomverse-feat-c", "2026-01-01T00:00:03Z", {
    fleetId: "f1",
    memberIndex: 3,
    fleetSize: 3,
    branch: "feat-c",
  }),
];

test("도착 순서대로 답한다", () => {
  const queue = buildApprovalQueue(FLEET);
  assert.deepEqual(
    queue.entries.map((e) => e.approvalId),
    ["ap-1", "ap-2", "ap-3"]
  );
  assert.equal(queue.active?.approvalId, "ap-1");
  assert.equal(queue.waiting, 2);
});

/** **경로가 아니라 자리로 구별한다.** 트리 경로는 서로 한 글자만 다르다. */
test("어느 구성원의 요청인지 화면이 읽을 수 있는 이름으로 말한다", () => {
  const queue = buildApprovalQueue(FLEET);
  assert.deepEqual(
    queue.entries.map((e) => e.label),
    ["1/3 · feat-a", "2/3 · feat-b", "3/3 · feat-c"]
  );
});

/** Fleet이 아니면 종전과 같다 — 워크스페이스 이름 하나. */
test("단일 태스크의 승인은 워크스페이스 이름으로 표시된다", () => {
  const queue = buildApprovalQueue([approval("ap-1", "/home/me/myrepo", "2026-01-01T00:00:00Z")]);
  assert.equal(queue.entries[0]!.label, "myrepo");
  assert.equal(queue.waiting, 0);
  assert.equal(queue.spansMultipleRoots, false);
  // 하나뿐이면 큐라고 말하지 않는다 — 없는 문제를 설명하면 있는 경고가 함께 묻힌다.
  assert.deepEqual(queue.notices, []);
});

/**
 * **같은 argv라도 대상 트리가 다르면 다른 동작이다.** 여러 트리가 섞여 있으면 화면이
 * 그 사실을 말해야 한다.
 */
test("서로 다른 트리가 섞여 있으면 그 사실을 경고한다", () => {
  const queue = buildApprovalQueue(FLEET);
  assert.equal(queue.spansMultipleRoots, true);
  const text = queue.notices.join("\n");
  assert.match(text, /3건이 밀려 있습니다/);
  assert.match(text, /실행되는 곳이 다르므로/);
});

/**
 * 응답 범위는 **지금 그리고 있는 것들**이다. 넓게 잡으면 11.5절이 닫은 구멍이 다시 열린다.
 */
test("응답 범위는 큐에 있는 트리들뿐이다", () => {
  const roots = activeRootsFor(buildApprovalQueue(FLEET));
  assert.deepEqual(roots.sort(), ["/w/tomverse-feat-a", "/w/tomverse-feat-b", "/w/tomverse-feat-c"]);
  assert.ok(!roots.includes("/w/other"));
});

/** 같은 시각에 도착한 둘이 순서를 뒤바꾸지 않는다 — 그러면 화면이 새로 그릴 때마다 순서가 바뀐다. */
test("같은 시각이면 안정적인 순서를 쓴다", () => {
  const same = [
    approval("ap-b", "/w/x", "2026-01-01T00:00:00Z"),
    approval("ap-a", "/w/x", "2026-01-01T00:00:00Z"),
  ];
  assert.deepEqual(
    buildApprovalQueue(same).entries.map((e) => e.approvalId),
    ["ap-a", "ap-b"]
  );
  assert.deepEqual(
    buildApprovalQueue([...same].reverse()).entries.map((e) => e.approvalId),
    ["ap-a", "ap-b"]
  );
});

test("빈 큐에는 답할 것이 없다", () => {
  const queue = buildApprovalQueue([]);
  assert.equal(queue.active, undefined);
  assert.equal(queue.waiting, 0);
  assert.deepEqual(activeRootsFor(queue), []);
});
