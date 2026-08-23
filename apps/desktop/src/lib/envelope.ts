import { render, type Rendered, type UiMessage } from "./messages.js";

/**
 * Rust 명령이 돌려주는 봉투 — ui-wireframes.md 6.4·6.5절.
 *
 * # 왜 실패가 `Err`가 아닌가
 *
 * Tauri의 `Err`는 문자열 하나뿐이라 구조가 들어갈 자리가 없다. 문자열에 구조를 실으면
 * **화면이 문장을 파싱하게 되고**, 그건 6.2절이 없애려는 바로 그것이다.
 *
 * # 그래서 실패가 예외가 아니다
 *
 * 봉투로 온 실패는 **예상된 결과**이므로 `throw`로 다루지 않는다. 종전에는 던져서 잡았는데,
 * `catch`가 `String(error)`로 문장을 만들면서 `Error: `가 앞에 붙어 사용자 화면에 그대로
 * 나갔다 — 예외를 문장 만드는 통로로 쓰면 언젠가 이렇게 샌다.
 *
 * 예외는 **전송 자체가 실패한 경우**에만 남는다(`invoke`가 reject). 봉투로 온 실패와
 * 전송 실패는 다른 사실이고, 갈래를 나눠 두면 그 구별이 코드에 남는다.
 */
export type Envelope<T> = ({ ok: true } & T) | ({ ok: false } & UiMessage);

export type Unwrapped<T> = { ok: true; value: T } | { ok: false; problem: Rendered };

/**
 * 봉투를 벗긴다. 실패면 **카탈로그가 만든 문장**을 함께 준다 — 원문을 그대로 쓰지 않는다.
 *
 * `ok`가 아예 없는 응답(전환되지 않은 옛 명령)은 **성공으로 읽지 않는다.** 그렇게 읽으면
 * 전환을 빠뜨린 명령이 조용히 통과하고, 그 사실은 실패가 실제로 일어나는 날에야 드러난다.
 */
export function unwrap<T>(response: Envelope<T> | null | undefined): Unwrapped<T> {
  if (response && response.ok === true) {
    const { ok: _ok, ...value } = response;
    return { ok: true, value: value as unknown as T };
  }
  // **봉투인지부터 확인한다.** `render`에 아무 객체나 넘기면 코드도 원문도 없는 값에서
  // `text: undefined`가 나와 화면에 빈칸이 그려진다 — 테스트가 실제로 그 상태를 잡았다.
  // 코드가 없어도 원문이 있으면 봉투로 다룬다: 뜻은 전달되기 때문이다.
  const candidate = response as (Partial<UiMessage> & { ok?: unknown }) | undefined;
  const isMessage =
    (typeof candidate?.code === "string" && candidate.code.length > 0) ||
    (typeof candidate?.message === "string" && candidate.message.length > 0);
  const problem = isMessage
    ? (render(candidate as UiMessage) as Rendered)
    : {
        text: "응답이 봉투 형식이 아닙니다 — 이 명령은 아직 전환되지 않았습니다.",
        untranslated: true,
      };
  return { ok: false, problem };
}
