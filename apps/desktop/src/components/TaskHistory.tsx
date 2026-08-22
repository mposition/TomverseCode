import type { TaskRow } from "../types";

/**
 * 최근 작업 목록 — M0.1에서 추가.
 *
 * 이 패널이 존재하는 이유는 "예쁜 히스토리"가 아니다. **앱이 죽어도 무슨 일이 있었는지
 * 남는다**는 것을 사용자가 확인할 수 있어야 하기 때문이다(state-machine-and-protocol.md 6절,
 * `task_events`가 append-only 진실의 원천). 특히 `INTERRUPTED` 작업은 여기서만 발견된다 —
 * 앱이 비정상 종료된 순간 그 작업의 UI 상태는 이미 사라졌기 때문이다.
 *
 * 자동 재개는 하지 않는다. 부분 실행된 도구를 멱등성 보장 없이 다시 돌리는 것이 위험하므로
 * "되돌리기 / 다시 실행"을 사용자에게 맡긴다.
 */
export function TaskHistory({
  tasks,
  selectedId,
  busy,
  onSelect,
  onRollback,
  onRestart,
  onRefresh,
  hasMore,
  countLabel,
  onLoadMore,
}: {
  tasks: TaskRow[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (taskId: string) => void;
  onRollback: (taskId: string) => void;
  onRestart: (taskId: string) => void;
  onRefresh: () => void;
  /** 더 읽을 페이지가 남았는지. 남지 않았으면 "더 보기"를 아예 그리지 않는다. */
  hasMore: boolean;
  /** 건수 표기 — 더 남았으면 "이상"이 붙는다. 전체 건수는 **세지 않으므로 모른다**. */
  countLabel: string;
  onLoadMore: () => void;
}) {
  const interrupted = tasks.filter((t) => t.terminalStatus === "INTERRUPTED");

  return (
    <section className="panel history">
      <h2>
        최근 작업 <span className="muted small">({countLabel})</span>
        <button className="secondary tiny" onClick={onRefresh} disabled={busy}>
          새로고침
        </button>
      </h2>

      {interrupted.length > 0 && (
        <p className="warn small">
          앱이 비정상 종료되어 중단된 작업이 {interrupted.length}건 있습니다. 파일이 변경된 상태로 남아 있을 수 있으니
          되돌리기 여부를 확인하세요.
        </p>
      )}

      {tasks.length === 0 ? (
        <p className="muted">저장된 작업이 없습니다.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => {
            const status = task.terminalStatus ?? task.currentPhase;
            return (
              <li
                key={task.taskId}
                className={`task-row task-${status.toLowerCase()}${task.taskId === selectedId ? " task-selected" : ""}`}
              >
                <button className="task-main" onClick={() => onSelect(task.taskId)} title={task.taskId}>
                  <span className={`task-status task-status-${status.toLowerCase()}`}>{statusLabel(status)}</span>
                  <span className="task-message">{truncate(task.userMessage, 90)}</span>
                  <span className="muted small">
                    {formatTime(task.createdAt)}
                    {task.mutationCount > 0 && ` · 변경 ${task.mutationCount}개`}
                    {task.mode && ` · ${task.mode}`}
                  </span>
                </button>
                {task.errorSummary && <p className="muted small task-error">{truncate(task.errorSummary, 160)}</p>}
                <div className="task-actions">
                  {/* 되돌리기는 변경된 파일이 있을 때만 의미가 있다. 완료된 작업도 되돌릴 수 있다. */}
                  {task.mutationCount > 0 && (
                    <button className="secondary tiny" onClick={() => onRollback(task.taskId)} disabled={busy}>
                      되돌리기
                    </button>
                  )}
                  <button className="secondary tiny" onClick={() => onRestart(task.taskId)} disabled={busy}>
                    다시 실행
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {/* "더 보기"는 남은 페이지가 있을 때만 그린다 — 눌러도 아무 일이 없는 버튼을 두면
          사용자는 목록이 고장 났다고 읽는다. 마지막 페이지에서는 대신 끝임을 적는다. */}
      {tasks.length > 0 &&
        (hasMore ? (
          <button className="secondary" onClick={onLoadMore} disabled={busy}>
            더 보기
          </button>
        ) : (
          <p className="muted small">모두 불러왔습니다.</p>
        ))}

      <p className="muted small">
        "다시 실행"은 <strong>같은 요청 문구로 처음부터</strong> 새 작업을 만듭니다. 중단된 지점부터 이어서 하지
        않습니다 — 부분 실행된 도구를 다시 실행하는 것은 안전하지 않기 때문입니다.
      </p>
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "COMPLETED":
      return "완료";
    case "FAILED":
      return "실패";
    case "CANCELLED":
      return "취소됨";
    case "REJECTED":
      return "거부됨";
    case "INTERRUPTED":
      return "중단됨";
    default:
      return "진행 중";
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
