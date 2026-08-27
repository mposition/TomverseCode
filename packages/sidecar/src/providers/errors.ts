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
  /**
   * **타임아웃을 취소보다 먼저 본다.**
   *
   * 타임아웃도 구현상 abort지만(`withTimeout`이 controller를 abort한다) 두 사실은 다르다.
   * 취소는 **사용자가 그만두게 한 것**이고 타임아웃은 **우리가 정한 실행 예산을 넘긴 것**이다.
   * 순서가 뒤바뀌어 있어서 모든 타임아웃이 `cancelled`로 기록됐고, 그러면 "사용자가 껐다"와
   * "우리가 기다려주지 않았다"가 같은 값이 되어 어느 쪽도 셀 수 없다.
   *
   * 실측(가설 게이트 P1, 2026-08-27): 검수 호출이 120초에 취소됐는데 기록에는 `cancelled`만
   * 남아, 원인이 타임아웃이라는 것을 알아내려면 시각을 손으로 빼봐야 했다. 그 요청은 공급자에
   * 도달해 과금됐으므로 원인을 아는 것이 곧 고칠 곳을 아는 것이었다.
   */
  if (isTimeout(raw)) {
    return { kind: "timeout", message: raw instanceof Error ? raw.message : "공급자 호출 타임아웃", retryable: true };
  }
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
    /**
     * 429·401·403이 아닌 4xx — **요청이 반려됐다.** 재시도해도 같은 결과다(9절 표).
     *
     * 예전에는 이 자리가 `auth`였다. 그래서 본문이 잘못됐거나 요청이 너무 큰 경우까지
     * "인증 실패"로 읽혔고, 같은 키로 직전 호출이 성공한 뒤에 뜨면 원인과 정반대 방향을
     * 보게 됐다(실측: 게이트 P1에서 gpt-4.1 3회 성공 뒤 4번째가 `auth`로 기록됨).
     *
     * 나누는 것이 과금 판정에도 필요하다. 이 계열은 **추론 전에 반려**되므로 비용이 없고,
     * 그래서 예약을 해제할 근거가 된다 — 5xx와 정반대다.
     */
    return { kind: "rejected", message, status, retryable: false };
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
