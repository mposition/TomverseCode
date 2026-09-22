import type { VerificationChecklistCardData, VerificationChoice } from "../types";
import { checklistGradeLabel, checklistSummary, sourceLabel } from "../lib/gateCards";

/**
 * 검증 체크리스트 — docs/design/state-machine-and-protocol.md 72.8절.
 *
 * # 새 판정이 아니라 **이미 계산되던 여집합의 화면**이다
 *
 * 17.9절이 이미 "확인됨 / 미확인"을 가르고 있었다. 이 화면이 하는 일은 그 미확인 집합을
 * 사람에게 넘기는 것이며, **화면이 판정을 만들지 않는다.**
 *
 * # `flagged_by_review`를 초록으로 그리지 않는다
 *
 * 그 등급은 **확인이 아니라 경고**다. 그리고 C가 "괜찮아 보입니다"라고 한 항목은
 * `verified`가 아니라 `unverified`로 남는다 — 17.9절이 정한 확인의 정의는 **검증 출력에
 * 나타났는가**이고 모델 의견은 거기 해당하지 않는다.
 *
 * **이 자리가 가장 조용히 썩을 수 있는 곳이다**: 뚫리면 "측정하지 않은 것을 검증됐다고
 * 말하지 않는다"가 제품 안에서 깨지는데, 증상이 "화면이 더 안심시켜 준다"라 아무도
 * 신고하지 않는다.
 *
 * # 계획에 없던 파일은 **판정하지 않고 보여준다**
 *
 * `filesToChange`는 그 타입 주석이 이미 "확정이 아니다"라고 경고한 값이다(72.7절).
 * 그러므로 목록 밖의 변경은 위반이 아니라 확인 항목이다.
 */
export function VerificationChecklist({
  card,
  onRespond,
}: {
  card: VerificationChecklistCardData;
  onRespond: (choice: VerificationChoice) => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="결과를 확인해 주세요">
      <div className="modal">
        <h2>결과를 확인해 주세요</h2>

        {/* **미확인을 먼저 말한다** — 이 경로에서 미확인은 정상 상태이고, 사용자가 읽어야
            하는 것이 그쪽이다. 문장은 화면 밖(lib/gateCards.ts)에서 만든다. */}
        <p className="verification-summary">{checklistSummary(card)}</p>

        <ul className="verification-items">
          {card.items.map((item, i) => (
            <li key={`${i}-${item.text}`} className={`verification-item grade-${item.grade}`}>
              <span className="verification-grade">{checklistGradeLabel(item.grade)}</span>
              <span className="verification-text">{item.text}</span>
              {/* 출처마다 권위가 다르다 — 섞이면 사용자가 **자기가 정한 것**과 모델이
                  추측한 것을 구별하지 못한다(72.8절). */}
              <span className="muted small verification-source">{sourceLabel(item.source)}</span>
            </li>
          ))}
        </ul>

        {card.unplannedPaths.length > 0 && (
          <>
            <h3>계획에 없던 파일 {card.unplannedPaths.length}개</h3>
            <ul className="verification-unplanned">
              {card.unplannedPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* C가 없었다는 사실, 검토를 생략했다는 사실 — **짧아진 목록을 그냥 보여주면
            사용자는 확인할 것이 적다고 읽는다.** */}
        {card.notes.length > 0 && (
          <ul className="small verification-notes">
            {card.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        {/* 72.8절의 귀환 경로 셋 + 승인. 상한에 걸리면 남는 선택지가 줄어들지만 **막다른
            길은 없다** — 상한 안내는 답을 보낸 뒤 화면이 받는다. */}
        <div className="modal-actions verification-actions">
          <button type="button" onClick={() => onRespond("approve")}>
            승인하고 마무리
          </button>
          <button type="button" onClick={() => onRespond("refix")}>
            다시 고치기
          </button>
          <button type="button" onClick={() => onRespond("replan")}>
            계획부터 다시
          </button>
          <button type="button" className="danger" onClick={() => onRespond("revert_and_stop")}>
            되돌리고 종료
          </button>
        </div>
        <p className="muted small">
          답하지 않으셔도 작업은 사라지지 않고 이 자리에서 기다립니다. **되돌리고 종료**는
          실패가 아니라 결과를 거부하신 것으로 기록됩니다.
        </p>
      </div>
    </div>
  );
}
