import type { AcceptanceCriterion, CriterionCheckStatus, CriterionEvaluation } from "../types";

/**
 * 최종 보고의 기준 체크리스트 — docs/design/ui-wireframes.md 3.10절.
 *
 * 검증 결과 패널(3.7절) **위에** 온다. build/test/lint 결과만 보고하면 사용자가 무엇을
 * 결정했는지가 최종 화면에서 사라지기 때문이다(state-machine-and-protocol.md 17.3절).
 *
 * # `✓`가 뜨는 조건은 좁다
 *
 * 기준 문장이 **실재하는 테스트 파일을 지목**했고, 그 파일이 검증 출력에 실제로 나타났고,
 * Rust가 만든 `test` 체크가 통과한 경우에만 `✓`다. 그 밖에는 전부 `?`(미확인)이며 대부분이
 * 여기 해당한다 — 기준과 테스트를 자동으로 잇는 일반적인 방법이 아직 없기 때문이다.
 *
 * **`?`를 `✓`로 만드는 유일한 방법은 모델에게 판정을 맡기는 것이고, 그 순간
 * product-strategy.md 9절의 순환 의존이 그대로 재현된다.** 그래서 이 화면은 물음표로
 * 덮이는 쪽을 택했다. "확인하지 못했다"와 "충족했다"는 다른 사실이다.
 */
export function AcceptanceCriteriaPanel({
  criteria,
  evaluations = [],
  unresolvedDisagreements,
}: {
  criteria: AcceptanceCriterion[];
  evaluations?: CriterionEvaluation[];
  unresolvedDisagreements?: string[];
}) {
  if (criteria.length === 0) return null;

  const byId = new Map(evaluations.map((e) => [e.criterionId, e]));
  const userDecided = criteria.filter((c) => c.source === "user_decision").length;
  const count = (status: CriterionCheckStatus) => evaluations.filter((e) => e.status === status).length;
  const verified = count("VERIFIED_BY_TEST");
  const contradicted = count("CONTRADICTED_BY_TEST");
  const conflicting = count("CONFLICTS_WITH_CHANGE");

  return (
    <div className="panel">
      <h2>확정된 기준 ({criteria.length})</h2>
      <p className="muted small">
        {userDecided > 0
          ? `사용자 판정 ${userDecided}개 · 모델 제안 ${criteria.length - userDecided}개`
          : "전부 모델이 제안한 기준입니다 — 사용자가 확정한 것은 없습니다"}
      </p>

      <ul className="criteria">
        {criteria.map((c) => {
          const evaluation = byId.get(c.criterionId);
          const status = evaluation?.status ?? "UNVERIFIED";
          return (
            <li key={c.criterionId} className={`criterion criterion-${c.source} criterion-${status}`}>
              <span className="check-mark" title={statusLabel(status)}>
                {statusMark(status)}
              </span>
              <span className="criterion-text">{c.text}</span>
              <span className="badge badge-source">{sourceLabel(c.source)}</span>
              {/* 판정 근거를 항상 보여준다. 근거 없는 표식은 사용자가 검증할 수 없는 주장이다. */}
              <span className="muted small">
                {evaluation?.reason ?? "아직 검증이 실행되지 않아 판정하지 못했습니다."}
              </span>
            </li>
          );
        })}
      </ul>

      {evaluations.length === 0 ? (
        <p className="warn small">
          검증이 실행되기 전에 종료되어 기준 판정이 없습니다 — 충족했다는 뜻이 아닙니다.
        </p>
      ) : (
        <p className={verified === 0 ? "warn small" : "muted small"}>
          기준 {criteria.length}개 중 테스트로 확인된 것 <strong>{verified}개</strong>
          {contradicted > 0 && <> · 테스트가 반증한 것 {contradicted}개</>}
          {conflicting > 0 && <> · 변경과 충돌 {conflicting}개</>} · 미확인{" "}
          {count("UNVERIFIED")}개.
          {verified === 0 && " 확인된 기준이 없다는 것은 충족하지 못했다는 뜻이 아니라, 자동으로 이을 근거를 찾지 못했다는 뜻입니다."}
        </p>
      )}

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

/** 4가지 상태를 각각 다르게 표시한다 — 3.7절이 `NOT_CONFIGURED`를 `✓`로 그리지 않는 것과 같다. */
function statusMark(status: CriterionCheckStatus): string {
  switch (status) {
    case "VERIFIED_BY_TEST":
      return "✓";
    case "CONTRADICTED_BY_TEST":
      return "✗";
    case "CONFLICTS_WITH_CHANGE":
      return "⚠";
    case "UNVERIFIED":
      return "?";
  }
}

function statusLabel(status: CriterionCheckStatus): string {
  switch (status) {
    case "VERIFIED_BY_TEST":
      return "지목한 테스트가 실행됐고 검증이 통과함";
    case "CONTRADICTED_BY_TEST":
      return "지목한 테스트를 포함한 검증이 실패함";
    case "CONFLICTS_WITH_CHANGE":
      return "이 기준이 지목한 파일을 변경이 건드리지 않음";
    case "UNVERIFIED":
      return "미확인";
  }
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
