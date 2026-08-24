import type { ModelEntry, RoleAssignment } from "@tomverse/protocol";
import { AnthropicAdapter } from "./anthropic.js";
import { FakeProviderAdapter, type FakeProviderOptions } from "./fake.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

// 가설 게이트가 이 서브패스만 import하므로, 계약 버전과 오류 타입을 여기서 함께 노출한다.
export { ADAPTER_CONTRACT_VERSION, ProviderCallFailure } from "./types.js";
export type { ProviderCallMetadata, ProviderResponse } from "./types.js";
export { redactSecrets, containsSecretLike } from "./redact.js";

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
  constructor(readonly providerId: string, readonly envName: string) {
    super(`${providerId} 공급자의 자격증명이 없습니다 (${envName} 미설정)`);
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

  const apiKey = env[entry.apiKeyEnvName];
  if (!apiKey || apiKey.trim().length === 0) {
    throw new MissingCredentialError(entry.providerId, entry.apiKeyEnvName);
  }

  switch (entry.providerId) {
    case "openai":
      return new OpenAIAdapter({ entry, apiKey });
    case "anthropic":
      return new AnthropicAdapter({ entry, apiKey });
    case "google":
      return new GeminiAdapter({ entry, apiKey });
    default:
      // openai-compatible 공급자는 공용 어댑터 + baseUrl 교체로 처리할 수 있으나,
      // **검증된 공급자만 다룬다** (multi-engine-routing.md 9절: 엔진은 나중에).
      // 여기 도달했다는 것은 레지스트리에 엔트리가 있는데 분기가 없다는 뜻이고,
      // 적합성 스위트가 그 상태를 실행 전에 잡는다("팩토리가 어댑터를 만들 수 있다").
      throw new Error(
        `${entry.providerId} 공급자용 어댑터가 아직 없습니다. ` +
          `현재 범위는 openai/anthropic/google + fake입니다 (docs/design/multi-engine-routing.md 9절).`
      );
  }
}

/** 역할별 어댑터 묶음. */
export interface RoleAdapters {
  executor: ProviderAdapter;
  /**
   * 대조용 두 번째 실행자 (multi-engine-routing.md 13.1절).
   *
   * **역할 이름이 아니라 두 번째 `executor` 배정이다.** 하는 일이 primary와 완전히 같으므로
   * (같은 스냅샷, 같은 프롬프트, 같은 스키마) 별도 역할을 만들지 않았다. 여기서 필드 이름을
   * 나눈 것은 호출 지점에서 "어느 쪽이 primary인가"를 헷갈리지 않기 위한 것뿐이다.
   */
  coExecutor?: ProviderAdapter;
  reviewer?: ProviderAdapter;
  /** 검수자가 배정된 모델. 13.3절 절충에서 실제 검수자를 바꿔 끼울 때 비교 기준이 된다. */
  reviewerModelId?: string;
}

export function createRoleAdapters(
  assignments: RoleAssignment[],
  lookup: (modelId: string) => ModelEntry | undefined,
  options: AdapterFactoryOptions = {}
): RoleAdapters {
  const buildFrom = (assignment: RoleAssignment | undefined): ProviderAdapter | undefined => {
    if (!assignment) return undefined;
    const entry = lookup(assignment.modelId);
    if (!entry) throw new Error(`레지스트리에 ${assignment.modelId} 엔트리가 없습니다`);
    return createAdapter(entry, assignment, options);
  };

  // **순서가 의미를 갖는다** — 첫 번째 executor 배정이 primary다(13.1절).
  const executors = assignments.filter((a) => a.role === "executor");
  const executor = buildFrom(executors[0]);
  if (!executor) throw new Error("executor 역할이 배정되지 않았습니다");

  const reviewerAssignment = assignments.find((a) => a.role === "reviewer");
  return {
    executor,
    coExecutor: buildFrom(executors[1]),
    reviewer: buildFrom(reviewerAssignment),
    reviewerModelId: reviewerAssignment?.modelId,
  };
}
