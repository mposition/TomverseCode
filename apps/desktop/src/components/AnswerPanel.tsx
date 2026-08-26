import { answerView, type AnswerLike } from "../lib/answerView";

/**
 * 질문에 대한 답 — state-machine 51절, ui-wireframes 3.26절.
 *
 * # 완료처럼 그리지 않는다
 *
 * 51절이 `COMPLETED`와 `ANSWERED`를 나눈 이유는 상태 머신 안쪽에만 있는 사실이 아니다.
 * 사용자가 "검증을 통과한 변경"과 "아무것도 바꾸지 않은 답변"을 구별해야 하기 때문이고,
 * 화면이 둘을 같은 초록 체크로 그리면 그 구별이 여기서 사라진다.
 *
 * # 판정은 여기서 하지 않는다
 *
 * 무엇을 어떤 문장으로 말할지는 `lib/answerView.ts`에 있다. 계산이 화면 안에 있으면 DOM 없이
 * 검증할 수 없다.
 */
export function AnswerPanel({ answer }: { answer: AnswerLike | null | undefined }) {
  const view = answerView(answer);
  if (!view.show) return null;

  return (
    <div className="panel result result-answered">
      <h2>답변</h2>
      {/* 답 본문. **요약이 아니라 답이다** — 둘을 같은 자리에 두면 긴 답이 목록 한 줄을 망친다. */}
      <p className="answer-body">{view.answer}</p>

      {/* **변경용 배지 대신 이 문장이 붙는다.** `resultBasis`는 "이 변경을 무엇이 뒷받침하는가"에
          답하는데 답변에는 변경이 없고, 그 배지를 붙이면 "뒷받침하는 것이 없다"가 사고처럼 읽힌다. */}
      <p className="basis basis-user_only">
        <span className="badge badge-basis-weak">검증되지 않음</span>{" "}
        <span className="muted small">{view.caveat}</span>
      </p>

      <p className={view.warn ? "warn small" : "muted small"}>{view.missingNote}</p>
      {view.missingContext.length > 0 && (
        <ul className="transmission-files">
          {view.missingContext.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}

      <p className="muted small">{view.citedNote}</p>
      {view.citedFiles.length > 0 && (
        <ul className="transmission-files">
          {view.citedFiles.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
