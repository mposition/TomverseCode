/**
 * 공급자 자격증명 해석 — **하나의 구현만 둔다** (§2.10).
 *
 * # 무엇을 고쳤나
 *
 * 예전에는 같은 질문에 두 코드가 다르게 답했다:
 *
 * - 가설 게이트의 preflight는 `OPENAI_API_KEY`와 `TOMVERSE_OPENAI_API_KEY`를 **둘 다** 인정했다.
 * - 어댑터 factory와 evidence binding은 레지스트리의 `apiKeyEnvName`(= `OPENAI_API_KEY`)**만**
 *   읽었다.
 *
 * 그래서 사용자가 `TOMVERSE_OPENAI_API_KEY`만 설정하면 **"자격증명 있음"으로 승인 카드가
 * 나오는데 실행은 `MissingCredentialError`로 죽는다.** 더 나쁜 경우는 두 변수가 **서로 다른
 * 키**를 가질 때다 — probe는 한쪽 키로 확인하고 실행은 다른 쪽 키를 쓰므로, credential binding이
 * "같은 키인지" 확인한다는 보장이 거짓이 된다.
 *
 * # 규칙
 *
 * 1. 후보는 레지스트리의 이름과 `TOMVERSE_` 접두 별칭 **둘뿐**이다. 목록을 늘리지 않는다.
 * 2. 여러 후보가 있고 값이 **같으면** 정본 이름(레지스트리 이름)을 쓴다.
 * 3. 여러 후보가 있고 값이 **다르면** 조용히 하나를 고르지 않고 **차단한다.** 어느 쪽이
 *    사용자 의도인지 코드가 알 수 없고, 틀린 쪽을 고르면 승인과 실행이 다른 키로 갈라진다.
 * 4. 값 자체는 **돌려주기만 하고 저장하지 않는다.** 이 모듈을 지나는 값이 파일·이벤트·로그에
 *    들어가는 경로는 없다.
 *
 * # 환경변수가 어디서 오는가 — 그리고 왜 여기는 그대로인가
 *
 * Rust에 Credential Store가 생겼다(`core/src/credentials.rs`, multi-engine-routing.md 12절).
 * 사용자가 앱 안에서 넣은 키는 Windows Credential Manager(DPAPI)에 저장되고, **sidecar spawn
 * 시 여기 있는 이름으로 주입된다.** 즉 이 모듈이 보는 그림은 하나도 바뀌지 않았다 —
 * 저장소는 주입 지점 **앞**에 놓인 것이지 sidecar가 키를 얻는 경로를 바꾼 것이 아니다.
 *
 * **그래서 `credential.get`을 되살리지 말 것.** 저장소가 있으니 필요할 때 물어보면 된다는
 * 생각이 자연스러워지는 자리인데, 그 순간 "Node가 완전히 장악당해도 Rust 게이트를 반드시
 * 통과해야 한다"는 전제가 사라진다(process-architecture 2·8.2절): 주입은 우리가 고른 것만
 * 한 번 보내는 것이고, 요청은 Node가 언제든 무엇이든 물을 수 있는 것이다.
 * 착지 기준 `injectionStaysOnce`가 이 문장을 못박고,
 * `packages/toolchain/test/credentialBoundary.test.ts`가 검사한다.
 */

/** 별칭 접두사. 이 하나 말고 다른 접두사를 인정하지 않는다. */
export const CREDENTIAL_ENV_ALIAS_PREFIX = "TOMVERSE_";

/** 이 공급자 키를 찾을 환경변수 이름들. 앞이 정본이다. */
export function credentialEnvCandidates(primaryEnvName: string): string[] {
  const alias = `${CREDENTIAL_ENV_ALIAS_PREFIX}${primaryEnvName}`;
  return primaryEnvName === alias ? [primaryEnvName] : [primaryEnvName, alias];
}

export type CredentialResolution =
  | {
      ok: true;
      providerId: string;
      /** 값을 채택한 환경변수 이름. binding·receipt에 남는 것은 **이 이름뿐**이다. */
      envName: string;
      /** 키 값. 호출자는 메모리에서만 쓰고 어디에도 기록하지 않는다. */
      value: string;
      /** 같은 값이 들어 있던 다른 이름들. 사용자에게 정리를 권할 때 쓴다. */
      duplicates: string[];
    }
  | {
      ok: false;
      providerId: string;
      kind: "missing" | "ambiguous";
      /** 실제로 확인한 이름 전부. "없다"고만 말하면 사용자가 어디를 볼지 모른다. */
      checked: string[];
      reason: string;
    };

/**
 * 이 공급자의 키를 해석한다.
 *
 * `preflight`, `planModels`의 준비성, probe evidence의 credential binding, 어댑터 factory,
 * 유료 실행 authorization이 **전부 이 함수를 지난다.**
 */
export function resolveCredential(
  providerId: string,
  primaryEnvName: string,
  env: NodeJS.ProcessEnv
): CredentialResolution {
  const checked = credentialEnvCandidates(primaryEnvName);
  const present = checked
    .map((name) => ({ name, value: (env[name] ?? "").trim() }))
    .filter((c) => c.value.length > 0);

  if (present.length === 0) {
    return {
      ok: false,
      providerId,
      kind: "missing",
      checked,
      reason: `${providerId} 자격증명이 없습니다 — 확인한 환경변수: ${checked.join(", ")}`,
    };
  }

  const distinct = new Set(present.map((c) => c.value));
  if (distinct.size > 1) {
    return {
      ok: false,
      providerId,
      kind: "ambiguous",
      checked,
      reason:
        `${providerId} 자격증명이 ${present.map((c) => c.name).join("와 ")}에 **서로 다른 값**으로 ` +
        `설정되어 있습니다. 어느 것이 의도인지 코드가 고르면 승인할 때 확인한 키와 실제로 쓰는 키가 ` +
        `달라질 수 있으므로 진행하지 않습니다 — 하나만 남기세요.`,
    };
  }

  // 정본 이름이 있으면 그것을 쓴다. 없으면 별칭 이름 그대로 남긴다 — receipt에 "무엇을 읽었는가"가
  // 사실대로 적혀야 한다.
  const chosen = present.find((c) => c.name === primaryEnvName) ?? present[0]!;
  return {
    ok: true,
    providerId,
    envName: chosen.name,
    value: chosen.value,
    duplicates: present.filter((c) => c.name !== chosen.name).map((c) => c.name),
  };
}

/**
 * 값을 읽지 않고 **쓸 수 있는 상태인지만** 본다.
 *
 * 별칭 충돌은 `false`다 — "있지만 쓸 수 없다"를 "있다"로 보고하면 승인 카드가 실행되지 않을
 * 계획을 승인 가능으로 표시한다.
 */
export function credentialUsable(
  providerId: string,
  primaryEnvName: string,
  env: NodeJS.ProcessEnv
): boolean {
  return resolveCredential(providerId, primaryEnvName, env).ok;
}
