import { planView, type PlanLike } from "../lib/planView";

/**
 * 계획 — state-machine 53절, ui-wireframes 3.27절.
 *
 * 판정은 여기서 하지 않는다. 무엇을 어떤 문장으로 말할지는 `lib/planView.ts`에 있다 —
 * 계산이 화면 안에 있으면 DOM 없이 검증할 수 없다.
 */
export function PlanPanel({ plan }: { plan: PlanLike | null | undefined }) {
  const view = planView(plan);
  if (!view.show) return null;

  return (
    <div className="panel result result-planned">
      <h2>계획</h2>
      <p className="answer-body">{view.summary}</p>

      <p className="basis basis-user_only">
        <span className="badge badge-basis-weak">검증되지 않음</span>{" "}
        <span className="muted small">{view.caveat}</span>
      </p>

      <h3>단계</h3>
      <ol className="plan-steps">
        {view.steps.map((step) => (
          <li key={step.n}>
            {step.intent}
            {step.files.length > 0 && (
              <ul className="transmission-files">
                {step.files.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      <p className={view.warn ? "warn small" : "muted small"}>{view.riskNote}</p>
      {view.risks.length > 0 && (
        <ul className="transmission-files">
          {view.risks.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>
      )}

      {view.openQuestions.length > 0 && (
        <>
          <h3>사용자가 정해야 하는 것</h3>
          <ul className="transmission-files">
            {view.openQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      )}

      <p className="muted small">{view.filesNote}</p>
      {view.filesToChange.length > 0 && (
        <ul className="transmission-files">
          {view.filesToChange.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}

      {/* **다음 걸음.** 계획은 종착이지만 이야기의 끝이 아니다 — 그 사실이 화면에 없으면
          53절이 답변과 계획을 나눈 이유가 화면에서 사라진다. */}
      <p className="muted small">{view.nextStep}</p>
    </div>
  );
}
