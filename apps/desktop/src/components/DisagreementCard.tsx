import { useMemo, useState } from "react";
import type { Disagreement, DraftNarrative, NarrativeField, UserDecisionInput } from "../types";
import { SecretShapeWarning, useSecretShapeScan } from "./SecretShapeWarning";

/**
 * 불일치 판정 카드 — docs/design/ui-wireframes.md 3.9절.
 *
 * # 3.4절 확인 필요 카드와 다른 카드다
 *
 * 확인 필요 카드는 모델이 **"모르겠다"**고 말한 경우이고, 이건 두 모델이 **둘 다 안다고 믿는데
 * 답이 다른** 경우다. 사용자에게 이 둘은 전혀 다른 상황이므로 시각적으로 구별한다.
 *
 * # 지켜야 하는 규칙 (전부 3.9절)
 *
 * - **선택지에 모델 이름을 표시하지 않는다.** "GPT는 A라고, Claude는 B라고 했습니다"로 보여주면
 *   사용자가 요구가 아니라 **모델 선호로 판단**한다. 판정 대상은 "무엇이 맞는 요구인가"이지
 *   "어느 모델이 나은가"가 아니다. 출처는 개발자 모드에서만 노출한다.
 * - **강제 선택이 기본이고 개방형 확인을 만들지 않는다.** 자유 입력은 항상 열어두되 세 번째
 *   선택지로 둔다 — "이렇게 이해했는데 맞습니까?"는 그럴듯하면 "네"를 누르는 기계를 만든다.
 * - **일치한 필드를 초록 체크로 그리지 않는다.** 두 모델이 같은 방식으로 틀릴 수 있으므로
 *   일치는 약한 증거다. 이 카드에서 초록색은 사용자가 직접 판정한 항목에만 쓴다.
 * - **비-blocking 쟁점은 목록에 섞지 않고** 접힌 영역에만 둔다. 필수와 참고를 같은 목록에
 *   섞으면 전부 참고 항목처럼 읽힌다.
 */

type Choice = { optionId?: string; text: string };

