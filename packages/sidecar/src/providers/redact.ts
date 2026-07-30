/**
 * 출력 **전에** 비밀값을 지운다 (§6).
 *
 * # 왜 사후 검사로 부족한가
 *
 * 결과 파일을 저장하기 직전에 훑어 자격증명처럼 보이는 값을 찾는 검사가 이미 있다
 * (`findSecretLike`). 그건 파일을 막지만 **stdout에 이미 나간 것은 되돌리지 못한다.**
 * 공급자 오류 본문에 요청 헤더가 되돌아오는 경우가 있고, 그 메시지는 로그·터미널·CI 기록에
 * 남는다. 그래서 오류를 만드는 지점에서 지운다.
 *
 * # 왜 "찾아서 지우기"이고 "통째로 버리기"가 아닌가
 *
 * 오류 메시지는 진단에 필요하다. `model_not_found`인지 `rate_limit`인지 모르면 사용자가
 * 무엇을 해야 할지 알 수 없다. 그래서 메시지를 버리는 대신 **비밀값 모양만** 마스킹한다.
 *
 * # 마스킹 표시에 원문 조각을 남기지 않는다
 *
 * `sk-abc...xyz`처럼 앞뒤를 남기는 흔한 방식을 쓰지 않는다. prefix/suffix도 자격증명의
 * 일부이고, 여러 로그를 모으면 복원 단서가 된다. 길이만 남긴다.
 */

interface Rule {
  pattern: RegExp;
  label: string;
}

const RULES: readonly Rule[] = Object.freeze([
  // Authorization 헤더 전체 — 값이 무엇이든 지운다.
  { pattern: /\b(authorization|x-api-key|api-key)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, label: "AUTH_HEADER" },
  // 공급자별 키 모양. 접두사가 알려진 것들만 잡는다 — 임의 토큰까지 지우면 진단이 어려워진다.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, label: "ANTHROPIC_KEY" },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, label: "OPENAI_KEY" },
  { pattern: /\bghp_[A-Za-z0-9]{16,}/g, label: "GITHUB_TOKEN" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: "PRIVATE_KEY" },
]);

/** 비밀값 모양을 `[REDACTED:LABEL:len=N]`으로 바꾼다. 원문 조각은 남기지 않는다. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (match) => `[REDACTED:${rule.label}:len=${match.length}]`);
  }
  return result;
}

/** 이 문자열에 비밀값처럼 보이는 것이 남아 있는가. 테스트와 저장 직전 확인용. */
export function containsSecretLike(text: string): boolean {
  return RULES.some((rule) => {
    // 전역 정규식은 lastIndex를 들고 다니므로 매번 새로 만든다.
    const probe = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
    return probe.test(text);
  });
}
