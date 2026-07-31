import type { NormalizedProviderError, ProviderErrorKind } from "@tomverse/protocol";
import { ProviderCallFailure } from "./types.js";

/**
 * 공급자 오류 정규화 — docs/design/state-machine-and-protocol.md 9절.
 *
 * 이 분류가 재시도 여부를 결정한다. 잘못 분류하면 (a) 재시도해도 소용없는 인증 오류로
 * 루프를 태우거나 (b) 일시적 오류에 즉시 실패한다. 그래서 "모르면 transient"가 아니라
 * **모르면 재시도하지 않는다** — 알 수 없는 오류를 반복 호출하는 것은 비용만 쓴다.
 */

const RETRYABLE: ProviderErrorKind[] = ["rate_limit", "transient", "timeout"];

export function normalizeProviderError(raw: unknown): NormalizedProviderError {
  // AbortError — 취소는 오류가 아니지만 오류 채널로 도착한다.
  if (isAbort(raw)) {
    return { kind: "cancelled", message: "호출이 취소되었습니다", retryable: false };
  }

  // **어댑터가 스스로 분류했으면 그것을 쓴다** (§2.6).
  //
  // `ProviderCallFailure`는 어댑터가 응답을 실제로 본 뒤 만든 오류다 — 어느 계층에서 무엇이
  // 실패했는지 여기보다 정확히 안다. 그 분류를 버리고 status만으로 다시 추측하면, 어댑터가
  // 확보한 사실이 재시도 판정에서 사라진다. 실측으로 `status`가 없는 파싱 실패가 네트워크
  // 오류로 재분류되어 재시도 여부가 뒤바뀌었다.
  if (raw instanceof ProviderCallFailure) {
    return raw.classification;
  }

  // 구조화 출력 경계 검증 실패. 재시도 축이 아니라 "모델이 계약을 어겼다"는 사실이므로
  // 다른 오류와 섞지 않는다 — 사용자에게 보여줄 안내도 다르다.
  if (raw instanceof Error && raw.name === "ValidationError") {
    return { kind: "schema_violation", message: raw.message, retryable: false };
  }

  const status = extractStatus(raw);
  const message = extractMessage(raw);
  const lower = message.toLowerCase();

  // 모델 미지원 판정을 401/403 auth 판정보다 **먼저** 한다.
  // gpt-5의 Organization Verification 실패는 403으로 오지만 원인과 해결책이 인증 실패와 다르다
  // (키를 고칠 게 아니라 다른 모델을 골라야 한다). 순서가 뒤바뀌면 사용자에게 잘못된 안내를 준다.
  if (
    lower.includes("model_not_found") ||
    lower.includes("does not exist") ||
    (lower.includes("not found") && lower.includes("model")) ||
    lower.includes("organization must be verified") ||
    lower.includes("unsupported model") ||
    lower.includes("model is not supported")
  ) {
    return { kind: "model_unavailable", message, status, retryable: false };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      message,
      status,
      retryAfterMs: extractRetryAfterMs(raw),
      retryable: true,
    };
  }

  if (status !== undefined && status >= 500) {
    return { kind: "transient", message, status, retryable: true };
  }

  if (status === 401 || status === 403) {
    return { kind: "auth", message, status, retryable: false };
  }

  if (status === 400 && (lower.includes("schema") || lower.includes("json"))) {
    return { kind: "schema_violation", message, status, retryable: false };
  }

  if (isTimeout(raw) || lower.includes("timeout") || lower.includes("etimedout")) {
    return { kind: "timeout", message, retryable: true };
  }

  // 네트워크 계층 오류 — status가 없다.
  if (status === undefined && /econnreset|enotfound|eai_again|socket hang up|fetch failed|network/.test(lower)) {
    return { kind: "transient", message, retryable: true };
  }

  if (status !== undefined && status >= 400 && status < 500) {
    // 429 외 4xx는 재시도해도 같은 결과다 (9절 표).
    return { kind: "auth", message, status, retryable: false };
  }

  return { kind: "transient", message, status, retryable: false };
}

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE.includes(kind);
}

function isAbort(raw: unknown): boolean {
  if (raw instanceof Error) {
    return raw.name === "AbortError" || raw.message.toLowerCase().includes("aborted");
  }
  return false;
}

function isTimeout(raw: unknown): boolean {
  return raw instanceof Error && (raw.name === "TimeoutError" || raw.name === "APIConnectionTimeoutError");
}

function extractStatus(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function extractMessage(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    const candidate = raw as { message?: unknown; error?: { message?: unknown } };
    if (typeof candidate.message === "string") return candidate.message;
    if (typeof candidate.error?.message === "string") return candidate.error.message;
  }
  return "알 수 없는 공급자 오류";
}

function extractRetryAfterMs(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const headers = (raw as { headers?: unknown }).headers;
  if (!headers) return undefined;

  const read = (key: string): string | undefined => {
    if (typeof (headers as { get?: unknown }).get === "function") {
      const value = (headers as { get(k: string): string | null }).get(key);
      return value ?? undefined;
    }
    const record = headers as Record<string, unknown>;
    const value = record[key] ?? record[key.toLowerCase()];
    return typeof value === "string" ? value : undefined;
  };

  const retryAfter = read("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}
