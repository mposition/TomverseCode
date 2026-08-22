import type { TaskRow } from "../types";

/**
 * 최근 작업 목록의 "더 보기" 상태 — ui-wireframes.md 5절.
 *
 * 화면 안에서 `setTasks([...tasks, ...page.tasks])`로 끝낼 수도 있었지만 그러지 않은 이유:
 * 이어 붙이기에는 **눈으로 잡히지 않는 실패 방식**이 여럿 있다. 같은 행이 두 번 붙어도
 * 사용자는 그걸 "작업이 늘었다"로 읽고, 커서가 전진하지 않아도 버튼이 계속 눌리기만 한다.
 * 둘 다 화면에서는 정상으로 보인다. 그래서 순수 함수로 빼서 테스트한다.
 */

/**
 * 한 페이지 크기.
 *
 * 50이던 "최근 50건 고정"을 그대로 페이지 크기로 쓴다 — 한 화면에 얼마가 적당한지는 아직
 * 실측이 없고, **바꿀 이유가 없는 숫자를 이 변경에서 함께 바꾸면** 페이지네이션이 목록을
 * 바꿨는지 크기가 바꿨는지 구별할 수 없게 된다. Rust 쪽 상한은 200이다.
 */
export const TASK_PAGE_SIZE = 50;

/** `list_tasks` 명령의 반환값. `nextCursor`가 `null`이면 마지막 페이지다. */
export interface TaskPage {
  tasks: TaskRow[];
  nextCursor: string | null;
}

export interface TaskListState {
  tasks: TaskRow[];
  /** 다음 페이지를 요청할 커서. **형식은 Rust가 정하고 화면은 그대로 되돌려준다.** */
  cursor: string | null;
  /** 더 읽을 것이 없다고 확인된 상태. `cursor === null`과 같지만 이름이 의도를 말한다. */
  reachedEnd: boolean;
}

export const EMPTY_TASK_LIST: TaskListState = { tasks: [], cursor: null, reachedEnd: false };

/**
 * 첫 페이지 — 새로고침과 워크스페이스 전환이 여기로 온다.
 *
 * **이미 읽은 뒤 페이지를 버린다.** 목록은 `updated_at` 내림차순인데 그 사이 어떤 작업이
 * 갱신되면 순서가 통째로 바뀐다. 옛 페이지를 남겨 두면 새 1페이지와 옛 3페이지가 한 화면에
 * 섞이고, 그 목록은 어느 시점에도 존재한 적 없는 목록이다.
 */
export function firstPage(page: TaskPage): TaskListState {
  return {
    tasks: [...page.tasks],
    cursor: page.nextCursor,
    reachedEnd: page.nextCursor === null,
  };
}

/**
 * 다음 페이지를 이어 붙인다.
 *
 * 두 가지를 방어한다.
 *
 * 1. **중복.** "더 보기"를 두 번 누르면 같은 커서로 같은 페이지가 두 번 온다. 그대로 붙이면
 *    목록이 길어지고 사용자는 그것을 데이터로 읽는다. `taskId`로 걸러내되, 이미 있는 행은
 *    **나중에 받은 내용으로 갱신한다** — 나중 응답이 더 최근의 DB 상태이기 때문이다.
 * 2. **전진하지 않는 커서.** 같은 커서가 되돌아오면 다음 "더 보기"도 같은 페이지를 준다.
 *    무한히 누를 수 있는 버튼이 되므로 끝으로 취급한다.
 *
 * 방어하지 **못하는** 것도 적어 둔다: 페이지 사이에 갱신된 작업은 목록 위쪽으로 이동하므로
 * 아직 안 읽은 페이지에서 **사라질 수 있다.** 커서 하나로는 스냅샷을 흉내 낼 수 없고,
 * 이걸 없애려면 조회 전체를 한 트랜잭션으로 묶어야 한다. 새로고침이 그 자리를 대신한다.
 */
export function appendPage(state: TaskListState, page: TaskPage): TaskListState {
  const index = new Map(state.tasks.map((t, i) => [t.taskId, i]));
  const tasks = [...state.tasks];
  for (const row of page.tasks) {
    const at = index.get(row.taskId);
    if (at === undefined) {
      index.set(row.taskId, tasks.length);
      tasks.push(row);
    } else {
      tasks[at] = row;
    }
  }
  const stuck = page.nextCursor !== null && page.nextCursor === state.cursor;
  const cursor = stuck ? null : page.nextCursor;
  return { tasks, cursor, reachedEnd: cursor === null };
}

/** "더 보기" 버튼을 띄울지. 커서가 없으면 마지막 페이지이므로 버튼도 없다. */
export function hasMore(state: TaskListState): boolean {
  return state.cursor !== null;
}

/**
 * 목록 아래에 적을 건수 표기.
 *
 * `50건`이라고만 쓰면 그것이 전부인지 첫 페이지인지 구별되지 않는다 — 전체 건수를 세지
 * **않기로 했으므로**(세려면 매 페이지마다 전체 스캔이 붙는다) 모른다는 사실을 표기에 남긴다.
 */
export function countLabel(state: TaskListState): string {
  return hasMore(state) ? `${state.tasks.length}건 이상` : `${state.tasks.length}건`;
}
