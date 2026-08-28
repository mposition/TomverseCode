import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { summarizePreview, type AutopilotPreview, type StopKind } from "../lib/autopilotPreview";

/**
 * 무인 실행이 **무엇을 허용하는지 돌리기 전에** 보여준다 — state-machine 47·48절.
 *
 * # 왜 버튼이 아니라 자동으로 뜨는가
 *
 * `BlockedPanel`은 버튼을 누르면 나온다(대부분의 태스크에 정지가 없으므로 늘 띄우면 잡음이다).
 * 이쪽은 반대다: **무인 실행을 켜는 순간 이미 질문이 생겼고**, 그 답을 보려고 버튼을 한 번
 * 더 눌러야 하면 사람들은 누르지 않은 채 실행한다. 그리고 답은 스위치를 바꿀 때마다 달라진다.
 *
 * 종전에는 이 자리에 **손으로 적은 문장 하나**가 있었다("이 상태의 무인 실행은 검증에서
 * 멈춥니다"). 맞는 문장이었지만 여섯 개 정지 중 하나만 말한 것이고, 하나만 말하는 문장은
 * 나머지가 없다는 뜻으로 읽힌다.
 *
 * # 판정은 여기서 하지 않는다
 *
 * 어떤 정지에 무슨 문장을 붙일지는 `lib/autopilotPreview.ts`에 있다. 계산이 화면 안에 있으면
 * DOM 없이 검증할 수 없다.
 */
export function AutopilotPreviewPanel(props: {
  unattended: boolean;
  mode: string;
  allowGitCommit: boolean;
  autoApproveVerification: boolean;
  autoApproveWrites: boolean;
  skillPath: string | null;
  deadlineSecs: number | null;
  /**
   * 어떤 종류의 태스크에 대한 미리보기인가 (51·53·63절).
   *
   * **무인 스위치는 종류 게이트 밖에 있다** — 질문·계획 태스크에서도 켤 수 있다. 그때 종류를
   * 보내지 않으면 Rust가 `change`로 보고, 화면은 **실제로는 좁혀질 쓰기 도구를 "그냥
   * 지나갑니다"로** 보고하게 된다. 이 패널이 경계하는 "도구가 거짓말했다"가 그 모양이다.
   *
   * **`start_task`에 보내는 것과 같은 값이어야 한다** — 종류가 빠져 있던 동안 질문 태스크를
   * 쓰는 사용자가 받는 예고는 변경 태스크의 답이었다.
   */
  kind: string;
  /** 워크스페이스가 열려 있는가. 닫혀 있으면 물을 곳이 없다. */
  ready: boolean;
}) {
  const [preview, setPreview] = useState<AutopilotPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { unattended, mode, allowGitCommit, autoApproveVerification, autoApproveWrites, skillPath, deadlineSecs, kind, ready } =
    props;

  useEffect(() => {
    if (!unattended || !ready) {
      // **끄면 지운다.** 남겨두면 예전 스위치에 대한 답이 화면에 남는다.
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    invoke<AutopilotPreview>("autopilot_preview", {
      mode,
      allowGitCommit,
      unattended,
      autoApproveVerification,
      autoApproveWrites,
      skillPath,
      deadlineSecs,
      kind,
    })
      .then((value) => {
        if (cancelled) return;
        setPreview(value);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // **실패를 "멈추는 곳 없음"으로 읽지 않는다.** 읽지 못한 것과 없는 것은 다른 사실이고,
        // 뭉개면 빈 화면이 거짓 안심을 준다.
        setPreview(null);
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [unattended, mode, allowGitCommit, autoApproveVerification, autoApproveWrites, skillPath, deadlineSecs, kind, ready]);

  const summary = summarizePreview(preview);

  if (error) {
    return <p className="error small">무인 실행 미리보기를 읽지 못했습니다: {error}</p>;
  }
  if (!summary.show) return null;

  return (
    <div className="panel">
      <h4>이 설정으로 무인 실행하면</h4>
      <p className={summary.stops.some((s) => s.kind === "human_only") ? "error small" : "muted small"}>
        {summary.headline}
      </p>

      {summary.stops.length > 0 && (
        <ul className="transmission-files">
          {summary.stops.map((line) => (
            <li key={`${line.probe}-${line.matchedRule}`}>
              <span className={severity(line.kind)}>{line.probe}</span>
              <div className="muted small">
                {line.detail}
                {/* 규칙 이름은 `blocked`가 나중에 남길 것과 같은 값이다 — 두 화면이 같은 말을
                    해야 사용자가 이어 읽는다. */}
                <br />
                <code>{line.matchedRule}</code>
              </div>
            </li>
          ))}
        </ul>
      )}

      {summary.proceeds.length > 0 && (
        <p className="muted small">사람 없이 진행: {summary.proceeds.join(", ")}</p>
      )}
      {summary.denied.length > 0 && (
        <p className="muted small">게이트가 거부(스위치와 무관): {summary.denied.join(", ")}</p>
      )}

      {/* 미리보기가 스스로 밝힌 한계. **지우지 않는다** — 지우면 이 목록이 "전부"로 읽힌다. */}
      <p className="muted small">{summary.caveat}</p>
    </div>
  );
}

function severity(kind: StopKind): string {
  return kind === "human_only" || kind === "lever_does_not_free" ? "error" : "";
}
