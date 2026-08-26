import type { AutopilotPreview } from "./autopilotPreview";
import type { BlockedReport } from "./blockedAdvice";

/**
 * **돌리기 전의 예고**와 **멈춘 뒤의 사실**을 잇는다 —
 * state-machine 48.6절, ui-wireframes 3.29절.
 *
 * # 왜 이어야 하는가
 *
 * 두 패널은 같은 질문에 반대편에서 답한다. 미리보기(47절)는 *"이 스위치로 돌리면 어디서
 * 멈추는가"*이고 `blocked`(24.8절)는 *"어디서 멈췄고 무엇을 켜면 지나가는가"*다. **같은
 * 규칙 이름을 쓰는데** 화면에는 따로 있어서, 사용자가 눈으로 이어 읽어야 한다.
 *
 * # 그런데 "예고가 맞았다/틀렸다"로 접으면 안 된다
 *
 * 47.9절이 이 둘의 관계를 이미 못박아 두었다:
 *
 * > 이 목록은 "요청되면 어떻게 되는가"이지 "무엇이 요청되는가"가 아니다. (…) 후자를 알려면
 * > 실행해야 하고, 그게 24.8절 `blocked`가 답하는 질문이다 — **이 둘은 짝이지 대체재가 아니다.**
 *
 * 그래서 미리보기가 다루지 않은 규칙에서 멈춘 것은 **예고가 틀린 것이 아니다.** 미리보기는
 * 고정된 probe 집합에 대해 답하고, 실행은 모델이 실제로 요청한 것에 대해 벌어진다.
 *
 * **틀린 경우는 따로 있다**: 미리보기가 그 규칙을 보고 *"지나간다"* 고 말했는데 거기서
 * 멈춘 경우다. 그건 짝의 문제가 아니라 **예고 자체가 어긋난 것**이고, 화면이 크게 말해야 한다.
 *
 * 그 셋을 뭉개면 어느 쪽으로든 거짓이 된다: 전부 "예고대로"라고 하면 어긋남이 사라지고,
 * 전부 "예고가 틀렸다"고 하면 도구가 스스로를 못 믿게 만든다.
 */

export type JoinKind =
  /** 미리보기가 "여기서 멈춘다"고 했고, 실제로 멈췄다. */
  | "as_previewed"
  /** 미리보기가 "지나간다"고 했는데 멈췄다. **예고가 어긋났다.** */
  | "contradicted"
  /** 미리보기의 probe 집합에 그 규칙이 없었다. 어긋남이 아니라 **다루지 않은 자리**다. */
  | "not_probed";

export interface JoinedStop {
  requestId: string;
  tool: string;
  matchedRule: string;
  kind: JoinKind;
  /** 사용자가 읽을 한 줄. */
  detail: string;
}

export interface PreviewVsBlocked {
  show: boolean;
  headline: string;
  stops: JoinedStop[];
  /**
   * 미리보기가 "여기서 멈춘다"고 했는데 이번 실행에서는 그 규칙에 닿지 않은 것들.
   *
   * **"예고가 틀렸다"가 아니다** — 대개 실행이 거기까지 가지 않았다는 뜻이다(앞에서 이미
   * 멈췄거나, 모델이 그 도구를 요청하지 않았다). 그래도 보여주는 이유는 다음 실행에서
   * 만날 수 있는 자리이기 때문이다.
   */
  notReached: { matchedRule: string; probe: string }[];
  /** 두 보고서가 스스로 밝힌 한계. **둘 다 지우지 않는다.** */
  caveats: string[];
}

const EMPTY: PreviewVsBlocked = { show: false, headline: "", stops: [], notReached: [], caveats: [] };

