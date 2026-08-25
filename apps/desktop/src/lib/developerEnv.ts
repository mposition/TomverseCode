/**
 * 개발자 환경 준비를 **화면 한 줄로** 옮긴다 — state-machine 40절.
 *
 * # 왜 화면에 있어야 하는가
 *
 * 이 기능의 값어치는 준비가 **성공했을 때**가 아니라 실패했을 때 드러난다. 준비하지 못한 채
 * `cargo build`가 돌면 사용자가 보는 것은 `stdarg.h: No such file or directory` 한 줄이고,
 * 그 문장은 "C 컴파일러가 없다"로 읽힌다 — 실제로는 있는데 헤더 경로를 모르는 것이다.
 *
 * 그래서 실패는 **처방까지** 말하고, 성공은 짧게 말한다. 성공까지 길게 말하면 매 명령마다
 * 같은 문단이 흘러가고, 그러면 실패했을 때의 한 줄도 함께 안 읽힌다.
 */

export type DeveloperEnv =
  | { kind: "prepared"; how?: string; from?: string; names?: string[] }
  | { kind: "notFound"; advice?: string; checked?: { what: string; value: string; result: string }[] }
  | { kind: "broken"; from?: string; detail?: string };

/**
 * 도구 결과의 `developerEnv`를 문장으로. **`null`은 "필요 없는 명령이었다"**이고, 그건
 * 아무 말도 하지 않아야 하는 경우다 — "준비하지 못했다"와 뭉개면 모든 명령에 경고가 붙는다.
 */
export function describeDeveloperEnv(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const env = value as DeveloperEnv;
  switch (env.kind) {
    case "prepared":
      // 짧게. 이건 정상 동작이고, 정상 동작이 로그를 채우면 이상 동작이 안 보인다.
      return `개발자 환경 준비됨 (${env.names?.length ?? 0}개 변수)`;
    case "notFound":
      return `개발자 환경을 준비하지 못했습니다 — 명령은 그대로 실행했습니다. ${env.advice ?? ""}`.trim();
    case "broken":
      return `개발자 환경 준비가 불완전합니다: ${env.detail ?? ""} — 명령은 그대로 실행했습니다.`.trim();
    default:
      // 모르는 형식을 지어내지 않는다. 낡은 기록에서 화면이 죽지 않는 것이 우선이다.
      return null;
  }
}

/**
 * 이 줄을 눈에 띄게 그릴 것인가. **성공은 조용하다.**
 */
export function isDeveloperEnvProblem(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") return false;
  const kind = (value as { kind?: string }).kind;
  return kind === "notFound" || kind === "broken";
}

/**
 * 기본 모드의 이벤트 목록에 이 `TOOL_COMPLETED`를 보일 것인가.
 *
 * **정상 동작은 조용하고 이상 동작은 보인다.** 모든 도구 실행을 보이면 목록이 `read_file`로
 * 덮이고, 정작 읽어야 할 한 줄이 그 안에 묻힌다. 그렇다고 전부 감추면 준비 실패가 개발자
 * 모드에서만 보이는데, 그건 이 기능이 도우려는 사용자가 켜지 않는 모드다.
 */
export function toolEventDeservesAttention(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const output = (payload as { output?: unknown }).output;
  const env = output && typeof output === "object" ? (output as { developerEnv?: unknown }).developerEnv : undefined;
  return isDeveloperEnvProblem(env);
}
