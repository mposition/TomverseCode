/**
 * 무인 실행 미리보기를 **화면 문장으로** 옮긴다 — state-machine 47·48절.
 *
 * # 왜 화면이 아니라 여기서 정하는가
 *
 * `blockedAdvice.ts`와 같은 이유다. 이건 계산이고, 계산이 화면 안(tsx)에 있으면 DOM 없이
 * 검증할 방법이 없다.
 *
 * # 이 자리에서 하기 쉬운 세 가지 거짓말
 *
 * **① `humanOnly` 정지를 "스위치를 켜세요"로 뭉개는 것.** 열리는 플래그가 하나라도 있으면
 * 화면은 그것만 보여주고 싶어지는데, 그러면 사용자는 켜고 다시 돌렸다가 같은 자리에서 또
 * 멈춘다(24.8.2절).
 *
 * **② 켜도 열리지 않는 스위치를 권하는 것.** 47.6절이 실제로 찾은 결함이다 —
 * `--allow-git-commit`이 그렇다. Rust가 이미 걸러 `leverDoesNotFree`로 넘겨주므로, 화면이
 * 할 일은 그것을 **지우지 않는 것**이다. 지우면 그 정지에 대해 사용자가 아무 설명도 못 받는다.
 *
 * **③ 이 화면에 없는 스위치를 "켜세요"라고 말하는 것.** 미리보기는 게이트가 아는 레버를
 * 전부 말하는데, 그중 일부는 **화면에 토글이 없다**(`--auto-approve-writes`가 지금 그렇다 —
 * 48.3절). 켤 수 없는 것을 켜라고 하는 것은 ①과 같은 종류의 거짓말이고, 사용자는 없는
 * 체크박스를 찾다가 도구를 의심한다. 그래서 **화면이 실제로 가진 토글 집합을 받아** 구별한다.
 */

export interface AutopilotPermission {
  tool: string;
  probe: string;
  decision: "auto_approve" | "require_user_approval" | "deny";
  matchedRule: string;
  fate: { kind: string; lever?: string };
  rerunFlag: string | null;
  leverDoesNotFree?: string;
}

export interface AutopilotPreview {
  switches: {
    unattended: boolean;
    autoApproveWorkspaceWrites: boolean;
    autoApproveVerification: boolean;
    allowGitCommit: boolean;
  };
  proceeds: AutopilotPermission[];
  stops: AutopilotPermission[];
  denied: AutopilotPermission[];
  rerunFlags: string[];
  humanOnly: string[];
  caveat: string;
}

/** 이 정지에 대해 사용자가 **할 수 있는 일**. 문장이 아니라 값이라 화면이 분기할 수 있다. */
export type StopKind = "toggle_here" | "cli_only" | "lever_does_not_free" | "human_only";

export interface StopLine {
  probe: string;
  matchedRule: string;
  kind: StopKind;
  /** 관련된 플래그. `null`은 **켤 것이 없다**는 사실이다 — 빈칸으로 두면 안 적은 것과 같아진다. */
  flag: string | null;
  detail: string;
}

export interface PreviewSummary {
  show: boolean;
  headline: string;
  /** 사람 없이 그대로 일어나는 것들의 라벨. */
  proceeds: string[];
  stops: StopLine[];
  /** 게이트가 아예 거부하는 것들의 라벨. 스위치와 무관하다. */
  denied: string[];
  /** 미리보기가 스스로 밝힌 한계. **지우지 않는다.** */
  caveat: string;
}

/**
 * 이 화면에서 실제로 켤 수 있는 스위치들.
 *
 * **`--auto-approve-writes`가 없다.** 화면에 그 토글이 없기 때문이고, 그건 실수가 아니라
 * 아직 내리지 않은 결정이다(48.3절). 목록에 없으면 미리보기가 "이 화면에서는 켤 수 없다"고
 * 말하므로, 토글이 생기는 날 여기 한 줄만 늘면 문장이 따라온다.
 */
export const SCREEN_FLAGS: readonly string[] = ["--auto-approve-verification", "--allow-git-commit"];

