/**
 * 불일치 카드 선택지의 **구조** — ui-wireframes.md 3.9절.
 *
 * # 문항이 물은 축이 아니었다
 *
 * 5절 항목은 "선택지가 3개 이상일 때의 레이아웃"을 물었다. 그런데 선택지 개수는 초안 개수와
 * 같고(`positions` 하나당 선택지 하나), 라우터는 executor를 둘까지만 배정한다
 * (multi-engine-routing 13.1절). **셋은 아직 만들어질 수 없다.**
 *
 * 실제로 카드를 어렵게 만드는 것은 개수가 아니라 **한 선택지 안의 구조**다. 선택지 라벨은
 * `value.join(" / ")`로 만들어지는데 `doneCriteria`는 모델이 쓴 문장들의 목록이라, 항목이
 * 서넛만 되어도 라디오 버튼 옆에 문단이 붙는다. 그리고 두 목록이 대부분 같고 한 항목만
 * 다를 때 **사용자는 두 문단을 눈으로 diff해야 한다** — 판정하라고 만든 카드가 판정을
 * 어렵게 만든다.
 *
 * # 여기서 정하는 것
 *
 * 공통 항목과 그 선택지에만 있는 항목을 갈라낸다. **선택의 의미는 바꾸지 않는다** — 고르는
 * 것은 여전히 그 초안의 목록 전체이고 기록에도 전체가 남는다. 달라지는 것은 **무엇을 보고
 * 고르는가**뿐이다.
 *
 * # 개수는 N으로 열어둔다
 *
 * 계산은 선택지 개수에 상관없이 성립하게 써 두고 3개짜리로도 테스트한다. 그러면 executor가
 * 늘어날 때 **다시 물어야 하는 것은 시각 밀도 하나로 좁아진다** — 지금 화면을 미리 그려두는
 * 것과 달리, 만들어질 수 없는 상태를 상상해 그리는 일이 아니다.
 */

export interface OptionValues {
  optionId: string;
  /** 이 선택지가 대표하는 초안의 필드 값. `Disagreement.positions[].value` 그대로다. */
  values: string[];
}

export interface OptionOnly {
  optionId: string;
  /** 이 선택지에만 있는 항목. 비어 있으면 "공통 항목뿐"이라는 뜻이다. */
  only: string[];
}

export interface ChoiceLayout {
  /**
   * 목록으로 그릴 것인가.
   *
   * 값이 하나뿐인 선택지들만 있으면 목록으로 만들 이유가 없다 — 항목 하나짜리 `<ul>`은
   * 구조를 더하지 않고 세로 공간만 먹는다.
   */
  asList: boolean;
  /** 모든 선택지에 들어 있는 항목. **판정 대상이 아니다.** 첫 선택지의 순서를 지킨다. */
  shared: string[];
  /** 선택지별 고유 항목. `options`와 같은 순서다. */
  distinct: OptionOnly[];
}

/**
 * 선택지들을 공통/고유로 가른다.
 *
 * **비어 있는 선택지도 자리를 지킨다** — "이 초안은 아무것도 정하지 않았다"는 하나의 답이고,
 * 목록에서 빼면 사용자가 고를 수 없게 된다.
 */
export function layoutChoices(options: OptionValues[]): ChoiceLayout {
  const asList = options.some((o) => o.values.length >= 2);

  // 공통 항목은 **모든** 선택지에 있는 것이다. 두 개짜리에서는 교집합이지만, 셋 이상에서
  // "둘에만 있는 항목"을 공통으로 세면 그 항목이 빠진 선택지를 고를 근거가 사라진다.
  const shared =
    options.length >= 2
      ? (options[0]?.values ?? []).filter((v) => options.every((o) => o.values.includes(v)))
      : [];

  const distinct = options.map((o) => ({
    optionId: o.optionId,
    only: o.values.filter((v) => !shared.includes(v)),
  }));

  return { asList, shared, distinct };
}

/**
 * 목록에서 고유 항목이 하나도 없는 선택지의 설명.
 *
 * 빈 자리를 그리면 사용자는 그 선택지가 무엇을 뜻하는지 알 수 없다 — **없다는 것도 답이다.**
 */
export function onlyLabel(only: string[], sharedCount: number): string {
  if (only.length > 0) return only.join(" / ");
  return sharedCount > 0 ? "공통 항목만 — 더 요구하지 않음" : "아무것도 정하지 않음";
}

/**
 * 한국어 목적격 조사. 받침 유무로 고른다.
 *
 * **문자열을 이어 붙일 때 조사를 상수로 박으면 절반이 틀린다** — 실제로 그랬다
 * (`완료 기준를 정하지 않음`). 사용자에게 보이는 문장이므로 조용히 틀린 채로 남는다.
 */
export function objectParticle(word: string): "을" | "를" {
  const last = word.trimEnd().slice(-1);
  const code = last.charCodeAt(0);
  // 한글 음절 영역 밖(영문·숫자·기호)은 판정할 근거가 없다. 관례적으로 "를"을 쓴다.
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return "를";
  return (code - 0xac00) % 28 === 0 ? "를" : "을";
}
