import { summarizeDiff, type DiffStat } from "./diffSummary.js";

/**
 * diff 파일 목록의 필터와 정렬 — ui-wireframes.md 3.14절.
 *
 * # 문항이 둘을 묶고 있었다
 *
 * 미해결 항목은 "경로 필터나 '변경이 큰 파일부터' 정렬"을 하나로 묶고, 미룬 이유를
 * **"정렬은 적용 순서를 감추므로 그 대가를 먼저 정해야 한다"**로 적었다. 그런데 둘은 대가가
 * 다르다.
 *
 * - **필터는 순서를 바꾸지 않는다.** 행을 숨길 뿐 남은 행은 그대로 적용 순서다.
 * - **정렬만 순서를 대체한다.**
 *
 * 그리고 정렬의 대가("순서를 잃는다")는 **순번을 함께 보여주면 치르지 않아도 된다.** 각 행에
 * 적용 순번을 붙이면 재배열돼도 원래 위치를 읽을 수 있다. 남는 것은 *인접성*뿐이다 —
 * 같은 파일을 두 번 고친 기록이 정렬 후 떨어질 수 있고, 그건 순번으로도 복원되지 않는다.
 * 그래서 기본은 적용 순서이고, 정렬은 사용자가 고른 상태로만 켜진다.
 *
 * # 필터의 대가는 따로 있다
 *
 * **숨긴 것을 모르게 하는 것이다.** 이 화면의 목적은 "이 변경을 받아들일지 판단"이고
 * 되돌리기는 **전부 아니면 전무**다. 필터가 걸러낸 파일이 있는데 화면이 그 사실을 말하지
 * 않으면, 사용자는 일부만 보고 전체를 판단한다. 그래서 숨긴 개수와 그 합계를 함께 돌려준다.
 *
 * **요약 숫자는 필터를 따르지 않는다.** 헤더의 "변경된 파일 (12)"가 필터를 따라 줄어들면
 * 되돌리기 범위(전체)와 화면의 숫자가 어긋난다 — 필터는 **보기**이지 **범위**가 아니다.
 */

/** 정렬 기준. 기본은 적용 순서다. */
export type DiffSort = "applied" | "changes" | "path";

export interface DiffRow {
  path: string;
  diff: string;
  /**
   * 적용 순번(0-base). **정렬해도 이 값은 그대로다** — 화면이 이걸 표시해야 정렬이
   * 순서를 감추지 않는다.
   */
  appliedIndex: number;
  stat: DiffStat;
}

export interface DiffView {
  rows: DiffRow[];
  /** 필터가 숨긴 파일 수. **0이 아니면 화면이 반드시 말해야 한다.** */
  hiddenFiles: number;
  /** 숨긴 파일들의 +/− 합계. 개수만으로는 "무엇을 놓쳤는가"의 크기를 알 수 없다. */
  hiddenAdded: number;
  hiddenRemoved: number;
  /** 필터 문자열이 실제로 걸려 있는가. `0건`이 "변경 없음"인지 "다 걸러짐"인지 가른다. */
  filtered: boolean;
}

/** 목록의 원본 — 적용 순서 그대로, 각 행에 순번과 통계를 붙인다. */
export function buildRows(diffs: readonly (readonly [string, string])[]): DiffRow[] {
  return diffs.map(([path, diff], appliedIndex) => ({
    path,
    diff,
    appliedIndex,
    stat: summarizeDiff(diff),
  }));
}

/**
 * 경로 필터. **대소문자를 구별하지 않는 부분 문자열**이다.
 *
 * 글롭(`src/**\/*.ts`)을 쓰지 않는 이유: 이 입력란은 "지금 이 목록에서 찾기"에 쓰이고,
 * 글롭은 기대와 어긋날 때 **왜 안 걸리는지 설명이 필요하다.** 부분 문자열은 틀릴 여지가 없다.
 * 앞뒤 공백은 버린다 — 붙여넣은 경로에 딸려오는 공백 때문에 0건이 되면 사용자는 필터가
 * 고장 났다고 읽는다.
 */
export function matchesFilter(path: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return true;
  return path.toLowerCase().includes(needle);
}

function compare(a: DiffRow, b: DiffRow, sort: DiffSort): number {
  if (sort === "changes") {
    const delta = b.stat.added + b.stat.removed - (a.stat.added + a.stat.removed);
    // **동점은 적용 순서로 푼다.** 풀지 않으면 같은 변경이 렌더마다 다르게 보일 수 있고,
    // 그러면 사용자는 화면이 바뀌었다고 읽는다.
    return delta !== 0 ? delta : a.appliedIndex - b.appliedIndex;
  }
  if (sort === "path") {
    // `localeCompare`를 쓰지 않는다 — 결과가 환경의 ICU 데이터에 따라 달라지면 두 사람이
    // 같은 목록을 보고도 다른 순서를 본다. 코드포인트 비교는 어디서나 같다.
    if (a.path === b.path) return a.appliedIndex - b.appliedIndex;
    return a.path < b.path ? -1 : 1;
  }
  return a.appliedIndex - b.appliedIndex;
}

/** 필터와 정렬을 적용한 보기. 숨긴 것은 값으로 함께 돌려준다. */
export function viewDiffs(
  diffs: readonly (readonly [string, string])[],
  options: { filter?: string; sort?: DiffSort } = {}
): DiffView {
  const sort = options.sort ?? "applied";
  const filter = options.filter ?? "";
  const all = buildRows(diffs);
  const rows = all.filter((row) => matchesFilter(row.path, filter));

  const hidden = all.filter((row) => !matchesFilter(row.path, filter));
  return {
    rows: [...rows].sort((a, b) => compare(a, b, sort)),
    hiddenFiles: hidden.length,
    hiddenAdded: hidden.reduce((sum, row) => sum + row.stat.added, 0),
    hiddenRemoved: hidden.reduce((sum, row) => sum + row.stat.removed, 0),
    filtered: filter.trim() !== "",
  };
}

/**
 * 목록에 붙일 안내 문구. `null`이면 붙일 것이 없다.
 *
 * 세 상태를 구별한다: 숨긴 것이 있음 / 필터가 전부 걸러냄 / 아무 일 없음.
 * 뒤의 둘을 합치면 "0건"이 **"변경이 없다"인지 "필터 때문에 안 보인다"인지** 구별되지 않는다.
 */
export function hiddenNotice(view: DiffView): string | null {
  if (view.hiddenFiles === 0) return null;
  if (view.rows.length === 0) {
    return `필터에 걸리는 파일이 없습니다 — 변경된 파일 ${view.hiddenFiles}개가 필터에 가려져 있습니다 (+${view.hiddenAdded} −${view.hiddenRemoved}).`;
  }
  return `필터로 ${view.hiddenFiles}개를 숨겼습니다 (+${view.hiddenAdded} −${view.hiddenRemoved}). 되돌리기는 숨긴 파일까지 전부에 적용됩니다.`;
}
