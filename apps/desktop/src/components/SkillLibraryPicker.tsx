import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  labelEntry,
  summarizeLibrary,
  summarizeProposed,
  type SkillLibraryView,
} from "../lib/skillLibrary";

/**
 * 스킬 보관함에서 고른다 — state-machine 36절.
 *
 * # 왜 목록이 필요한가
 *
 * 26.6절이 "UI 선택 화면"을 미해결로 남겼는데, 그 앞에 있던 질문은 **"스킬이 어디 사는가"**
 * 였다. 34절이 절반("워크스페이스 안은 아니다")을, 36절이 나머지 절반(상태 디렉터리의
 * 보관함)을 정했다. 자리가 정해지자 목록을 만들 수 있다.
 *
 * # 경로를 화면이 조립하지 않는다
 *
 * 고른 파일 이름을 Rust에 주고 절대 경로를 받아 온다. 화면이 조립하면 보관함의 자리가
 * 화면에도 적히고, 옮길 때 한쪽만 고쳐진다.
 *
 * # 직접 경로 입력을 없애지 않는다
 *
 * 보관함 밖의 스킬을 쓰는 길이 사라지면, 보관함에 넣을 수 없는 상황(읽기 전용 설치 등)에서
 * 기능 자체를 못 쓴다. 목록은 **더 쉬운 길**이지 유일한 길이 아니다.
 */
export function SkillLibraryPicker({
  value,
  onPick,
  disabled,
}: {
  /** 지금 고른 스킬 파일의 절대 경로 (없으면 빈 문자열). */
  value: string;
  onPick: (path: string) => void;
  disabled: boolean;
}) {
  const [view, setView] = useState<SkillLibraryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    invoke<SkillLibraryView>("skill_library")
      .then(setView)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  const summary = summarizeLibrary(view);
  const proposal = summarizeProposed(view);

  const pick = (file: string): void => {
    setNote(null);
    // 경로는 **Rust가 만든다** — 화면이 조립하면 보관함의 자리가 두 곳에 적힌다.
    invoke<{ path: string }>("skill_path", { file })
      .then((r) => onPick(r.path))
      .catch((e: unknown) => setError(String(e)));
  };

  return (
    <div className="panel">
      <h3>스킬 보관함</h3>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">{summary.headline}</p>

      {(view?.library ?? []).map((entry) => {
        const label = labelEntry(entry);
        return (
          <div key={entry.file} className="pin-row">
            <span className={label.usable ? "small" : "error small"}>{label.text}</span>
            {/* 읽지 못한 항목은 고를 수 없다 — 고르게 두면 태스크 시작에서 거절된다. */}
            <button type="button" disabled={disabled || !label.usable} onClick={() => pick(entry.file)}>
              고르기
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                invoke<{ removed: string }>("remove_skill", { file: entry.file })
                  .then(() => {
                    setNote(`${entry.file}을 보관함에서 지웠습니다.`);
                    load();
                  })
                  .catch((e: unknown) => setError(String(e)));
              }}
            >
              지우기
            </button>
          </div>
        );
      })}

      {/* 저장소의 제안 (35절과 같은 모양). **보관함과 섞지 않는다** — 하나는 이미 승인된
          것이고 다른 하나는 아직 아무것도 아니다. */}
      {proposal.show && (
        <>
          <h4>저장소의 제안</h4>
          <p className="muted small">{proposal.headline}</p>
          <p className="muted small">
            이 파일들은 <strong>워크스페이스 안</strong>에 있습니다 — 모델이 고칠 수 있습니다. 가져오면 그 시점의
            <strong> 사본</strong>이 보관함에 들어가고, 이후 저장소가 바뀌어도 사본은 그대로입니다.
          </p>
          {proposal.importable.map((entry) => (
            <div key={entry.file} className="pin-row">
              <span className="small">{labelEntry(entry).text}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  invoke<{ name: string }>("import_skill", { file: entry.file })
                    .then((r) => {
                      // **"적용했습니다"가 아니다.** 보관함에 들어갔을 뿐이고, 쓰려면 골라야 한다.
                      setNote(`${r.name}을 보관함에 가져왔습니다. 쓰려면 위에서 고르세요.`);
                      load();
                    })
                    .catch((e: unknown) => setError(String(e)));
                }}
              >
                가져오기
              </button>
            </div>
          ))}
        </>
      )}

      {note && <p className="muted small">{note}</p>}
      {value !== "" && <p className="muted small">고른 스킬: {value}</p>}
    </div>
  );
}
