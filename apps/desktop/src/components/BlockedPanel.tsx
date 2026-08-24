import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unwrap, type Envelope } from "../lib/envelope";
import { adviseOnBlocked, type BlockedReport } from "../lib/blockedAdvice";

/**
 * 무인 정지의 처방 — **무엇이 막았고 무엇을 켜면 지나가는가** (state-machine 24.8절).
 *
 * # 왜 버튼을 눌러야 나오는가
 *
 * `AuditExportPanel`과 같은 이유다: 이 질문은 결과를 확인하는 흐름과 다른 시점에 나온다.
 * 대부분의 태스크에는 무인 정지가 없고, 그때 이 영역은 아무것도 그리지 않는다 —
 * "정지 0건"을 늘 띄우면 진짜 정지가 그 안에 묻힌다.
 *
 * # 판정은 여기서 하지 않는다
 *
 * `humanOnly` 정지를 "스위치를 켜세요"로 뭉개지 않는 규칙은 `blockedAdvice.ts`에 있다.
 * 계산이 화면 안에 있으면 DOM 없이 검증할 수 없다.
 */
export function BlockedPanel({ taskId }: { taskId: string }) {
  const [report, setReport] = useState<BlockedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const advice = adviseOnBlocked(report);

  return (
    <div className="panel">
      <h3>무인 실행이 멈춘 자리</h3>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setAsked(true);
          invoke<Envelope<BlockedReport>>("task_blocked", { taskId })
            .then((envelope) => {
              const result = unwrap(envelope);
              // **실패를 "정지 없음"으로 읽지 않는다.** 읽지 못한 것과 없는 것은 다른 사실이고,
              // 뭉개면 빈 화면이 거짓 안심을 준다.
              if (result.ok) setReport(result.value);
              else setError(result.problem.text);
            })
            .catch((e: unknown) => setError(String(e)));
        }}
      >
        확인
      </button>

      {error && <p className="error small">{error}</p>}

      {/* **"정지 없음"과 "아직 묻지 않음"을 구별한다.** 뭉개면 빈 화면이 거짓 안심을 준다. */}
      {asked && !error && !advice.show && (
        <p className="muted small">이 작업에는 무인 정지가 없습니다.</p>
      )}

      {advice.show && (
        <>
          <p className={advice.needsHuman ? "error small" : "muted small"}>{advice.headline}</p>

          {advice.flags.length > 0 && (
            <>
              <h4>다시 돌릴 때 켤 것</h4>
              <ul className="transmission-files">
                {advice.flags.map((flag) => (
                  <li key={flag}>
                    <code>{flag}</code>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>막힌 지점</h4>
          <ul className="transmission-files">
            {report?.stops.map((stop) => (
              <li key={stop.requestId}>
                <code>{stop.tool}</code> — {stop.normalizedTarget}
                <div className="muted small">
                  {stop.matchedRule}
                  {/* `null`은 "켤 것이 없다"는 **사실**이다 — 빈칸으로 두면 안 적은 것과 같아진다. */}
                  {stop.rerunFlag ? ` · ${stop.rerunFlag}로 열림` : " · 정책으로 열 수 없음"}
                </div>
              </li>
            ))}
          </ul>

          {/* 보고서가 스스로 밝힌 한계. **지우지 않는다** — 지우면 사용자는 한 번이면 된다고 믿는다. */}
          <p className="muted small">{advice.caveat}</p>
        </>
      )}
    </div>
  );
}