export function DisagreementCard({
  disagreements,
  narratives = [],
  onSubmit,
  devMode,
}: {
  disagreements: Disagreement[];
  /** 두 초안의 자유 서술. **질문이 아니다** — 아래 접힌 영역에만 쓴다(17.12절). */
  narratives?: DraftNarrative[];
  onSubmit: (decisions: UserDecisionInput[]) => void;
  devMode: boolean;
}) {
  const blocking = useMemo(() => disagreements.filter((d) => d.blocking), [disagreements]);
  const advisory = useMemo(() => disagreements.filter((d) => !d.blocking), [disagreements]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  // 모든 필수 항목에 답이 있어야 보낼 수 있다. 부분 제출을 허용하면 남은 항목이
  // "묻지 못한 쟁점"으로 기록되는데, 실제로는 물었고 사용자가 건너뛴 것이라 로그가 거짓말을 한다.
  const answered = blocking.filter((d) => (choices[d.disagreementId]?.text ?? "").trim().length > 0);
  const complete = answered.length === blocking.length && blocking.length > 0;

  const setChoice = (id: string, choice: Choice) => setChoices((prev) => ({ ...prev, [id]: choice }));

  // **직접 입력만 검사한다.** 선택지의 라벨은 모델 초안에서 온 문구라 사용자가 붙여넣은 것이
  // 아니고, 거기까지 검사하면 모델이 예시로 적은 키 모양에 매번 경고가 뜬다. 검사 대상은
  // "사용자가 방금 친 것"이다(17.11절).
  //
  // 한 문자열로 합쳐 한 번만 검사하는 이유: 쟁점마다 따로 부르면 입력 하나에 프로세스 경계를
  // 여러 번 넘게 되고, 경고는 어차피 카드 하나에 한 번 뜬다.
  const freeformText = useMemo(
    () =>
      Object.values(choices)
        .filter((choice) => choice.optionId === undefined)
        .map((choice) => choice.text)
        .join("\n"),
    [choices]
  );
  const freeformSecrets = useSecretShapeScan(freeformText);

  return (
    <div className="panel card-disagreement">
      <h2>
        확인이 필요합니다 — 두 모델의 해석이 갈렸습니다{" "}
        <span className="muted small">({blocking.length}건)</span>
      </h2>
      <p className="muted small">
        모델이 모호하다고 말한 것이 아니라, 두 초안이 실제로 다른 답을 냈습니다. 어느 쪽이 맞는
        요구인지는 사용자만 판정할 수 있습니다.
      </p>

      <ol className="disagreements">
        {blocking.map((d) => {
          const chosen = choices[d.disagreementId];
          return (
            <li key={d.disagreementId} className="disagreement">
              <div className="disagreement-head">
                <span className="disagreement-field">{fieldLabel(d.field)}</span>
                <span className="badge badge-required">필수</span>
              </div>
              <p className="disagreement-question">{d.question.text}</p>

              {d.question.options.map((option) => (
                <label key={option.optionId} className="disagreement-option">
                  <input
                    type="radio"
                    name={d.disagreementId}
                    checked={chosen?.optionId === option.optionId}
                    onChange={() => setChoice(d.disagreementId, { optionId: option.optionId, text: option.label })}
                  />
                  <span>{option.label}</span>
                  {/* 출처는 개발자 모드에서만. 평소에 보이면 모델 선호로 판단하게 된다. */}
                  {devMode && <code className="muted small">{option.fromProposalId}</code>}
                </label>
              ))}

              <label className="disagreement-option">
                <input
                  type="radio"
                  name={d.disagreementId}
                  checked={chosen !== undefined && chosen.optionId === undefined}
                  onChange={() => setChoice(d.disagreementId, { text: "" })}
                />
                <span>직접 입력</span>
              </label>
              {chosen !== undefined && chosen.optionId === undefined && (
                <input
                  className="disagreement-freeform"
                  value={chosen.text}
                  autoFocus
                  placeholder="둘 다 아니면 직접 적어주세요"
                  onChange={(e) => setChoice(d.disagreementId, { text: e.target.value })}
                />
              )}

              {devMode && <p className="muted small">blocking 판정 근거: {d.blockingReason}</p>}
            </li>
          );
        })}
      </ol>

      {/* **갈렸지만 막지 않은 쟁점**과 **두 초안의 서술**은 다른 것이라 따로 접는다.
          전자는 규칙이 "이건 물어볼 만큼은 아니다"라고 판정한 결과이고, 후자는 애초에
          판정 대상이 아니다(17.12절). 하나로 묶으면 판정한 것과 판정하지 않은 것이 같은
          목록에 섞여, 목록 전체가 "그냥 참고"로 읽힌다. */}
      {advisory.length > 0 && (
        <details className="disagreement-advisory">
          <summary>갈렸지만 묻지 않은 쟁점 ({advisory.length}건)</summary>
          <ul>
            {advisory.map((d) => (
              <li key={d.disagreementId}>
                <span className="disagreement-field">{fieldLabel(d.field)}</span>
                <ul>
                  {d.positions.map((p) => (
                    <li key={p.proposalId} className="muted small">
                      {p.value.join(" / ") || "(없음)"}
                    </li>
                  ))}
                </ul>
                {devMode && <p className="muted small">판정 근거: {d.blockingReason}</p>}
              </li>
            ))}
          </ul>
          <p className="muted small">
            규칙이 "묻지 않아도 된다"고 판정한 항목입니다 — 답하지 않아도 진행합니다. 필수 항목과
            섞어 놓으면 필수가 참고처럼 읽히기 때문에 따로 두었습니다.
          </p>
        </details>
      )}

      {narratives.length > 0 && (
        <details className="disagreement-advisory">
          <summary>두 초안이 각각 어떻게 봤는지</summary>
          <ul>
            {narratives.map((n) => (
              <li key={n.field}>
                <span className="disagreement-field">{narrativeLabel(n.field)}</span>
                <ul>
                  {n.positions.map((p) => (
                    <li key={p.proposalId} className="muted small">
                      {p.value.join(" / ") || "(없음)"}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {/* **차이를 주장하지 않는다.** 서술은 거의 언제나 다르므로 "차이가 있습니다"는
              참이지만 아무것도 알려주지 않고, 매번 채워지는 목록은 곧 읽히지 않는다. */}
          <p className="muted small">
            비교 결과가 아니라 두 초안의 서술을 그대로 옮긴 것입니다. 서술은 표현만 달라도 다르게
            보이므로 여기서 "갈렸다"를 판정하지 않습니다.
          </p>
        </details>
      )}

      <SecretShapeWarning hits={freeformSecrets} />

      <div className="row">
        <button
          onClick={() =>
            onSubmit(
              blocking.map((d) => {
                const choice = choices[d.disagreementId]!;
                return {
                  disagreementId: d.disagreementId,
                  ...(choice.optionId ? { optionId: choice.optionId } : {}),
                  text: choice.text.trim(),
                };
              })
            )
          }
          disabled={!complete}
        >
          {freeformSecrets.length > 0 ? "그대로 확인" : "확인"}
        </button>
        {!complete && (
          <span className="muted small">
            필수 {blocking.length}건 중 {answered.length}건 선택됨
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 필드 이름의 사용자 표기.
 *
 * sidecar의 `contrast.ts`에도 같은 표가 있다. 프로세스가 다르고(UI는 프로토콜을 직접 import하지
 * 않는다 — `types.ts` 주석 참조) 문자열을 이벤트에 실어 보내면 UI 문구를 sidecar가 정하게 되므로,
 * 표시 문자열은 표시하는 쪽이 갖는다. 한쪽을 고칠 때 다른 쪽도 볼 것.
 */
function narrativeLabel(field: NarrativeField): string {
  return field === "interpretation" ? "원인 진단" : "위험";
}

function fieldLabel(field: Disagreement["field"]): string {
  switch (field) {
    case "doneCriteria":
      return "완료 기준";
    case "requiredTests":
      return "필요한 검증";
    case "targetPaths":
      return "수정 위치";
  }
}
