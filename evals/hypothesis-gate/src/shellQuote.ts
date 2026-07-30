/**
 * 복사용 명령의 인용 (§10).
 *
 * # 고친 문제
 *
 * Run Card는 실행 명령을 문자열로 이어 붙였다. 사용자의 실제 경로는
 * `C:\Users\Vyper\Documents\Tomverse Code\...`처럼 **공백이 있다.** 그 명령을 그대로 복사하면
 * PowerShell이 `Code\...`를 다음 인자로 읽고, 실행은 엉뚱한 `--output`으로 시작한다.
 * 카드의 목적이 "복사해서 승인 실행"이므로, 인용이 깨지면 카드가 제 역할을 못 한다.
 *
 * # 왜 작은따옴표인가
 *
 * PowerShell의 작은따옴표는 **literal**이다. 안에서 `$`, 백틱, 백슬래시가 해석되지 않는다.
 * Windows 경로는 백슬래시로 가득하므로 큰따옴표를 쓰면 `` ` ``과 `$`를 신경 써야 하고,
 * `C:\temp\` 같은 trailing backslash가 닫는 따옴표를 escape하는 문제가 생긴다.
 * 작은따옴표에서는 escape 대상이 **작은따옴표 하나뿐**이고, 그건 `''`로 이중화한다.
 *
 * # 그리고 argv를 따로 저장한다
 *
 * 사람이 읽는 문자열과 기계가 검증하는 구조를 분리한다. 실행 검증은 문자열을 다시 파싱하지
 * 않고 **argv 배열을 비교**한다 — 재파싱은 인용 규칙을 두 번 구현하는 것이고, 그 둘이 갈라지면
 * "카드와 실행이 같다"는 검증이 거짓이 된다.
 */

/**
 * PowerShell 인자 하나를 인용한다.
 *
 * 인용이 필요 없는 경우(영숫자·하이픈·점·슬래시·콜론만)에는 그대로 둔다 — 모든 인자를
 * 따옴표로 감싸면 읽기 어려워지고, 사람이 카드를 읽지 않게 되는 것도 비용이다.
 */
export function quotePowerShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  // `--flag`와 `A,B,C`, 그리고 공백 없는 경로는 인용 없이 안전하다.
  if (/^[A-Za-z0-9_\-.,:\\/]+$/.test(arg) && !arg.includes("`")) return arg;
  return `'${arg.replace(/'/g, "''")}'`;
}

/** argv 배열 → 복사해서 쓸 수 있는 한 줄. */
export function powerShellCommand(argv: readonly string[]): string {
  return argv.map(quotePowerShellArg).join(" ");
}

/**
 * POSIX 셸 인용 — bash/zsh 사용자를 위한 것.
 *
 * 규칙이 PowerShell과 같다(작은따옴표 literal, 내부 작은따옴표는 닫고 escape하고 다시 열기)
 * 지만 escape 방식이 다르므로 함수를 따로 둔다. 하나로 합치면 어느 셸용인지 알 수 없는
 * 문자열이 나온다.
 */
export function quotePosixArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_\-.,:\\/]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function posixCommand(argv: readonly string[]): string {
  return argv.map(quotePosixArg).join(" ");
}
