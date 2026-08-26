/**
 * 검증 실패의 **귀속**을 화면 문장으로 옮긴다 — state-machine 54절, ui-wireframes 3.28절.
 *
 * # 이 화면이 하던 거짓말
 *
 * 종전 패널은 두 줄이었다: "이번 변경으로 새로 실패: …"와 "변경 전부터 실패 중이던 항목: …".
 * 둘 다 **체크 이름**(build/test/lint)만 실었고, 그래서 원래 실패하는 테스트가 하나 있는
 * 체크에서 이번 변경이 세 개를 더 깨뜨리면 사용자는 `test`가 "변경 전부터 실패 중"이라고만
 * 읽었다 — 54절이 모델에게 하던 거짓말과 **같은 것**이고, 청중만 다르다.
 *
 * # 그리고 54절 이후에는 모순처럼 보인다
 *
 * 54절이 섞인 체크를 `newlyFailing`에도 올렸으므로, 이제 그 체크는 **두 줄에 다 나온다.**
 * 설명 없이 그리면 화면이 자기모순으로 읽힌다("새로 실패인데 변경 전부터 실패 중?").
 * 그래서 섞인 체크는 **따로 묶어** 그 안을 이름으로 가른다.
 *
 * # 가르지 못한 것을 "없다"로 그리지 않는다
 *
 * `testAttribution`이 없으면 러너 출력을 해석하지 못한 것이다(예: `npm test`). 그때 이름을
 * 안 보여 주는 것까지는 맞지만, **말없이 안 보여 주면** 사용자는 "새로 깨진 것이 없다"로
 * 읽는다. 그 사실을 문장으로 말한다.
 */

export interface ReportLike {
  newlyFailing?: string[];
  preexistingFailures?: string[];
  testAttribution?: { kind: string; newlyFailing: string[]; preexisting: string[]; fixed: string[] }[];
}

export interface AttributionGroup {
  kind: string;
  /** 이 체크 안에서 이번 변경이 깨뜨린 테스트들. 비었을 수 있다. */
  newTests: string[];
  /** 변경 전에도 실패하던 테스트들. */
  oldTests: string[];
  /** 이름을 갈랐는가. false면 위 두 목록은 비어 있고 **모른다는 뜻**이다. */
  split: boolean;
}

export interface AttributionView {
  show: boolean;
  /** 이번 변경이 **깨뜨리기만** 한 체크들 — 변경 전에는 이 체크가 통과했다. */
  brokeOnly: AttributionGroup[];
  /** 원래 실패도 있고 새 실패도 있는 체크들. **여기가 종전에 사라지던 자리다.** */
  mixed: AttributionGroup[];
  /** 원래 실패만 있는 체크들 — 이번 변경과 무관하다. */
  oldOnly: AttributionGroup[];
  /** 변경 전에는 실패했는데 지금은 통과하는 테스트들. */
  fixed: { kind: string; tests: string[] }[];
  /** 이름을 가르지 못한 체크가 하나라도 있는가. */
  unsplitNote: string;
}

const EMPTY: AttributionView = {
  show: false,
  brokeOnly: [],
  mixed: [],
  oldOnly: [],
  fixed: [],
  unsplitNote: "",
};

export function attributionView(report: ReportLike | null | undefined): AttributionView {
  if (!report) return EMPTY;

  const newly = report.newlyFailing ?? [];
  const old = report.preexistingFailures ?? [];
  if (newly.length === 0 && old.length === 0) return EMPTY;

  const byKind = new Map(
    (report.testAttribution ?? []).map((entry) => [entry.kind, entry] as const)
  );

  const group = (kind: string): AttributionGroup => {
    const entry = byKind.get(kind);
    if (!entry) return { kind, newTests: [], oldTests: [], split: false };
    return { kind, newTests: entry.newlyFailing, oldTests: entry.preexisting, split: true };
  };

  const newSet = new Set(newly);
  const oldSet = new Set(old);
  // **세 갈래는 배타다.** 종전 두 줄은 배타가 아니어서 섞인 체크가 양쪽에 나왔고,
  // 그건 설명 없이 보면 자기모순이다.
  const brokeOnly = newly.filter((k) => !oldSet.has(k)).map(group);
  const mixed = newly.filter((k) => oldSet.has(k)).map(group);
  const oldOnly = old.filter((k) => !newSet.has(k)).map(group);

  const fixed = (report.testAttribution ?? [])
    .filter((entry) => entry.fixed.length > 0)
    .map((entry) => ({ kind: entry.kind, tests: entry.fixed }));

  // 실패한 체크 중 **이름을 가르지 못한 것**을 센다. 고쳐진 것만 갈린 체크는 여기 해당하지
  // 않으므로 실패 목록에서만 본다.
  const failing = [...new Set([...newly, ...old])];
  const unsplit = failing.filter((kind) => !byKind.has(kind));

  return {
    show: true,
    brokeOnly,
    mixed,
    oldOnly,
    fixed,
    unsplitNote:
      unsplit.length > 0
        ? `${unsplit.join(", ")}는 러너 출력을 개별 테스트로 가르지 못했습니다 — ` +
          "새로 깨진 것이 없다는 뜻이 아니라 **가르지 못했다**는 뜻입니다."
        : "",
  };
}

/**
 * 섞인 체크 한 줄의 문장.
 *
 * **"이건 당신 변경 때문이 아니다"라고 쓰지 않는다.** 그 문장은 이 묶음에서 거짓이다 —
 * 이 체크 안에 이번 변경이 깨뜨린 것이 있다.
 */
export function mixedLabel(group: AttributionGroup): string {
  if (!group.split) {
    return `${group.kind} — 변경 전에도 실패했고 이번 변경으로도 실패했습니다. 어느 쪽인지 가르지 못했습니다.`;
  }
  return (
    `${group.kind} — 변경 전부터 실패하던 것 ${group.oldTests.length}개와 ` +
    `**이번 변경이 깨뜨린 것 ${group.newTests.length}개**가 함께 있습니다.`
  );
}
