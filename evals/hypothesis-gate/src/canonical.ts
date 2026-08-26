import { createHash } from "node:crypto";

/**
 * 승인 아티팩트의 **정규 직렬화와 해시** (§2.1).
 *
 * # 무엇을 고쳤나 — 실측으로 확인된 P0 결함
 *
 * 예전 구현은 이랬다:
 *
 * ```ts
 * JSON.stringify(value, Object.keys(value).sort())
 * ```
 *
 * `JSON.stringify`의 **array replacer는 property whitelist**이고, 그 whitelist가 **모든 깊이에**
 * 적용된다. 최상위 key만 목록에 넣었으므로 중첩 객체의 key는 하나도 살아남지 못한다 —
 * 즉 중첩 객체가 전부 `{}`로 직렬화된다. 실제로 확인한 결과:
 *
 * ```
 * {a:1, nested:{x:1}, arr:[{h:"aaa"}]}  →  {"a":1,"arr":[{}],"nested":{}}
 * {a:1, nested:{x:9}, arr:[{h:"bbb"}]}  →  {"a":1,"arr":[{}],"nested":{}}   ← 같다
 * ```
 *
 * 그래서 Run Card의 `models.executor.modelId`, `stage.fixtureIds`, `stage.callBudget`,
 * `fixtureHashes[*].hash`, `arms[*].providers`, `readiness` 내부를 **아무리 바꿔도 cardHash가
 * 바뀌지 않았다.** P0 attestation의 `checks[*]`도 마찬가지였다. 해시가 지키던 것은 사실상
 * 최상위 스칼라뿐이었다.
 *
 * # 이 구현이 지키는 것
 *
 * - key를 **모든 깊이에서** 재귀적으로 정렬한다.
 * - 배열의 **순서는 보존한다** — 순서가 의미인 값(argv, fixture 실행 순서)이 있기 때문이다.
 * - `string`/`boolean`/`null`/유한한 `number`만 허용한다.
 * - `undefined`·함수·`symbol`·`bigint`·`NaN`·`Infinity`는 **경로와 함께 예외로 거부한다.**
 *   `JSON.stringify`는 이것들을 조용히 지우거나 `null`로 바꾼다 — 승인 아티팩트에서 그런
 *   손실이 일어나면 "해시는 같은데 내용이 다른" 두 문서가 생긴다.
 * - locale·플랫폼에 의존하지 않는다. key 정렬은 `Array.prototype.sort`의 기본(UTF-16 코드 단위)
 *   비교를 명시적으로 쓰고 `localeCompare`를 쓰지 않는다 — `localeCompare`는 ICU 데이터와
 *   locale에 따라 순서가 달라지므로 다른 머신에서 다른 해시가 나올 수 있다.
 *
 * # 위협 모델 — **이건 전자서명이 아니다**
 *
 * 이 해시는 **무결성 검사**다. 파일이 손으로 수정됐거나 손상됐거나 다른 실행의 것으로 바뀐 것을
 * 잡는다. 그러나 로컬에서 코드를 실행할 수 있는 악의적 사용자를 막지 못한다 — 그 사용자는
 * 내용을 바꾼 뒤 이 함수로 해시를 다시 계산해 넣으면 된다. 비밀 키가 없으므로 위조를 막을 수단이
 * 없고, 막으려면 서명 키를 사용자가 접근할 수 없는 곳(HSM, 원격 서명 서비스)에 두어야 한다.
 *
 * 그 한계를 알고도 해시를 두는 이유: 이 절차가 막으려는 것은 **공격자가 아니라 사고**다.
 * "plan-pilot을 다시 돌려서 카드가 바뀐 줄 몰랐다", "evidence 파일을 편집기로 열었다가 저장했다",
 * "다른 실행의 attestation을 복사해 왔다" 같은 것들이며, 그건 해시가 정확히 잡는다.
 */

/** SHA-256 전체 자릿수. **잘라 쓰지 않는다** — 승인 아티팩트에서 절약할 이유가 없다. */
export const ARTIFACT_HASH_HEX_LENGTH = 64;

export class CanonicalJsonError extends Error {
  constructor(readonly pointer: string, reason: string) {
    super(`canonical JSON으로 직렬화할 수 없습니다 (${pointer}): ${reason}`);
    this.name = "CanonicalJsonError";
  }
}

