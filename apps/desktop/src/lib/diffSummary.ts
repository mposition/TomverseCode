/**
 * diff 요약과 잘라내기 — ui-wireframes.md 3.14절.
 *
 * # 왜 순수 함수로 빼는가
 *
 * 화면 안에 두면 **검증할 방법이 없다.** 이 계산이 틀리면 사용자는 "변경 12줄"을 보고 판단하는데
 * 실제로는 120줄일 수 있고, 그 오류는 눈으로 잡히지 않는다. 그래서 계산은 여기 두고 화면은
 * 그리기만 한다 — 이 파일이 `apps/desktop`에 테스트 하네스가 생긴 이유이기도 하다.
 */

export interface DiffStat {
  added: number;
  removed: number;
  /** diff 텍스트의 총 줄 수. 렌더 비용은 여기에 비례한다. */
  lines: number;
}

/**
 * 한 파일 diff의 +/− 줄 수.
 *
 * **`+++`/`---` 헤더를 세지 않는다.** unified diff의 파일 헤더는 `+`/`-`로 시작하지만 변경된
 * 줄이 아니다 — 세면 모든 파일이 +1/−1씩 부풀려진다.
 */
export function summarizeDiff(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  let lines = 0;
  for (const line of diff.split("\n")) {
    lines += 1;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed, lines };
}

export interface ChangeSummary {
  files: number;
  added: number;
  removed: number;
  lines: number;
}

/** 변경 전체의 요약. 결과 화면이 "무엇을 판단해야 하는가"를 한 줄로 말하는 데 쓴다. */
export function summarizeChange(diffs: readonly (readonly [string, string])[]): ChangeSummary {
  const total: ChangeSummary = { files: diffs.length, added: 0, removed: 0, lines: 0 };
  for (const [, diff] of diffs) {
    const stat = summarizeDiff(diff);
    total.added += stat.added;
    total.removed += stat.removed;
    total.lines += stat.lines;
  }
  return total;
}

/**
 * 한 파일에서 **한 번에 그릴 줄 수의 기본 상한.**
 *
 * **유도하지 못한 상수다.** 필요한 이유는 분명하다: 한 파일의 diff가 수만 줄이면 그 줄 수만큼
 * DOM 노드가 생겨 화면이 멈춘다. 값의 근거는 "사람이 한 번에 읽지 않는 양"이고, 그건 관측이
 * 아니라 판단이다.
 */
export const DEFAULT_DIFF_LINE_CAP = 800;

export interface VisibleDiff {
  text: string;
  /** 감춘 줄 수. **0이 아니면 화면이 반드시 말해야 한다** — 조용히 자르면 사용자는 그게 전부인 줄 안다. */
  hidden: number;
}

/**
 * 상한까지만 잘라 준다.
 *
 * **자른 사실을 값으로 돌려준다.** 잘라 놓고 그 사실을 화면이 모르면, 사용자는 잘린 diff를
 * 전체로 읽고 판단한다 — 이 화면의 목적이 "이 변경을 받아들일지 판단"이므로 그건 판단의 근거를
 * 조용히 바꾸는 것이다.
 *
 * 잘린 내용이 어디에도 없는 것은 아니다: 전체 diff는 `task_events`와 감사 export에 남는다.
 * 그래서 여기서 자르는 것은 **읽기 보조를 줄이는 것이지 기록을 줄이는 것이 아니다.**
 */
export function visibleDiff(diff: string, cap: number = DEFAULT_DIFF_LINE_CAP): VisibleDiff {
  const lines = diff.split("\n");
  if (cap <= 0) return { text: "", hidden: lines.length };
  if (lines.length <= cap) return { text: diff, hidden: 0 };
  return { text: lines.slice(0, cap).join("\n"), hidden: lines.length - cap };
}
