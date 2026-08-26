import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unwrap, type Envelope } from "../lib/envelope";
import { adviseOnBlocked, type BlockedReport } from "../lib/blockedAdvice";
import { joinPreviewAndBlocked } from "../lib/previewVsBlocked";
import type { AutopilotPreview } from "../lib/autopilotPreview";

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
  const [preview, setPreview] = useState<AutopilotPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const advice = adviseOnBlocked(report);
  // **예고와 실제를 잇는다**(59절). 둘 다 있어야 이으므로, 미리보기를 못 받으면 이 영역은
  // 그리지 않고 아래 처방만 남는다 — 반쪽을 그리면 이어 본 척이 된다.
  const joined = joinPreviewAndBlocked(preview, report);

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
          // **그 태스크가 돈 정책의 미리보기**를 함께 받는다(59절). 화면의 지금 스위치가
          // 아니다 — 실행 뒤에 스위치를 바꿨다면 그건 다른 질문에 대한 답이다.
          //
          // 실패해도 처방은 그대로 나온다: 이어 보기는 덤이고, 없으면 없는 대로 둔다.
          invoke<AutopilotPreview | null>("task_autopilot_preview", { taskId })
            .then((value) => setPreview(value))
            .catch(() => setPreview(null));
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

          {/* **예고와 실제를 잇는다**(59절). 두 패널이 같은 규칙 이름을 쓰는데 화면에는
              따로 있어서 사용자가 눈으로 이어 읽어야 했다. 여기가 그 자리다. */}
          {joined.show && joined.stops.length > 0 && (
            <>
              <h4>미리보기가 뭐라고 했나</h4>
              <p className={joined.stops.some((s) => s.kind === "contradicted") ? "error small" : "muted small"}>
                {joined.headline}
              </p>
              <ul className="transmission-files">
                {joined.stops.map((stop) => (
                  <li key={`joined-${stop.requestId}`} className={stop.kind === "contradicted" ? "error" : undefined}>
                    <code>{stop.matchedRule}</code> — {stop.detail}
                  </li>
                ))}
              </ul>
              {joined.notReached.length > 0 && (
                <>
                  {/* **"예고가 틀렸다"가 아니다** — 대개 실행이 거기까지 가지 않았다. */}
                  <p className="muted small">
                    미리보기가 예고했지만 이번 실행이 닿지 않은 자리 {joined.notReached.length}곳 — 다음 실행에서
                    만날 수 있습니다.
                  </p>
                  <ul className="transmission-files">
                    {joined.notReached.map((n) => (
                      <li key={`not-reached-${n.matchedRule}`}>
                        <code>{n.matchedRule}</code> ({n.probe})
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {/* **두 한계를 다 싣는다.** 하나만 실으면 이어 본 화면이 두 보고서보다 더 많이
                  아는 것처럼 보인다 — 잇는 행위가 만들어내는 고유한 거짓말이다. */}
              {joined.caveats.map((c) => (
                <p key={c} className="muted small">
                  {c}
                </p>
              ))}
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
