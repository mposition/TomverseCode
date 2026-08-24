/**
 * 무인 정지의 처방을 **화면 문장으로** 옮긴다 — state-machine 24.8절.
 *
 * # 왜 화면이 아니라 여기서 정하는가
 *
 * 이 판정은 계산이다: 정지가 있었는가, 정책으로 열 수 있는가, 켤 것이 있는가. 계산이 화면
 * 안(tsx)에 있으면 DOM 없이 검증할 방법이 없다(CLAUDE.md의 `src/lib` 규칙).
 *
 * # 이 자리에서 가장 하기 쉬운 거짓말
 *
 * **`humanOnly` 정지를 "스위치를 켜세요"로 뭉개는 것.** 열리는 플래그가 하나라도 있으면 화면은
 * 그것만 보여주고 싶어지는데, 그러면 사용자는 켜고 다시 돌렸다가 같은 자리에서 또 멈춘다.
 * 24.8.2절이 판정에서 `humanOnly` 하나가 나머지를 이기게 만든 이유가 그것이고, 화면도 같은
 * 규칙을 따라야 한다.
 *
 * 두 번째는 **한계를 지우는 것**이다. 보고서는 "이번 실행이 도달한 지점까지만" 안다. 그걸
 * 화면이 빼면 사용자는 한 번이면 된다고 믿고, 두 번째 정지를 도구의 오작동으로 읽는다.
 */

export interface BlockedReport {
  verdict: "not_blocked" | "unblockable_by_policy" | "requires_human";
  stops: {
    requestId: string;
    tool: string;
    normalizedTarget: string;
    matchedRule: string;
    unblockedBy: string;
    rerunFlag: string | null;
  }[];
  rerunFlags: string[];
  humanOnly: string[];
  caveat: string;
}

export interface BlockedAdvice {
  /** 화면에 이 영역을 그릴 것인가. */
  show: boolean;
  /** 한 줄 요약. */
  headline: string;
  /**
   * 다시 돌릴 때 켤 것들. **`requires_human`이면 이것만으로 부족하다** — 그 사실은
   * `needsHuman`이 말한다.
   */
  flags: string[];
  /** 정책으로 열 수 없는 정지가 있는가. */
  needsHuman: boolean;
  /** 보고서가 스스로 밝힌 한계. **지우지 않는다.** */
  caveat: string;
}

export function adviseOnBlocked(report: BlockedReport | null): BlockedAdvice {
  if (!report || report.verdict === "not_blocked") {
    return {
      show: false,
      headline: "",
      flags: [],
      needsHuman: false,
      caveat: report?.caveat ?? "",
    };
  }

  const needsHuman = report.verdict === "requires_human";
  const stopCount = report.stops.length;
  const headline = needsHuman
    ? `무인 실행이 ${stopCount}곳에서 멈췄고, 그중 ${report.humanOnly.length}곳은 정책으로 열 수 없습니다 — 사람이 있는 실행이 필요합니다.`
    : `무인 실행이 ${stopCount}곳에서 멈췄습니다. 아래를 켜고 다시 돌리면 그 지점들은 지나갑니다.`;

  return {
    show: true,
    headline,
    // 열리는 플래그는 `requires_human`일 때도 보여준다 — 사람이 붙어도 그 왕복은 줄어든다.
    flags: report.rerunFlags,
    needsHuman,
    caveat: report.caveat,
  };
}
