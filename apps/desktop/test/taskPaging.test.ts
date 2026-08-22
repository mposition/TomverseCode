import test from "node:test";
import assert from "node:assert/strict";
import type { TaskRow } from "../src/types.js";
import {
  EMPTY_TASK_LIST,
  appendPage,
  countLabel,
  firstPage,
  hasMore,
} from "../src/lib/taskPaging.js";

/**
 * "더 보기" 이어 붙이기 — ui-wireframes.md 5절.
 *
 * 여기서 검증하는 실패들은 **화면에서 정상으로 보인다**: 중복된 행은 늘어난 작업처럼 보이고,
 * 전진하지 않는 커서는 그냥 버튼이 계속 눌리는 것처럼 보인다. 그래서 순수 함수로 뺐다.
 */

function row(taskId: string, updatedAt = "2030-01-01T00:00:00Z"): TaskRow {
  return {
    taskId,
    sessionId: "sess-1",
    workspaceId: "ws-1",
    workspacePath: "/tmp/ws",
    mode: "verified",
    userMessage: `msg ${taskId}`,
    currentPhase: "COMPLETED",
    terminalStatus: "COMPLETED",
    errorSummary: null,
    cancellationRequestedAt: null,
    mutationCount: 0,
    createdAt: "2030-01-01T00:00:00Z",
    updatedAt,
  };
}

test("첫 페이지는 커서를 그대로 들고 간다 — 형식을 화면이 해석하지 않는다", () => {
  const state = firstPage({ tasks: [row("a"), row("b")], nextCursor: "2030-01-01T00:00:00Z|b" });
  assert.deepEqual(
    state.tasks.map((t) => t.taskId),
    ["a", "b"]
  );
  assert.equal(state.cursor, "2030-01-01T00:00:00Z|b");
  assert.equal(hasMore(state), true);
});

test("마지막 페이지는 '더 보기'를 띄우지 않는다", () => {
  const state = firstPage({ tasks: [row("a")], nextCursor: null });
  assert.equal(hasMore(state), false);
  assert.equal(state.reachedEnd, true);
});

test("다음 페이지는 뒤에 붙는다 — 순서가 뒤집히면 목록이 시간 순서를 잃는다", () => {
  const first = firstPage({ tasks: [row("a"), row("b")], nextCursor: "c1" });
  const next = appendPage(first, { tasks: [row("c"), row("d")], nextCursor: "c2" });
  assert.deepEqual(
    next.tasks.map((t) => t.taskId),
    ["a", "b", "c", "d"]
  );
  assert.equal(next.cursor, "c2");
});

/**
 * "더 보기"를 두 번 누르면 같은 페이지가 두 번 온다. 그대로 붙이면 목록이 길어지고,
 * 사용자에게 그건 오류가 아니라 **작업이 늘어난 것**으로 보인다.
 */
test("같은 페이지가 두 번 와도 행이 늘어나지 않는다", () => {
  const first = firstPage({ tasks: [row("a"), row("b")], nextCursor: "c1" });
  const page = { tasks: [row("c"), row("d")], nextCursor: "c2" };
  const once = appendPage(first, page);
  const twice = appendPage(once, page);
  assert.deepEqual(
    twice.tasks.map((t) => t.taskId),
    ["a", "b", "c", "d"]
  );
});

/** 중복된 행은 **나중에 받은 내용**으로 갱신한다 — 나중 응답이 더 최근의 DB 상태다. */
test("중복된 행은 나중 응답의 내용으로 갱신된다", () => {
  const stale = { ...row("a"), terminalStatus: null, currentPhase: "EXECUTING" as TaskRow["currentPhase"] };
  const first = firstPage({ tasks: [stale], nextCursor: "c1" });
  const next = appendPage(first, { tasks: [row("a")], nextCursor: null });
  assert.equal(next.tasks.length, 1);
  assert.equal(next.tasks[0].terminalStatus, "COMPLETED");
});

/**
 * 커서가 전진하지 않으면 다음 "더 보기"도 같은 페이지를 준다 — 눌러도 아무 일이 없는
 * 버튼이 남는다. 끝으로 취급해 버튼을 치운다.
 */
test("전진하지 않는 커서는 끝으로 취급한다", () => {
  const first = firstPage({ tasks: [row("a")], nextCursor: "c1" });
  const next = appendPage(first, { tasks: [row("b")], nextCursor: "c1" });
  assert.equal(hasMore(next), false);
  assert.deepEqual(
    next.tasks.map((t) => t.taskId),
    ["a", "b"]
  );
});

/** 빈 페이지가 와도 커서 상태는 응답을 따른다 — 화면이 커서를 지어내지 않는다. */
test("빈 다음 페이지는 목록을 바꾸지 않고 끝을 표시한다", () => {
  const first = firstPage({ tasks: [row("a")], nextCursor: "c1" });
  const next = appendPage(first, { tasks: [], nextCursor: null });
  assert.deepEqual(
    next.tasks.map((t) => t.taskId),
    ["a"]
  );
  assert.equal(next.reachedEnd, true);
});

/**
 * 새로고침은 **이미 읽은 페이지를 버린다.** 목록은 `updated_at` 내림차순이므로 그 사이
 * 어떤 작업이 갱신되면 순서가 통째로 바뀐다 — 옛 페이지를 남기면 어느 시점에도 존재한 적
 * 없는 목록이 만들어진다.
 */
test("새로고침은 이어 붙이지 않고 처음부터 다시 만든다", () => {
  const paged = appendPage(firstPage({ tasks: [row("a"), row("b")], nextCursor: "c1" }), {
    tasks: [row("c")],
    nextCursor: "c2",
  });
  const refreshed = firstPage({ tasks: [row("b"), row("a")], nextCursor: "c1" });
  assert.deepEqual(
    paged.tasks.map((t) => t.taskId),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    refreshed.tasks.map((t) => t.taskId),
    ["b", "a"]
  );
});

/**
 * 건수 표기는 **모르는 것을 아는 척하지 않는다.** 전체 건수를 세지 않기로 했으므로
 * (세려면 매 페이지마다 전체 스캔이 붙는다) 더 있을 때는 "이상"을 붙인다.
 */
test("더 읽을 것이 남았으면 건수에 '이상'을 붙인다", () => {
  assert.equal(countLabel(firstPage({ tasks: [row("a")], nextCursor: "c1" })), "1건 이상");
  assert.equal(countLabel(firstPage({ tasks: [row("a")], nextCursor: null })), "1건");
  assert.equal(countLabel(EMPTY_TASK_LIST), "0건");
});
