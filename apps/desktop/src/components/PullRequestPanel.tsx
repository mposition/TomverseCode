import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { describePrOutcome, type PrOutcome, type PrResult } from "../lib/prOutcome";

/**
 * PR 연동 — 브랜치를 올리고 **PR 생성 폼 주소**를 낸다 (state-machine 28절).
 *
 * # 이 화면이 말하지 않아야 하는 것
 *
 * **"PR을 만들었습니다".** 우리는 만들지 않았다 — 폼을 여는 것은 사용자의 브라우저다(28.1절).
 * 그 문장의 규칙은 `prOutcome.ts`에 있고 테스트가 고정한다.
 *
 * # 왜 승인 모달이 뜨는가
 *
 * push는 언제나 승인을 요구한다(28.2절). 사용자가 이 버튼을 눌렀다는 것이 그 동작의 승인처럼
 * 보이지만, **무엇이 올라가는지는 매번 다르다** — 그래서 승인 화면이 실제 argv를 보여준다.
 * 되돌리기 버튼과 다른 점이 이것이고, 28.4절에 그 이유를 적어 두었다.
 */
export function PullRequestPanel({ taskId }: { taskId: string }) {
  const [outcome, setOutcome] = useState<PrOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState("main");

  return (
    <div className="panel">
      <h3>PR 올리기</h3>
      <p className="muted small">
        현재 브랜치를 remote로 올리고, 제목과 본문이 채워진 <strong>PR 생성 폼 주소</strong>를 만듭니다.
        {/* 무엇을 하지 않는지도 먼저 말한다 — 누르기 전에 알아야 하는 사실이다. */}
        <br />
        Tomverse는 GitHub에 요청을 보내지 않습니다. 폼은 브라우저에서 직접 열립니다.
      </p>

      <label className="small">
        base 브랜치{" "}
        <input value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} />
      </label>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setError(null);
          setOutcome(null);
          setBusy(true);
          invoke<PrResult>("open_pull_request", { taskId, base })
            .then((result) => setOutcome(describePrOutcome(result)))
            .catch((e: unknown) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "올리는 중… (승인 모달이 뜹니다)" : "브랜치 올리기"}
      </button>

      {error && <p className="error small">{error}</p>}

      {outcome && (
        <>
          <p className={outcome.kind === "failed" ? "error small" : "small"}>{outcome.headline}</p>
          <p className="muted small">{outcome.detail}</p>
          {outcome.url && (
            // 새 탭에서 연다. **주소를 그대로 보여준다** — 어디로 가는지 보이지 않는 링크를
            // 누르게 하지 않는다.
            <p className="small">
              <a href={outcome.url} target="_blank" rel="noreferrer">
                PR 생성 폼 열기
              </a>
              <br />
              <code className="muted">{outcome.url}</code>
            </p>
          )}
        </>
      )}
    </div>
  );
}
