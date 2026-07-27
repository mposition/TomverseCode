import type { ApprovalRequest } from "../types";

/**
 * 승인 모달 — docs/design/ui-wireframes.md 3.3절.
 *
 * **가장 중요한 약속: `run_command`의 program/args/cwd를 실제 실행될 argv 그대로 보여준다.**
 * 도구 인터페이스가 셸 문자열을 받지 않으므로(CLAUDE.md 원칙 6) 여기 표시된 것과 실행되는 것이
 * 달라질 수 없다. 그래서 argv를 한 줄로 합쳐 보여주는 것에 더해 인자를 개별로도 나열한다 —
 * 공백이 포함된 인자가 여러 인자처럼 보이는 착시를 막기 위해서다.
 *
 * v1은 항목별 개별 승인을 지원하지 않는다(3.3절: ExecutionPlan 순서 의존성 문제).
 * "모두 승인" 또는 "거부"뿐이다.
 */
export function ApprovalModal({
  request,
  onRespond,
}: {
  request: ApprovalRequest;
  onRespond: (granted: boolean) => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="승인이 필요합니다">
      <div className="modal">
        <h2>승인이 필요합니다</h2>
        <ul className="approval-items">
          {request.items.map((item) => (
            <li key={item.requestId} className={`risk-${item.riskLevel}`}>
              <div className="approval-head">
                <strong>{item.tool}</strong>
                <span className={`badge badge-${item.riskLevel}`}>{riskLabel(item.riskLevel)}</span>
              </div>

              {item.command && (
                <div className="command">
                  <div className="command-line">
                    <code>{[item.command.program, ...item.command.args].join(" ")}</code>
                  </div>
                  <dl>
                    <dt>program</dt>
                    <dd>
                      <code>{item.command.program}</code>
                    </dd>
                    <dt>args</dt>
                    <dd>
                      {item.command.args.length === 0 ? (
                        <span className="muted">(없음)</span>
                      ) : (
                        <ol className="argv">
                          {item.command.args.map((arg, index) => (
                            <li key={`${index}-${arg}`}>
                              <code>{arg}</code>
                            </li>
                          ))}
                        </ol>
                      )}
                    </dd>
                    <dt>cwd</dt>
                    <dd>
                      <code>{item.command.cwd}</code>
                    </dd>
                  </dl>
                  <p className="muted small">
                    셸을 경유하지 않고 이 인자들이 그대로 전달됩니다 — 표시된 내용과 실행되는 내용이 같습니다.
                  </p>
                </div>
              )}

              {item.path && !item.command && (
                <p>
                  대상: <code>{item.path}</code>
                </p>
              )}

              <p className="muted small">{item.reason}</p>

              {item.preview && (
                <details>
                  <summary>변경 내용 미리보기 (아직 적용되지 않음)</summary>
                  <pre className="diff">{item.preview}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>

        <div className="modal-actions">
          <button className="secondary" onClick={() => onRespond(false)}>
            거부
          </button>
          <button onClick={() => onRespond(true)}>모두 승인</button>
        </div>
      </div>
    </div>
  );
}

function riskLabel(risk: ApprovalRequest["items"][number]["riskLevel"]): string {
  switch (risk) {
    case "none":
      return "위험 없음";
    case "low":
      return "낮음";
    case "medium":
      return "보통";
    case "high":
      return "높음";
    case "prohibited":
      return "금지";
  }
}
