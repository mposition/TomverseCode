import type { ModelEntry, RoleAssignment } from "@tomverse/protocol";
import { AnthropicAdapter } from "./anthropic.js";
import { resolveCredential } from "./credentials.js";
import { FakeProviderAdapter, type FakeProviderOptions } from "./fake.js";
import { OpenAIAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

// 가설 게이트가 이 서브패스만 import하므로, 계약 버전과 오류 타입을 여기서 함께 노출한다.
export { ADAPTER_CONTRACT_VERSION, ProviderCallFailure } from "./types.js";
export type { ProviderCallMetadata, ProviderResponse } from "./types.js";
export { redactSecrets, containsSecretLike } from "./redact.js";
export {
  CREDENTIAL_ENV_ALIAS_PREFIX,
  credentialEnvCandidates,
  credentialUsable,
  resolveCredential,
} from "./credentials.js";
export type { CredentialResolution } from "./credentials.js";
// 재시도 래퍼도 같은 서브패스로 노출한다 — 가설 게이트가 attempt별 dispatch 사실을 검증한다(§2.6).
export { attemptFacts, callWithRetry, ProviderCallFailed } from "./retry.js";
export type { ProviderAttemptFacts, RetryPolicy } from "./retry.js";

/**
 * 역할 배정 → 어댑터 인스턴스.
 *
 * 자격증명은 프로세스 시작 시 Rust가 주입한 환경변수에서 읽는다 (process-architecture.md 2절):
 * Node는 키를 디스크에 저장하지 않고 메모리에만 둔다. 레지스트리에는 **환경변수 이름만** 있고
 * 값은 없다 — 그래서 레지스트리를 로그로 찍어도 키가 새지 않는다.
 */

export interface AdapterFactoryOptions {
  /** fake 공급자 동작 스크립트 (테스트에서만 채운다) */
  fake?: FakeProviderOptions;
  env?: NodeJS.ProcessEnv;
}

export class MissingCredentialError extends Error {
  constructor(
    readonly providerId: string,
    readonly envName: string,
    /** `missing`인지 `ambiguous`인지 — 사용자가 해야 하는 일이 다르다. */
    readonly kind: "missing" | "ambiguous" = "missing",
    message?: string
  ) {
    super(message ?? `${providerId} 공급자의 자격증명이 없습니다 (${envName} 미설정)`);
    this.name = "MissingCredentialError";
  }
}

export function createAdapter(
  entry: ModelEntry,
  assignment: RoleAssignment,
  options: AdapterFactoryOptions = {}
): ProviderAdapter {
  const env = options.env ?? process.env;

  // fake 공급자는 키를 요구하지 않는다. 레지스트리에서 apiBaseUrl로 구분한다 —
  // providerId 문자열 비교보다 "이 엔트리가 로컬 가짜인가"라는 사실에 가깝다.
  if (entry.apiBaseUrl.startsWith("local://")) {
    return new FakeProviderAdapter({ entry, apiKey: "" }, options.fake);
  }

  // **공용 resolver를 지난다** (§2.10). preflight·준비성·evidence binding·이 factory가 같은
  // 규칙으로 같은 변수를 고르지 않으면, "확인했다"와 "실행한다"가 다른 키를 가리킬 수 있다.
  const resolved = resolveCredential(entry.providerId, entry.apiKeyEnvName, env);
  if (!resolved.ok) {
    throw new MissingCredentialError(entry.providerId, entry.apiKeyEnvName, resolved.kind, resolved.reason);
  }
  const apiKey = resolved.value;

  switch (entry.providerId) {
    case "openai":
      return new OpenAIAdapter({ entry, apiKey });
    case "anthropic":
      return new AnthropicAdapter({ entry, apiKey });
    default:
      // openai-compatible 공급자는 공용 어댑터 + baseUrl 교체로 처리할 수 있으나,
      // M0에서는 검증된 공급자만 다룬다 (multi-engine-routing.md 9절: 엔진은 나중에).
      throw new Error(
        `${entry.providerId} 공급자용 어댑터가 아직 없습니다. ` +
          `M0 범위는 openai/anthropic + fake입니다 (docs/design/multi-engine-routing.md 9절).`
      );
  }
}

/** 역할별 어댑터 묶음. */
export interface RoleAdapters {
  executor: ProviderAdapter;
  reviewer?: ProviderAdapter;
}

export function createRoleAdapters(
  assignments: RoleAssignment[],
  lookup: (modelId: string) => ModelEntry | undefined,
  options: AdapterFactoryOptions = {}
): RoleAdapters {
  const build = (role: "executor" | "reviewer"): ProviderAdapter | undefined => {
    const assignment = assignments.find((a) => a.role === role);
    if (!assignment) return undefined;
    const entry = lookup(assignment.modelId);
    if (!entry) throw new Error(`레지스트리에 ${assignment.modelId} 엔트리가 없습니다`);
    return createAdapter(entry, assignment, options);
  };

  const executor = build("executor");
  if (!executor) throw new Error("executor 역할이 배정되지 않았습니다");
  return { executor, reviewer: build("reviewer") };
}
