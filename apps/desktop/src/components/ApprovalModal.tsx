import type { ApprovalRequest } from "../types";
import type { ApprovalQueueView } from "../lib/approvalQueue";

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
 *
 * # 밀려 있는 것을 숨기지 않는다 (process-architecture 11.6①)
 *
 * Fleet에서는 N개가 동시에 승인을 요구한다. 모달은 하나이므로 **도착한 순서대로 하나씩**
 * 답하는데, 그때 뒤에 몇 개가 서 있는지 말하지 않으면 사용자는 자기가 답한 뒤에 또 뜨는
 * 모달을 "왜 또?"로 읽는다. 그리고 큐가 서로 다른 트리를 담고 있으면 **트리 표시를 숨길 수
 * 없다** — 같은 명령이 두 저장소에 대해 떠 있을 수 있고, 그때 트리를 지우면 원칙 6의 약속이
 * 깨진다.
 *
 * 큐 조립은 화면 밖 순수 함수다(`lib/approvalQueue.ts`) — 순서와 표시 규칙이 화면 안에 있으면
 * 검증할 방법이 없다.
 */
export function ApprovalModal({
  request,
  queue,
  onRespond,
}: {
  request: ApprovalRequest;
  queue: ApprovalQueueView;
  onRespond: (granted: boolean) => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="승인이 필요합니다">
      <div className="modal">
        <h2>승인이 필요합니다</h2>

        {/* **어느 구성원의 요청인가.** 경로가 아니라 자리로 구별한다 — `tomverse-feat-a`와
            `tomverse-feat-b`는 화면에서 구별되지 않는다. 이 값은 Rust가 실어 보낸다. */}
        {request.origin && (
          <p className="small approval-origin">
            <strong>
              Fleet 구성원 {request.origin.memberIndex}/{request.origin.fleetSize} · {request.origin.branch}
            </strong>
          </p>
        )}

        {/* **어느 저장소인지 먼저 말한다.** 같은 argv라도 대상이 다르면 다른 동작이고,
            워크스페이스를 오간 뒤에는 화면의 다른 부분이 이미 새 워크스페이스를 가리킨다. */}
        <p className="muted small approval-workspace">
          대상 워크스페이스: <code>{request.workspaceRoot}</code>
        </p>

        {/* 문장은 `approvalQueue.ts`가 만든다 — 화면이 지어내면 검증할 수 없다. */}
        {queue.notices.map((notice) => (
          <p key={notice} className="small warn approval-queue-notice">
            {notice}
          </p>
        ))}
        {queue.waiting > 0 && (
          <ol className="small muted approval-queue">
            {queue.entries.map((entry) => (
              <li key={entry.approvalId} className={entry.active ? "approval-queue-active" : undefined}>
                {entry.position}. {entry.label}
                {entry.active ? " — 지금 답하는 것" : ""}
              </li>
            ))}
          </ol>
        )}
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
