/**
 * 백엔드(sidecar) 상태 배너 — process-architecture.md 5.2절, ui-wireframes.md 6절.
 *
 * 재spawn 상한에 도달하면 사용자가 워크스페이스를 다시 열어야 하는데, 종전에는 **문장으로만**
 * 안내했다. 그러면 사용자가 스스로 경로를 다시 골라야 하고, 무엇보다 화면이 "지금 버튼을
 * 줘야 하는 상황인가"를 안내 문장에서 읽어내야 한다 — 문구를 다듬는 순간 버튼이 사라진다.
 *
 * 그래서 판정은 Rust가 `recovery` 값으로 주고, 여기서는 **그 값을 그리는 규칙**만 정한다.
 * 규칙이 화면 안에 있으면 검증할 방법이 없어서 순수 함수로 뺐다.
 *
 * # 문장도 값에서 만든다
 *
 * 같은 이유로 **문장 자체도 프로세스 경계를 넘지 않는다.** Rust는 `code`와 `params`를 주고
 * 문장은 여기서 만든다 — 문장을 넘기면 그 문장은 영원히 한국어이고, 다국어 카탈로그를
 * 만들어도 **카탈로그 밖에 남는다**(ui-wireframes.md 6절: 반쪽 번역).
 */

/** 사용자에게 보이는 문자열의 카탈로그. 지금은 한국어 하나뿐이다 — 6절이 시점을 정한다. */
const KO: Record<string, (params: Record<string, unknown>) => string> = {
  respawnLimit: (p) => `백엔드가 ${p.attempts}번 다시 시작한 뒤에도 계속 종료됩니다.`,
  protocolViolation: (p) =>
    `백엔드와의 통신이 프로토콜 위반으로 끊겼습니다. 다시 시작하지 않습니다 — 같은 위반이 반복될 뿐입니다. (${p.reason})`,
  spawnFailed: (p) => `백엔드를 다시 시작할 수 없습니다 (${p.attempt}/${p.max}): ${p.error}`,
};

/** Rust `SupervisorStatus`의 미러. `noWorkspace`는 워크스페이스를 아직 안 연 상태다. */
export type BackendStatus =
  | { state: "alive" }
  | { state: "noWorkspace" }
  /** 죽어 있지만 다음 작업에서 자동으로 다시 뜬다. **사용자가 할 일이 없다.** */
  | { state: "willRespawn"; remaining: number }
  | {
      state: "unavailable";
      code: string;
      params: Record<string, unknown>;
      /** 원문. **기본값이 아니라 대체 표시다** — 카탈로그가 이 코드를 모를 때만 쓴다. */
      message: string;
      recovery: "reopenWorkspace" | "none";
    };

export interface BackendBanner {
  /** 배너 문구. */
  message: string;
  /** "다시 열기" 버튼을 그릴지. **`recovery`가 정한다** — 문장에서 읽어내지 않는다. */
  canReopen: boolean;
  /**
   * 카탈로그가 이 코드를 몰라 원문을 그대로 썼는가.
   *
   * **조용히 넘기지 않는다.** 모르는 코드에서 빈 문장을 그리면 사용자는 앱이 멈춘 이유를
   * 알 수 없고, 안다고 표시하면 번역되지 않은 문장이 번역된 것처럼 보인다.
   */
  untranslated: boolean;
}

/**
 * 코드로 문장을 만든다. 모르는 코드는 **원문으로 떨어진다** — 번역은 없지만 뜻은 전달된다.
 *
 * 이 대체 경로가 있어야 Rust가 새 코드를 추가할 때 화면이 빈칸을 그리지 않는다. 반쪽 번역은
 * 나쁘지만, **반쪽 번역과 빈 화면 중에서는 반쪽 번역이 낫다.**
 */
export function renderCode(code: string, params: Record<string, unknown>, fallback: string): {
  message: string;
  untranslated: boolean;
} {
  const render = KO[code];
  if (!render) return { message: fallback, untranslated: true };
  return { message: render(params), untranslated: false };
}

/**
 * 배너를 그릴 필요가 있으면 그 내용을, 없으면 `null`.
 *
 * `willRespawn`에 배너를 띄우지 않는 이유: 다음 작업에서 자동으로 복구되므로 **사용자가 할
 * 일이 없다.** "죽어 있다"와 "사용자가 개입해야 한다"를 한 칸에 넣으면 화면이 필요 없는
 * 조치를 요구하게 되고, 그러면 사용자는 배너를 무시하는 법을 배운다.
 */
export function bannerFor(status: BackendStatus | null): BackendBanner | null {
  if (!status) return null;
  if (status.state !== "unavailable") return null;
  const rendered = renderCode(status.code, status.params ?? {}, status.message);
  return {
    message: rendered.message,
    untranslated: rendered.untranslated,
    // **`none`이면 버튼을 주지 않는다.** 프로토콜 위반은 다시 열어도 같은 위반이 반복되므로,
    // 버튼을 주면 눌러도 같은 결과가 나온다 — 그건 안내가 아니라 거짓말이다.
    canReopen: status.recovery === "reopenWorkspace",
  };
}

/**
 * 다시 열 수 있는가 — 버튼을 실제로 누를 수 있는지까지 본다.
 *
 * `canReopen`이 참이어도 **다시 열 경로를 모르면** 누를 수 없다. 워크스페이스 정보가 없는
 * 상태에서 버튼만 그리면 누른 뒤에 아무 일도 일어나지 않는다.
 */
export function reopenTarget(banner: BackendBanner | null, workspacePath: string | null): string | null {
  if (!banner?.canReopen) return null;
  const trimmed = workspacePath?.trim();
  return trimmed ? trimmed : null;
}

/** 카탈로그가 아는 코드들. 테스트가 Rust 쪽 코드 목록과 대조하는 데 쓴다. */
export function knownCodes(): string[] {
  return Object.keys(KO).sort();
}
