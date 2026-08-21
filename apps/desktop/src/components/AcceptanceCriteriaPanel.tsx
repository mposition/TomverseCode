import type { AcceptanceCriterion } from "../types";

/**
 * 최종 보고의 기준 체크리스트 — docs/design/ui-wireframes.md 3.10절.
 *
 * 검증 결과 패널(3.7절) **위에** 온다. build/test/lint 결과만 보고하면 사용자가 무엇을
 * 결정했는지가 최종 화면에서 사라지기 때문이다(state-machine-and-protocol.md 17.3절).
 *
 * # 왜 전부 `?`(미확인)인가
 *
 * 기준 하나를 어떤 테스트가 확인했는지 **자동으로 이을 방법이 아직 없다.** 그 자리에 모델을
 * 세워 "이 기준이 충족됐나"를 판정시키면 product-strategy.md 9절의 순환 의존이 그대로 재현된다 —
 * 검증되지 않은 판정으로 검증을 대신하는 것이다. 그래서 이 화면은 전부 미확인으로 표시하고
 * 그 사실을 숨기지 않는다. **"확인하지 못했다"와 "충족했다"는 다른 사실이다.**
 */
export function AcceptanceCriteriaPanel({
  criteria,
  unresolvedDisagreements,
}: {
  criteria: AcceptanceCriterion[];
  unresolvedDisagreements?: string[];
}) {
  if (criteria.length === 0) return null;

  const userDecided = criteria.filter((c) => c.source === "user_decision").length;

  return (
    <div className="panel">
      <h2>확정된 기준 ({criteria.length})</h2>
      <p className="muted small">
        {userDecided > 0
          ? `사용자 판정 ${userDecided}개 · 모델 제안 ${criteria.length - userDecided}개`
          : "전부 모델이 제안한 기준입니다 — 사용자가 확정한 것은 없습니다"}
      </p>

      <ul className="criteria">
        {criteria.map((c) => (
          <li key={c.criterionId} className={`criterion criterion-${c.source}`}>
            {/* 미확인은 미확인 표식으로만 쓴다. ✓는 결정론적 검증이 통과한 것에만 붙는다. */}
            <span className="check-mark" title="미확인">
              ?
            </span>
            <span className="criterion-text">{c.text}</span>
            <span className="badge badge-source">{sourceLabel(c.source)}</span>
            <span className="muted small">대응하는 테스트를 찾지 못함 (미확인)</span>
          </li>
        ))}
      </ul>

      <p className="warn small">
        기준 {criteria.length}개 중 테스트로 확인된 것은 <strong>0개</strong>입니다. 기준과 테스트를 자동으로
        잇는 방법이 아직 없어 전부 미확인으로 표시합니다 — 충족했다는 뜻이 아니라, 확인하지 못했다는 뜻입니다.
      </p>

      {(unresolvedDisagreements?.length ?? 0) > 0 && (
        <div className="unresolved">
          {/* 질문 예산이 모자랐다는 사실을 숨기지 않는다 — 17.4절. */}
          <p className="error small">사용자에게 묻지 못한 채 남은 쟁점 {unresolvedDisagreements!.length}건</p>
          <ul>
            {unresolvedDisagreements!.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function sourceLabel(source: AcceptanceCriterion["source"]): string {
  switch (source) {
    case "user_decision":
      return "사용자 판정";
    case "draft_proposal":
      return "모델 제안";
    case "user_message":
      return "최초 요청";
  }
}
