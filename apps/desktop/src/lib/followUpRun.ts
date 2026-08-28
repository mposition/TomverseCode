// **확장자를 붙인다.** 이 디렉터리의 다른 파일들은 확장자 없이 서로를 import하는데, 그건
// 전부 `import type`이라 컴파일에서 지워지기 때문이다. **값을 가져오는 첫 import**가
// 여기이고, 확장자가 없으면 ESM이 런타임에 찾지 못한다(화면 빌드는 번들러가 가려 준다 —
// 그래서 증상이 `node --test`에서만 나온다).
import { SCREEN_FLAGS } from "./autopilotPreview.js";
import type { BlockedReport } from "./blockedAdvice";

/**
 * 무인 정지 뒤에 **이어서 다시 돌리기** — ui-wireframes 5절 ③, state-machine 62절.
 *
 * # "재개"가 아니다
 *
 * 5절은 이 항목을 *"그 승인을 사람이 이어받아 **재개**하는 경로"* 라고 적었고, 괄호로
 * *"상태 머신에 재개 진입점이 없다"* 를 덧붙였다. 진입점이 없는 것이 아니라 **재개할 상태가
 * 없다.**
 *
 * 무인 정지는 `FAILED`로 끝나고, 그 시점의 초안·검수·계획은 전부 sidecar의 메모리에 있었다.
 * 프로세스가 끝나면 그것들은 사라진다(process-architecture 5.1절이 재spawn에 대해 적은 것과
 * 같은 사실이다 — "그 상태는 죽은 프로세스에 있었다").
 *
 * 그러므로 "멈춘 지점부터 이어간다"는 것은 **만들 수 없다.** 만들 수 있는 것은 **새 실행**이고,
 * 그것을 재개라고 부르면 사용자는 토큰이 다시 나가지 않는다고 믿는다.
 *
 * # 그래서 이 모듈이 하는 일
 *
 * 정지 보고서에서 **다음 실행에 켤 것**을 유도하고, 켜서 될 일과 안 될 일을 가른다.
 * 그리고 켜는 행위가 **정지 하나가 아니라 실행 전체에 적용된다**는 사실을 말한다.
 */

export interface FollowUpPlan {
  /** 이 영역을 그릴 것인가. 정지가 없으면 이어서 돌릴 것도 없다. */
  show: boolean;
  /**
   * 다음 실행에 **이 화면이 켤 수 있는** 스위치들. 정지 보고서에서 유도한다 — 사용자가
   * 손으로 고르지 않는다.
   */
  grant: string[];
  /**
   * 보고서가 켜라고 했지만 **이 화면에 토글이 없는** 스위치들 (48.3절).
   *
   * 버튼이 "이 스위치를 켜고"라고 말하는데 그중 하나가 켜지지 않으면, 사용자는 켰다고 믿고
   * 돌렸다가 같은 자리에서 또 멈춘다 — 48.3절이 미리보기에서 잡은 것과 **같은 거짓말**이
   * 버튼 쪽에서 되살아나는 자리다.
   */
  cliOnly: string[];
  /**
   * 켤 수 있는 것이 하나라도 있는가.
   *
   * `false`면 **버튼을 주지 않는다**: 같은 설정으로 다시 돌리면 같은 자리에서 또 멈추고,
   * 그건 사용자의 시간과 토큰을 쓰는 것 말고는 하는 일이 없다.
   */
  canRerun: boolean;
  /** 어떤 스위치로도 열 수 없는 정지가 남아 있는가. */
  blockedByHumanOnly: boolean;
  /** 이 실행이 **왜 재개가 아닌지**. 지우면 사용자는 토큰이 다시 안 나간다고 믿는다. */
  notAResume: string;
  /** 켜는 행위의 **범위**. 정지 하나 때문에 켜지만 적용은 실행 전체다. */
  scopeWarning: string;
  /** 워크스페이스가 어떤 상태인지. 앞선 실행의 변경이 그대로 남아 있다. */
  workspaceNote: string;
}

const NOT_A_RESUME =
  "이것은 재개가 아니라 **새 실행**입니다 — 멈춘 지점의 초안과 검수는 그 실행과 함께 사라졌으므로 " +
  "처음부터 다시 돌고 토큰도 다시 나갑니다.";

const WORKSPACE_NOTE =
  "앞선 실행이 이미 적용한 변경은 워크스페이스에 그대로 남아 있습니다 — 되돌리려면 먼저 되돌리기를 하세요.";

