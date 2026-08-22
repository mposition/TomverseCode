/**
 * 사용자에게 보이는 문장의 **단일 카탈로그** — ui-wireframes.md 6절.
 *
 * # 왜 한 곳인가
 *
 * 경계마다 자기 렌더러를 두면 카탈로그도 갈라지고, 그러면 **"이 코드가 카탈로그에 있는가"를
 * 한 번에 확인할 수 없다.** 확인할 수 없는 규칙은 지켜지지 않는다. Rust 쪽도 같은 이유로
 * 봉투(`{code, params, message}`)를 하나로 뒀다(`core/src/uimsg.rs`).
 *
 * # 지금은 한국어 하나뿐이다
 *
 * 6절이 분리 시점의 조건을 정한다 — 나머지 경계의 전환이 끝나고 한국어가 아닌 사용자가 실제로
 * 생겼을 때다. 그때 이 파일 옆에 `en`이 생기고 `render`가 언어를 고른다. **지금 언어 선택을
 * 만들어 두지 않는 이유**: 고를 것이 하나뿐인 선택지는 코드를 늘리기만 하고, 두 번째 언어가
 * 실제로 생길 때 그 모양이 맞을지도 알 수 없다.
 */

/** Rust `UiMessage`의 미러. */
export interface UiMessage {
  code: string;
  params?: Record<string, unknown> | null;
  /** 원문. **기본값이 아니라 대체 표시다** — 카탈로그가 이 코드를 모를 때만 쓴다. */
  message: string;
}

type Render = (params: Record<string, unknown>) => string;

/**
 * 코드 → 문장.
 *
 * **값은 파라미터에서 온다.** Rust가 이미 이어 붙인 문장을 그대로 쓰지 않는 이유가 이것이다 —
 * 어순이 다른 언어에서는 같은 값이 다른 자리에 들어간다.
 */
const KO: Record<string, Render> = {
  // 백엔드(sidecar) — process-architecture.md 5.2절
  respawnLimit: (p) => `백엔드가 ${p.attempts}번 다시 시작한 뒤에도 계속 종료됩니다.`,
  protocolViolation: (p) =>
    `백엔드와의 통신이 프로토콜 위반으로 끊겼습니다. 다시 시작하지 않습니다 — 같은 위반이 반복될 뿐입니다. (${p.reason})`,
  spawnFailed: (p) => `백엔드를 다시 시작할 수 없습니다 (${p.attempt}/${p.max}): ${p.error}`,

  // 승인 응답 — process-architecture.md 11.5절
  approvalUnknown: () => "해당 승인 요청을 찾을 수 없습니다 (이미 처리되었거나 시간이 초과되었습니다).",
  approvalWrongWorkspace: (p) =>
    `다른 워크스페이스(${p.belongsTo})의 승인 요청입니다. 그 사이 워크스페이스가 바뀌었으므로 처리하지 않았습니다.`,
  approvalGone: () => "승인 응답을 전달할 수 없습니다 (요청이 이미 종료되었습니다).",
};

export interface Rendered {
  text: string;
  /**
   * 카탈로그가 이 코드를 몰라 원문을 그대로 썼는가.
   *
   * **조용히 넘기지 않는다.** 모르는 코드에서 빈 문장을 그리면 사용자는 무슨 일이 일어났는지
   * 알 수 없고, 안다고 표시하면 번역되지 않은 문장이 번역된 것처럼 보인다.
   */
  untranslated: boolean;
}

/**
 * 봉투를 문장으로. 모르는 코드는 **원문으로 떨어진다** — 번역은 없지만 뜻은 전달된다.
 *
 * 이 대체 경로가 있어야 Rust가 새 코드를 추가할 때 화면이 빈칸을 그리지 않는다.
 * **반쪽 번역과 빈 화면 중에서는 반쪽 번역이 낫다.**
 */
export function render(message: UiMessage | null | undefined): Rendered | null {
  if (!message) return null;
  const renderer = KO[message.code];
  if (!renderer) return { text: message.message, untranslated: true };
  return { text: renderer(message.params ?? {}), untranslated: false };
}

/** 카탈로그가 아는 코드들. 테스트가 Rust 쪽 코드 목록과 대조하는 데 쓴다. */
export function knownCodes(): string[] {
  return Object.keys(KO).sort();
}
