/**
 * 격리 트리 목록을 **화면 문장으로** 옮긴다 — state-machine 38절.
 *
 * # 이 자리에서 하기 쉬운 거짓말
 *
 * ① **남의 트리를 목록에서 지우는 것.** 사용자가 손으로 만든 worktree도 브랜치를 잡고 있어서
 *    "왜 이 브랜치로 격리할 수 없는가"의 답이 된다. 지우면 그 답이 사라진다. 대신 **정리
 *    대상에서 빼고** 그 이유를 말한다(22.6절).
 *
 * ② **더러운 트리를 지울 수 있는 것처럼 보이게 두는 것.** 누른 뒤에 거절당하는 것보다, 무엇을
 *    버리게 되는지 먼저 말하는 편이 낫다.
 *
 * ③ **지금 도는 트리를 정리 대상에 넣는 것.** 지우면 게이트 루트가 사라진 채로 세션이 살아
 *    있게 된다 — Rust도 막지만, 막힌 뒤에 알리는 것은 알린 것이 아니다.
 */

export interface WorktreeRow {
  path: string;
  branch: string;
  /** 우리가 만든 트리인가 (`tomverse-` 접두사). */
  ours: boolean;
  dirty: boolean;
  /** 지금 이 워크스페이스가 도는 트리인가. */
  active: boolean;
}

export interface TreeLabel {
  path: string;
  text: string;
  /** 정리 버튼을 낼 수 있는가. */
  removable: boolean;
  /** 지우려면 커밋되지 않은 변경을 **버려야** 하는가. */
  needsForce: boolean;
  /** 지울 수 없다면 왜인가. 없으면 지울 수 있다는 뜻이다. */
  reason?: string;
}

export function labelTree(row: WorktreeRow): TreeLabel {
  const base = { path: row.path, text: `${row.branch} — ${row.path}`, needsForce: row.dirty };
  if (row.active) {
    return {
      ...base,
      removable: false,
      needsForce: false,
      reason: "지금 이 워크스페이스가 도는 트리입니다 — 다른 워크스페이스를 연 뒤에 정리하세요.",
    };
  }
  if (!row.ours) {
    return {
      ...base,
      removable: false,
      needsForce: false,
      reason: "이 앱이 만든 트리가 아닙니다 — 손대지 않습니다.",
    };
  }
  return { ...base, removable: true };
}

export interface TreeSummary {
  headline: string;
  /** 우리가 만든 것. */
  ours: WorktreeRow[];
  /** 사용자가 손으로 만든 것. **목록에서 지우지 않는다** — 브랜치를 잡고 있는 이유가 된다. */
  theirs: WorktreeRow[];
}

export function summarizeTrees(rows: WorktreeRow[]): TreeSummary {
  const ours = rows.filter((r) => r.ours);
  const theirs = rows.filter((r) => !r.ours);
  if (rows.length === 0) {
    return { headline: "격리 트리가 없습니다.", ours, theirs };
  }
  const dirty = ours.filter((r) => r.dirty).length;
  // **두 수를 따로 센다.** 합치면 "3개 정리 가능"이 거짓이 된다.
  const dirtyNote = dirty > 0 ? ` (커밋되지 않은 변경이 있는 것 ${dirty}개)` : "";
  return { headline: `이 앱이 만든 격리 트리 ${ours.length}개${dirtyNote}`, ours, theirs };
}

/**
 * 버리기 전에 **무엇을 버리는지** 말한다.
 *
 * `force`는 사용자의 커밋되지 않은 작업을 지우는 행위다(22.6절). 확인 문구가 브랜치 이름만
 * 말하면 사용자는 "빈 트리를 치운다"로 읽는다.
 */
export function confirmRemoval(row: WorktreeRow): string {
  if (!row.dirty) return `${row.branch} 트리를 정리합니다.`;
  return `${row.branch} 트리에 커밋되지 않은 변경이 있습니다. 정리하면 그 변경은 **사라지고 되돌릴 수 없습니다**.`;
}
