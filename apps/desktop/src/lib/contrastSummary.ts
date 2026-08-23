import type { DisagreementField } from "../types";

/**
 * 대조 결과를 화면이 말하는 방법 — state-machine-and-protocol.md 17절, ui-wireframes 3.9절.
 *
 * # 조용한 것도 주장이다
 *
 * 17절은 `DISAGREEMENT_DETECTED`를 **불일치 0건이어도 발행한다**고 정했다. 근거는 "쟁점이
 * 없었다"와 "대조하지 않았다"가 다른 사실이라는 것이다. 그런데 화면은 갈린 것이 있을 때만
 * 카드를 띄웠으므로, **사용자에게는 두 경우가 똑같이 아무것도 없는 화면**이었다.
 *
 * 그리고 그 침묵이 하필 가장 위험한 쪽으로 읽힌다. 두 모델이 같은 방식으로 틀리면 불일치가
 * 생기지 않으므로(9.2-B 상관된 오류), "아무 말도 없었다"는 **일치의 증거가 아니라 정보의
 * 부재**인데 사용자에게는 문제 없음으로 읽힌다. 3.9절이 "일치를 초록 체크로 그리지 말라"고
 * 금지한 착시를, 아무것도 안 그리는 것으로는 막지 못한다.
 *
 * # 네 결말을 뭉개지 않는다
 *
 * 특히 **일치**와 **비교할 것이 없었음**을 가르는 것이 중요하다. 대조 코드는 양쪽이 모두 비어
 * 있는 필드를 `agreedFields`에 넣지 않는다 — "침묵을 동의로 세지 않는다". 화면이 그 둘을
 * 합치면 그 규율이 마지막 한 걸음에서 무효가 된다.
 */

export type ContrastOutcomeKind = "not_contrasted" | "nothing_to_compare" | "agreed" | "disagreed";

export interface ContrastSummary {
  kind: ContrastOutcomeKind;
  /** 두 초안이 같았던 필드. **검증된 필드가 아니다.** */
  agreedFields: DisagreementField[];
  /** 갈린 필드. */
  disagreedFields: DisagreementField[];
  /** 그중 카드에서 답을 요구한 수(blocking). */
  askedCount: number;
  /** 카드에 함께 실었지만 답이 선택이던 수(비-blocking). */
  advisoryCount: number;
  /**
   * 화면에 그대로 나가는 문장.
   *
   * **결말마다 다르다.** 하나의 문장으로 네 경우를 덮으려 하면 어느 경우에도 정확하지 않은
   * 문장이 되고, 그런 문장은 곧 읽히지 않는다.
   */
  note: string;
  /**
   * 초록(성공) 톤을 써도 되는가.
   *
   * **언제나 false다.** 필드로 두는 이유는 화면 쪽에서 `kind`를 다시 문자열 비교해 톤을
   * 정하기 시작하면 그 비교가 여러 곳에 생기고, 언젠가 하나가 `agreed`를 성공으로 칠하기
   * 때문이다. 값 하나로 못 박아 둔다.
   */
  positiveTone: false;
}

export interface ContrastInput {
  /** `DISAGREEMENT_DETECTED`가 있었는가. 없으면 대조 단계에 도달하지 않은 것이다. */
  detected?: {
    contrasted?: boolean;
    agreedFields?: DisagreementField[];
    disagreements?: { field: DisagreementField }[];
    askedCount?: number;
    advisoryCount?: number;
  };
  /** 대조를 드롭했으면 그 사유가 여기 있다(`contrast_dropped...`). */
  appliedPolicies?: string[];
}

const DROP_PREFIX = "contrast_dropped";

export function summarizeContrast(input: ContrastInput): ContrastSummary | null {
  const detected = input.detected;
  const dropReason = (input.appliedPolicies ?? []).find((p) => p.startsWith(DROP_PREFIX));

  // 대조 단계에 도달하지도 않았고 드롭 사유도 없으면 **아직 할 말이 없다.** 여기서 빈 패널을
  // 그리면 "대조하지 않았다"를 실행 초반부터 주장하게 된다.
  if (!detected && dropReason === undefined) return null;

  if (!detected?.contrasted) {
    return {
      kind: "not_contrasted",
      agreedFields: [],
      disagreedFields: [],
      askedCount: 0,
      advisoryCount: 0,
      note:
        "두 번째 실행자를 배정하지 못해 대조하지 않았습니다" +
        (dropReason ? ` (${dropReason})` : "") +
        ". 이 실행은 두 모델이 같은 말을 했는지에 대해 아무것도 말하지 않습니다.",
      positiveTone: false,
    };
  }

  const agreedFields = detected.agreedFields ?? [];
  const disagreedFields = (detected.disagreements ?? []).map((d) => d.field);

  if (disagreedFields.length === 0 && agreedFields.length === 0) {
    return {
      kind: "nothing_to_compare",
      agreedFields: [],
      disagreedFields: [],
      askedCount: 0,
      advisoryCount: 0,
      // **일치가 아니다.** 두 초안이 아무 말도 하지 않은 필드는 같다고 셀 수 없다.
      note: "대조는 돌렸지만 두 초안이 비교할 값을 내놓지 않았습니다 — 같았다는 뜻이 아닙니다.",
      positiveTone: false,
    };
  }

  if (disagreedFields.length === 0) {
    return {
      kind: "agreed",
      agreedFields,
      disagreedFields: [],
      askedCount: 0,
      advisoryCount: 0,
      note:
        "두 초안이 이 항목들에서 같았습니다. **일치는 검증이 아닙니다** — 두 모델이 같은 방식으로 " +
        "틀리면 불일치 자체가 생기지 않으므로, 여기서 조용한 것이 옳다는 증거는 아닙니다.",
      positiveTone: false,
    };
  }

  return {
    kind: "disagreed",
    agreedFields,
    disagreedFields,
    askedCount: detected.askedCount ?? 0,
    advisoryCount: detected.advisoryCount ?? 0,
    note:
      `두 초안이 ${disagreedFields.length}개 항목에서 갈렸습니다` +
      (agreedFields.length > 0 ? ` (${agreedFields.length}개는 같았습니다 — 일치는 검증이 아닙니다)` : "") +
      ".",
    positiveTone: false,
  };
}
