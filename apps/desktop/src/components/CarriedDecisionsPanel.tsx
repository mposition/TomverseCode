import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unwrap, type Envelope } from "../lib/envelope";
import {
  describeWithdrawal,
  summarize,
  toViews,
  type DecisionRow,
} from "../lib/carriedDecisions";

/**
 * 이 세션에서 **사용자가 정한 것**과 그것을 거두는 자리 — state-machine 30절.
 *
 * # 왜 이 화면이 필요한가
 *
 * 27절이 세션 메모리를 만들면서 앞선 판정을 다음 태스크의 프롬프트에 싣기 시작했다. 그런데
 * 그때부터 **사용자는 자기가 무엇을 나르고 있는지 볼 수 없었다** — 전송 화면의 한 줄("N건이
 * 실립니다")이 전부였고, 마음이 바뀌어도 거둘 방법이 없었다.
 *
 * 이 화면은 그 둘을 준다: 무엇이 실리는지 보이고, 거둘 수 있다.
 *
 * # 우리는 충돌을 판정하지 않는다
 *
 * 앞선 판정과 이번 요청이 부딪히는지 모델에게 묻지 않는다. 그 대답은 또 하나의 모델 의견이고,
 * 그것으로 사용자 판정을 지우면 요구에 대한 권위가 뒤집힌다(product-strategy 16절).
 * 그래서 이 화면에는 **감지가 없다** — 목록을 보여주고, 거두는 것은 사람이 누른다.
 *
 * # 거둔 것도 남는다
 *
 * 목록에서까지 지우면 "사라졌다"와 "거뒀다"가 같은 모양이 되고, 사용자는 자기가 무엇을
 * 거뒀는지 확인할 수 없다. 그래서 거둔 것은 흐리게, 그러나 남는다.
 */
export function CarriedDecisionsPanel() {
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    invoke<Envelope<{ decisions: DecisionRow[] }>>("session_decisions")
      .then((envelope) => {
        const result = unwrap(envelope);
        // **실패를 "판정 없음"으로 읽지 않는다.** 읽지 못한 것과 없는 것은 다른 사실이다.
        if (result.ok) setRows(result.value.decisions);
        else setError(result.problem.text);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  const withdraw = (row: DecisionRow): void => {
    setNote(null);
    setError(null);
    invoke<{ withdrawn?: boolean; detail?: string }>("withdraw_decision", {
      taskId: row.taskId,
      criterionId: row.criterionId,
    })
      .then((result) => {
        setNote(describeWithdrawal(result));
        // 목록을 다시 읽는다 — 화면이 스스로 상태를 지어내면 호스트가 거절했을 때 갈라진다.
        load();
      })
      .catch((e: unknown) => setError(String(e)));
  };

  const views = toViews(rows ?? []);
  const summary = summarize(rows ?? []);

  return (
    <div className="panel">
      <h3>이 세션에서 정한 것</h3>
      {error && <p className="error small">{error}</p>}
      {rows === null && !error && <p className="muted small">읽는 중…</p>}

      {rows !== null && <p className="muted small">{summary.headline}</p>}

      {views.length > 0 && (
        <ul className="transmission-files">
          {views.map((view) => (
            <li key={`${view.taskId}/${view.criterionId}`} className={view.status === "withdrawn" ? "muted small" : "small"}>
              <span>{view.text}</span>{" "}
              {view.status === "withdrawn" ? (
                <em>· 거둠</em>
              ) : (
                <button type="button" onClick={() => withdraw(view)} disabled={!view.withdrawable}>
                  거두기
                </button>
              )}
              {/* 거둘 수 없는 이유를 "안 됨"으로 뭉개지 않는다 — 이유마다 할 일이 다르다. */}
              {view.blockedReason && view.status !== "withdrawn" && (
                <span className="muted small"> · {view.blockedReason}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {note && <p className="muted small">{note}</p>}

      <p className="muted small">
        거두면 <strong>다음 태스크부터 프롬프트에 실리지 않습니다.</strong> 이미 나간 프롬프트는 되돌릴 수
        없고, 그 판정을 만든 태스크의 기록도 그대로 남습니다 — 삭제가 아닙니다.
      </p>
    </div>
  );
}
