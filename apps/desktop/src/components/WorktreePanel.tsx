import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmRemoval, labelTree, summarizeTrees, type WorktreeRow } from "../lib/worktrees";

/**
 * 격리 트리 목록과 정리 — state-machine 38절, 22.6절.
 *
 * # 왜 화면에 있어야 하는가
 *
 * 격리 실행은 트리를 **남긴다**(22.6절: 기본적으로 지우지 않는다). 지우는 길이 CLI에만 있으면
 * 트리는 사용자가 모르는 채로 쌓이고, 같은 브랜치로 다시 격리하려 할 때 "이미 체크아웃되어
 * 있습니다"로 막힌다 — 그 이유를 볼 자리가 화면에 없다.
 *
 * # 우리가 만들지 않은 것은 목록에 남기되 손대지 않는다
 *
 * 사용자가 손으로 만든 worktree도 브랜치를 잡고 있으므로 "왜 이 브랜치를 못 쓰는가"의 답이
 * 된다. 지우면 그 답이 사라지고, 정리 대상에 넣으면 남의 작업을 지운다.
 */
export function WorktreePanel({ isolatedPath }: { isolatedPath: string | null }) {
  const [rows, setRows] = useState<WorktreeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    invoke<{ worktrees: WorktreeRow[] }>("worktrees")
      .then((r) => setRows(r.worktrees ?? []))
      // **저장소가 아니면 목록이 없다** — 그건 오류가 아니라 사실이므로 빈 목록으로 둔다.
      .catch((e: unknown) => {
        setRows([]);
        setError(String(e));
      });
  }, []);

  useEffect(load, [load]);

  const summary = summarizeTrees(rows ?? []);

  const remove = (row: WorktreeRow): void => {
    // 버리기 전에 **무엇을 버리는지** 말한다. 확인은 사용자의 것이고 우리가 대신 고르지 않는다.
    if (!window.confirm(confirmRemoval(row))) return;
    setNote(null);
    invoke<{ removed: string }>("remove_worktree", { path: row.path, force: row.dirty })
      .then(() => {
        setNote(`${row.branch} 트리를 정리했습니다.`);
        load();
      })
      .catch((e: unknown) => setError(String(e)));
  };

  return (
    <div className="panel">
      <h3>격리 트리</h3>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">{summary.headline}</p>
      {isolatedPath && (
        <p className="muted small">
          지금 이 워크스페이스는 <strong>격리 트리에서</strong> 돌고 있습니다: <code>{isolatedPath}</code>
        </p>
      )}

      {summary.ours.map((row) => {
        const label = labelTree(row);
        return (
          <div key={row.path} className="pin-row">
            <span className="small">
              {label.text}
              {row.dirty && <span className="warn"> · 커밋되지 않은 변경 있음</span>}
            </span>
            <button type="button" disabled={!label.removable} title={label.reason} onClick={() => remove(row)}>
              정리
            </button>
          </div>
        );
      })}

      {/* 남의 트리는 **가르되 버리지 않는다.** */}
      {summary.theirs.length > 0 && (
        <>
          <p className="muted small">
            이 앱이 만들지 않은 worktree {summary.theirs.length}개 — 손대지 않습니다. 같은 브랜치로 격리할 수 없다면
            이쪽이 그 브랜치를 잡고 있을 수 있습니다.
          </p>
          {summary.theirs.map((row) => (
            <p key={row.path} className="muted small">
              {labelTree(row).text}
            </p>
          ))}
        </>
      )}

      {note && <p className="muted small">{note}</p>}
    </div>
  );
}