export function joinPreviewAndBlocked(
  preview: AutopilotPreview | null | undefined,
  blocked: BlockedReport | null | undefined
): PreviewVsBlocked {
  // **둘 다 있어야 이을 수 있다.** 하나만 있으면 각자의 패널이 답한다 — 여기서 반쪽을
  // 그리면 없는 쪽에 대해 아무 말도 하지 않으면서 이어 본 척하게 된다.
  if (!preview || !blocked) return EMPTY;
  if (blocked.verdict === "not_blocked" || blocked.stops.length === 0) {
    return {
      ...EMPTY,
      show: true,
      headline: "이번 실행은 멈추지 않았습니다.",
      // 예고했던 자리는 여전히 보여준다 — 다음 실행에서 만날 수 있다.
      notReached: preview.stops.map((s) => ({ matchedRule: s.matchedRule, probe: s.probe })),
      caveats: caveatsOf(preview, blocked),
    };
  }

  const previewStops = new Map(preview.stops.map((s) => [s.matchedRule, s] as const));
  // **`proceeds`와 `denied`를 함께 본다.** 미리보기가 "지나간다"고 한 자리에서 멈췄으면
  // 그것이 어긋남이고, "거부한다"고 한 자리에서 멈춘 것은 어긋남이 아니다(거부도 정지다).
  const previewProceeds = new Set(preview.proceeds.map((p) => p.matchedRule));

  const stops: JoinedStop[] = blocked.stops.map((stop) => {
    const kind: JoinKind = previewStops.has(stop.matchedRule)
      ? "as_previewed"
      : previewProceeds.has(stop.matchedRule)
        ? "contradicted"
        : "not_probed";
    return {
      requestId: stop.requestId,
      tool: stop.tool,
      matchedRule: stop.matchedRule,
      kind,
      detail: detailFor(kind),
    };
  });

  const reachedRules = new Set(blocked.stops.map((s) => s.matchedRule));
  const notReached = preview.stops
    .filter((s) => !reachedRules.has(s.matchedRule))
    .map((s) => ({ matchedRule: s.matchedRule, probe: s.probe }));

  return {
    show: true,
    headline: headlineFor(stops),
    stops,
    notReached,
    caveats: caveatsOf(preview, blocked),
  };
}

function detailFor(kind: JoinKind): string {
  switch (kind) {
    case "as_previewed":
      return "미리보기가 예고한 자리입니다.";
    case "contradicted":
      // **가장 크게 말해야 하는 줄.** 미리보기를 믿고 무인으로 돌린 사용자가 배신당한 자리다.
      return "미리보기는 이 자리가 지나간다고 했습니다 — 예고가 어긋났습니다. 미리보기를 그대로 믿지 마세요.";
    case "not_probed":
      // **"예고가 틀렸다"가 아니다.** 미리보기는 고정된 probe 집합에 답하고, 실행은 모델이
      // 실제로 요청한 것에 대해 벌어진다(47.9절 — 둘은 짝이지 대체재가 아니다).
      return "미리보기가 다루지 않은 규칙입니다 — 예고는 \"요청되면 어떻게 되는가\"이고 무엇이 요청될지는 돌려 봐야 압니다.";
  }
}

function headlineFor(stops: readonly JoinedStop[]): string {
  const contradicted = stops.filter((s) => s.kind === "contradicted").length;
  if (contradicted > 0) {
    // **어긋남을 먼저 말한다.** 뒤에 묻으면 "대체로 맞았다"로 읽힌다.
    return `미리보기와 어긋난 정지가 ${contradicted}곳 있습니다 — 예고는 지나간다고 했습니다.`;
  }
  const notProbed = stops.filter((s) => s.kind === "not_probed").length;
  if (notProbed > 0) {
    return `${stops.length}곳에서 멈췄고, 그중 ${notProbed}곳은 미리보기가 다루지 않은 규칙입니다.`;
  }
  return `${stops.length}곳에서 멈췄고 전부 미리보기가 예고한 자리입니다.`;
}

/**
 * 두 보고서의 한계를 **둘 다** 싣는다.
 *
 * 하나만 실으면 나머지 한계가 사라지고, 이어 본 화면은 두 보고서보다 **더 많이 아는 것처럼**
 * 보인다 — 잇는 행위가 만들어내는 고유한 거짓말이다.
 */
function caveatsOf(preview: AutopilotPreview, blocked: BlockedReport): string[] {
  return [preview.caveat, blocked.caveat].filter((c) => c.trim().length > 0);
}
