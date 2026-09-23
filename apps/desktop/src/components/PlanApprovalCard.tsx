import type { PlanApprovalCardData, PlanApprovalChoice } from "../types";
import { costLines, subtaskLine } from "../lib/gateCards";

/**
 * 계획 승인 카드 — docs/design/state-machine-and-protocol.md 72.4절.
 *
 * # 이것은 "두 번째 승인 모달"이 아니다
 *
 * product-strategy 8.6절이 금지한 것은 **비용 전용 승인 자리를 하나 더 만드는 것**이다.
 * 여기서 하는 일은 반대다 — **이미 있는 유일한 계획 게이트**에 금액을 싣는다. 그리고 그
 * 절이 걱정한 "승인한 금액과 실제 예약이 갈리는 것"은 72.12절이 **예약을 이 승인에 묶어서**
 * 구조적으로 막는다.
 *
 * # 기본값이 없다
 *
 * 선택지가 넷이고 **미리 선택된 항목이 없다.** 근거는 `autoApproveVerification`과 같다 —
 * "우리가 권한다"가 사용자가 골랐다는 뜻이 아니다. 그래서 라디오나 기본 포커스를 두지 않고
 * 버튼 넷을 나란히 놓는다.
 *
 * # 타임아웃이 없다
 *
 * 무응답은 거부가 아니라 **대기**다(72.12절). 카드에 남은 시간을 그리지 않는 것이 그
 * 결정의 화면 쪽 표현이다 — 점심 먹으러 간 사이에 작업이 사라지지 않는다.
 */
export function PlanApprovalCard({
  card,
  onRespond,
}: {
  card: PlanApprovalCardData;
  onRespond: (choice: PlanApprovalChoice) => void;
}) {
  const cost = costLines(card);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="계획을 승인하시겠습니까">
      <div className="modal">
        <h2>계획을 승인하시겠습니까</h2>

        {/* 승인 대상 그 자체. */}
        <p className="plan-approval-summary">{card.summary}</p>
        {card.steps.length > 0 && (
          <ol className="plan-approval-steps">
            {card.steps.map((step, i) => (
              <li key={`${i}-${step}`}>{step}</li>
            ))}
          </ol>
        )}

        {/* **개수와 각 등급.** 개수만 보여주면 왜 그 금액인지 알 수 없다(72.10절). */}
        <h3>실행 단위 {card.subtasks.length}개</h3>
        <ul className="plan-approval-subtasks">
          {card.subtasks.map((s) => (
            <li key={s.subtaskId}>{subtaskLine(s)}</li>
          ))}
        </ul>

        {/* **금액은 하나가 아니라 셋이다** — 하나로 합치면 셋 중 어느 것도 정확히 말하지 못한다. */}
        <h3>비용</h3>
        <p className="small">{cost.metered}</p>
        {cost.unpriced && <p className="small warn">{cost.unpriced}</p>}
        <p className="small">{cost.envelope}</p>
        {card.estimateCaveats.length > 0 && (
          <>
            <p className="muted small">추정을 틀리게 만드는 것들:</p>
            <ul className="muted small plan-approval-caveats">
              {card.estimateCaveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}

        {/* 배정의 성질·드롭·대조와 B의 쟁점이 전부 여기로 온다. **따로 멈추지 않는다**(72.9절). */}
        {card.notes.length > 0 && (
          <ul className="small plan-approval-notes">
            {card.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        {/* 승인이 **어느 워크스페이스에 대한 것인가**(72.5절). 자리를 비운 사이에 코드가
            바뀌면 이 승인은 다른 워크스페이스에 대한 승인이 된다. */}
        {card.workspaceFingerprint && (
          <p className="muted small">
            이 승인은 지금 상태에 묶입니다: <code>{card.workspaceFingerprint}</code>
          </p>
        )}

        {/* **선택지 넷. 기본값 없음.** `granted: boolean`으로 뭉치면 "승인 + 검토 생략"과
            "승인 + 독립 검토"를 구별해 보낼 수 없다. */}
        <div className="modal-actions plan-approval-actions">
          <button type="button" onClick={() => onRespond("approve_with_review")}>
            승인 + 독립 검토
          </button>
          <button type="button" onClick={() => onRespond("approve_skip_review")}>
            승인 + 검토 생략
          </button>
          <button type="button" onClick={() => onRespond("revise")}>
            수정 요청
          </button>
          <button type="button" className="danger" onClick={() => onRespond("reject")}>
            거부
          </button>
        </div>
        <p className="muted small">
          검토를 생략하시면 **그 사실이 기록되고 마지막 확인 목록에 적힙니다.** 답하지 않으셔도
          작업은 사라지지 않고 이 자리에서 기다립니다.
        </p>
      </div>
    </div>
  );
}
