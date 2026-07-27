import type { EngineRole, ISODateTime, ModelId, ProviderId, TokenUsage } from "./common.js";

/**
 * 작업 지침 4.6절 — 공급자 중립 인터페이스가 다루는 사용량/오류의 정규화된 형태.
 * 어댑터별 원문 필드명(input_tokens vs prompt_tokens 등)은 어댑터 안에서만 존재한다.
 */
export interface ProviderUsage {
  taskId: string;
  /** "draft:1", "review:2", "fix:1" — providerRetries의 키와 같은 호출 식별자 */
  callId: string;
  role: EngineRole;
  providerId: ProviderId;
  modelId: ModelId;
  usage: TokenUsage;
  /** 레지스트리의 economics로 계산. 가격이 없으면 undefined (0으로 위장하지 않는다). */
  costUsd?: number;
  latencyMs: number;
  /** 이 호출이 몇 번째 재시도였는지 (0 = 첫 시도) */
  attempt: number;
  createdAt: ISODateTime;
}

/**
 * docs/design/state-machine-and-protocol.md 9절 — 인프라 재시도와 의미론적 루프를 섞지 않기 위한 분류.
 * 재시도 여부가 이 분류에서 결정된다.
 */
export type ProviderErrorKind =
  /** 429. Retry-After 우선 존중, 없으면 지수 백오프. 재시도 대상. */
  | "rate_limit"
  /** 5xx / 네트워크 / 스트리밍 중 연결 끊김. 재시도 대상. */
  | "transient"
  /** 인증 실패, 잘못된 요청, 콘텐츠 정책 위반. 재시도 무의미 → provider_config_error. */
  | "auth"
  /** 이 자격증명으로는 그 모델을 못 쓴다 (gpt-5 org verification 사건). 재시도 무의미. */
  | "model_unavailable"
  /** 구조화 출력이 스키마를 만족하지 않음. 프롬프트 재시도는 의미가 있으나 별도로 센다. */
  | "schema_violation"
  /** 호출 자체가 타임아웃 */
  | "timeout"
  /** 사용자/오케스트레이터가 취소 */
  | "cancelled";

export interface NormalizedProviderError {
  kind: ProviderErrorKind;
  message: string;
  /** HTTP 상태 코드가 있으면 보존 */
  status?: number;
  retryAfterMs?: number;
  retryable: boolean;
}

export interface ProviderCapabilitiesView {
  providerId: ProviderId;
  modelId: ModelId;
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}