const EMPTY: FollowUpPlan = {
  show: false,
  grant: [],
  cliOnly: [],
  canRerun: false,
  blockedByHumanOnly: false,
  notAResume: NOT_A_RESUME,
  scopeWarning: "",
  workspaceNote: WORKSPACE_NOTE,
};

export function planFollowUp(
  report: BlockedReport | null | undefined,
  screenFlags: readonly string[] = SCREEN_FLAGS
): FollowUpPlan {
  if (!report || report.stops.length === 0) return EMPTY;

  // **보고서에서 유도한다.** 화면이 플래그 목록을 손으로 적으면 게이트의 레버가 늘 때
  // 화면만 뒤처지고, 뒤처진 화면은 **켤 수 있는 것을 못 켠다**(사용자에게는 "안 열린다"로 보인다).
  const asked = [...new Set(report.rerunFlags)].sort();
  // **이 화면이 켤 수 있는 것만 켠다고 말한다**(48.3절). 켤 수 없는 것을 "켜고"라고 하면
  // 사용자는 켰다고 믿고 돌렸다가 같은 자리에서 또 멈춘다.
  const grant = asked.filter((flag) => screenFlags.includes(flag));
  const cliOnly = asked.filter((flag) => !screenFlags.includes(flag));
  const blockedByHumanOnly = report.humanOnly.length > 0;

  return {
    show: true,
    grant,
    cliOnly,
    // **`humanOnly`가 남아 있어도 켤 것이 있으면 돌릴 수 있다** — 더 멀리 가고 거기서 멈춘다.
    // 그 사실은 아래 경고가 말한다. 반대로 이 화면이 켤 수 있는 것이 하나도 없으면
    // 돌려 봐야 제자리다 — 명령줄에서만 켤 수 있는 것이 남아 있어도 마찬가지다.
    canRerun: grant.length > 0,
    blockedByHumanOnly,
    notAResume: NOT_A_RESUME,
    scopeWarning: scopeWarningFor(grant, cliOnly, blockedByHumanOnly),
    workspaceNote: WORKSPACE_NOTE,
  };
}

/**
 * **켜는 범위를 말한다.**
 *
 * 사용자는 *"이 patch 하나"* 때문에 `--auto-approve-writes`를 켜는데, 그 스위치는 **다음 실행
 * 전체**에 적용된다 — 열 개를 묻지 않고 쓸 수 있다. 24.8절이 처방을 낼 때 이 사실을 말하지
 * 않았던 이유는 거기서는 사용자가 명령줄에 직접 적었기 때문이다. 버튼이 생기는 순간
 * **그 한 번의 클릭이 무엇을 넓히는지**가 사용자에게서 멀어진다.
 */
function scopeWarningFor(
  grant: readonly string[],
  cliOnly: readonly string[],
  blockedByHumanOnly: boolean
): string {
  // **명령줄에서만 켤 수 있는 것을 먼저 말한다**(48.3절). 이 화면에 없는 스위치를 "켜세요"로
  // 뭉개면 사용자는 없는 체크박스를 찾다가 도구를 의심한다.
  const cliNote =
    cliOnly.length > 0
      ? ` 그리고 **이 화면에 없는 스위치가 남아 있습니다** (${cliOnly.join(", ")}) — 지금은 명령줄에서만 켤 수 있습니다.`
      : "";
  if (grant.length === 0) {
    return (
      "이 화면에서 켤 수 있는 스위치가 없습니다 — 같은 설정으로 다시 돌리면 같은 자리에서 또 멈춥니다." + cliNote
    );
  }
  const scope =
    `이 스위치는 멈춘 지점 하나가 아니라 **다음 실행 전체**에 적용됩니다 — ` +
    `같은 종류의 요청이 몇 번 오든 묻지 않습니다.`;
  if (!blockedByHumanOnly) return scope + cliNote;
  // **더 멀리 가지만 끝까지 가지는 못한다**는 것을 함께 말한다. 말하지 않으면 사용자는
  // 켜고 돌렸다가 다른 자리에서 또 멈추고, 그 두 번째 정지를 도구의 오작동으로 읽는다.
  return (
    `${scope} 그리고 **어떤 스위치로도 열 수 없는 정지가 남아 있습니다** — ` +
    `더 멀리 가지만 끝까지 가지는 못합니다.${cliNote}`
  );
}
