import type { TaskPhase, UserStage } from "../types";

/**
 * 단계 표시기 — docs/design/ui-wireframes.md 2절.
 *
 * 내부 `TaskPhase`(16개)를 그대로 노출하지 않고 사용자에게 보이는 단계로 압축한다.
 * 실제 phase 값은 개발자 모드에서만 작은 텍스트로 보여준다(디버깅/신뢰 구축용).
 */
export function StageBar({
  current,
  stages,
  phase,
  devMode,
}: {
  current: UserStage;
  stages: UserStage[];
  phase: TaskPhase;
  devMode: boolean;
}) {
  const currentIndex = stages.indexOf(current);
  return (
    <section className="stagebar">
      <ol>
        {stages.map((stage, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "active" : "todo";
          return (
            <li key={stage} className={`stage stage-${state}`}>
              <span className="stage-mark">{state === "done" ? "✓" : index + 1}</span>
              <span>{stage}</span>
            </li>
          );
        })}
      </ol>
      {current === "확인 필요" && <p className="warn small">사용자 입력을 기다리고 있습니다.</p>}
      {devMode && (
        <p className="muted small">
          내부 phase: <code>{phase}</code>
        </p>
      )}
    </section>
  );
}