/** 사용자가 지금 할 수 있는 일 순서. **`human_only`가 마지막인 이유는 할 일이 없어서다.** */
const ORDER: StopKind[] = ["toggle_here", "cli_only", "lever_does_not_free", "human_only"];

function classify(stop: AutopilotPermission, screenFlags: readonly string[]): StopLine {
  // **이 두 갈래는 겹치지 않는다.** `leverDoesNotFree`는 플래그가 있는 레버에만 붙고
  // `humanOnly`에는 플래그가 없기 때문이다 — 그래서 여기 순서는 답을 바꾸지 않는다.
  //
  // 종전 주석은 이 순서에 의미가 있다고 적었는데, 프로브로 순서를 바꿔 보니 **아무 검사도
  // 실패하지 않았다.** 지키는 것이 없는데 지킨다고 적혀 있었던 것이다. 겹칠 수 없다는 사실
  // 자체는 Rust 쪽 두 함수에 흩어져 있으므로, 그쪽에서
  // `a_stop_is_never_both_human_only_and_lever_does_not_free`가 고정한다.
  if (stop.fate.lever === "humanOnly") {
    return {
      probe: stop.probe,
      matchedRule: stop.matchedRule,
      kind: "human_only",
      flag: null,
      detail: "어떤 스위치로도 열 수 없습니다 — 사람이 있는 실행이 필요합니다.",
    };
  }
  if (stop.leverDoesNotFree) {
    return {
      probe: stop.probe,
      matchedRule: stop.matchedRule,
      kind: "lever_does_not_free",
      flag: stop.leverDoesNotFree,
      detail: `${stop.leverDoesNotFree}를 켜도 이 자리는 열리지 않습니다 — 규칙 이름만 바뀝니다.`,
    };
  }
  if (stop.rerunFlag) {
    const here = screenFlags.includes(stop.rerunFlag);
    return {
      probe: stop.probe,
      matchedRule: stop.matchedRule,
      kind: here ? "toggle_here" : "cli_only",
      flag: stop.rerunFlag,
      detail: here
        ? "위 스위치를 켜면 지나갑니다."
        : `이 화면에는 그 스위치가 없습니다 (${stop.rerunFlag}) — 지금은 명령줄에서만 켤 수 있습니다.`,
    };
  }
  // 레버를 읽지 못한 경우. **"열 수 있다"로 접지 않는다** — 모르는 것을 낙관으로 바꾸면
  // 사용자는 켤 것을 찾다가 아무것도 찾지 못한다.
  return {
    probe: stop.probe,
    matchedRule: stop.matchedRule,
    kind: "human_only",
    flag: null,
    detail: "켤 수 있는 스위치를 찾지 못했습니다 — 사람이 있는 실행이 필요합니다.",
  };
}

export function summarizePreview(
  preview: AutopilotPreview | null,
  screenFlags: readonly string[] = SCREEN_FLAGS
): PreviewSummary {
  if (!preview || !preview.switches.unattended) {
    return { show: false, headline: "", proceeds: [], stops: [], denied: [], caveat: preview?.caveat ?? "" };
  }

  const stops = preview.stops
    .map((stop) => classify(stop, screenFlags))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  const blocked = stops.filter((s) => s.kind === "human_only").length;
  const headline =
    stops.length === 0
      ? "이 설정의 무인 실행은 멈추지 않습니다."
      : blocked > 0
        // **막힌 개수를 먼저 말한다.** 뒤에 묻으면 "몇 개 켜면 된다"로 읽힌다.
        ? `이 설정의 무인 실행은 ${stops.length}곳에서 멈추고, 그중 ${blocked}곳은 어떤 스위치로도 열 수 없습니다.`
        : `이 설정의 무인 실행은 ${stops.length}곳에서 멈춥니다.`;

  return {
    show: true,
    headline,
    proceeds: preview.proceeds.map((p) => p.probe),
    stops,
    denied: preview.denied.map((p) => p.probe),
    caveat: preview.caveat,
  };
}