/** UTF-16 코드 단위 비교. locale에 의존하지 않는다. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function encode(value: unknown, pointer: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(pointer, `유한한 수가 아닙니다 (${String(value)})`);
      }
      // `JSON.stringify(-0)`은 "0"이다. 부호 있는 0을 그대로 두면 같은 값이 두 표현을 갖는다.
      return JSON.stringify(value === 0 ? 0 : value);
    case "undefined":
      throw new CanonicalJsonError(pointer, "undefined는 허용하지 않습니다 — 필드를 아예 넣지 마세요");
    case "function":
      throw new CanonicalJsonError(pointer, "함수는 허용하지 않습니다");
    case "symbol":
      throw new CanonicalJsonError(pointer, "symbol은 허용하지 않습니다");
    case "bigint":
      throw new CanonicalJsonError(pointer, "bigint는 허용하지 않습니다 — 문자열로 넣으세요");
    default:
      break;
  }

  if (Array.isArray(value)) {
    // **순서를 보존한다.** argv와 fixture 순서는 순서 자체가 의미다.
    return `[${value.map((item, i) => encode(item, `${pointer}[${i}]`)).join(",")}]`;
  }

  // `toJSON`을 가진 객체(Date 등)는 명시적으로 거부한다. 승인 아티팩트에는 이미 ISO 문자열로
  // 들어오며, 여기서 조용히 변환하면 "무엇이 해시에 들어갔는가"가 타입에 따라 달라진다.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    throw new CanonicalJsonError(pointer, "toJSON을 가진 객체는 허용하지 않습니다 — 미리 평범한 값으로 바꾸세요");
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => byCodeUnit(a, b));
  const parts: string[] = [];
  for (const [key, item] of entries) {
    parts.push(`${JSON.stringify(key)}:${encode(item, `${pointer}.${key}`)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * 재귀적으로 정규화된 JSON 문자열.
 *
 * 같은 내용이면 key 순서·플랫폼과 무관하게 **항상 같은 문자열**이 나온다.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

/** canonical JSON의 SHA-256, 64 hex 전체. */
export function artifactHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * **해시 필드 자신만** 제외하고 해시한다.
 *
 * 다른 필드를 제외하지 않는 것이 요점이다 — 예전 `payloadForHash`처럼 대상 필드를 손으로
 * 나열하면, 새 필드를 추가할 때 그 목록에 넣는 것을 잊는 순간 그 필드가 조용히 해시 밖으로
 * 빠진다. 여기서는 뺄 것이 하나뿐이므로 잊을 것이 없다.
 */
export function hashExcludingField<T extends object>(value: T, hashField: keyof T & string): string {
  const rest: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === hashField) continue;
    rest[key] = item;
  }
  return artifactHash(rest);
}

/**
 * 저장된 해시와 재계산한 해시를 비교한다.
 *
 * 해시 형식까지 본다 — 32자리로 잘라 쓰던 시절의 아티팩트가 우연히 통과하지 않게 한다.
 */
export function verifyArtifactHash<T extends object>(
  value: T,
  hashField: keyof T & string
): { ok: true; hash: string } | { ok: false; reason: string } {
  const stored = value[hashField];
  if (typeof stored !== "string" || !new RegExp(`^[0-9a-f]{${ARTIFACT_HASH_HEX_LENGTH}}$`).test(stored)) {
    return {
      ok: false,
      reason:
        `해시(${hashField})가 ${ARTIFACT_HASH_HEX_LENGTH}자리 hex가 아닙니다 (${String(stored)}) — ` +
        `이전 형식의 아티팩트일 수 있습니다. 다시 만드세요.`,
    };
  }
  let recomputed: string;
  try {
    recomputed = hashExcludingField(value, hashField);
  } catch (error) {
    return { ok: false, reason: error instanceof CanonicalJsonError ? error.message : String(error) };
  }
  if (recomputed !== stored) {
    return {
      ok: false,
      reason:
        `해시(${hashField})가 다릅니다 (저장 ${stored} / 재계산 ${recomputed}) — ` +
        `파일이 수정되었거나 손상되었습니다`,
    };
  }
  return { ok: true, hash: recomputed };
}
