/**
 * 관리형 모델 카탈로그 클라이언트 — product-strategy.md 17.6-②.
 *
 * 서버(웹 저장소의 `GET /api/code/model-catalog`)가 주는 **불변 스냅샷**
 * `{version, contentHash, coverageUntil, models}`을 받아 관리형 모드의 모델 목록으로 쓴다.
 * 하드코딩된 목록이 아니라 이 스냅샷이 관리형 경로의 유일한 목록이다.
 *
 * # 판정 규칙 (fail-closed)
 *
 * - 정상: 새 스냅샷을 받아 저장하고 쓴다.
 * - `unchanged`: 알고 있는 version이 아직 최신이다. 저장된 스냅샷을 그대로 쓴다.
 * - 오프라인(네트워크 오류·타임아웃·429·5xx): `coverageUntil` **안의** 마지막 스냅샷만 쓴다.
 *   지났으면 그 기간 가격을 증명할 수 없으므로 쓰지 않는다.
 * - 서버가 명시적으로 거절(404 미게시 / 503 `catalog_stale` / 401·403): 저장된 스냅샷이
 *   coverage 안이어도 **쓰지 않는다.** 서버가 "없다/낡았다"고 말한 것을 캐시로 덮지 않는다.
 * - 불량 응답(형식 오류, version 후퇴, 같은 version의 다른 hash, 이미 지난 coverage)은
 *   거절한다. 조용히 옛 목록으로 돌아가지 않는다.
 *
 * # 목록은 허가가 아니다
 *
 * 여기서 모델이 나온다는 사실은 표시 근거일 뿐이다. 서버가 호출마다 권한을 다시 판정하고,
 * "목록에는 있었는데 서버가 거절했다"는 호출부가 별도 실패로 다룬다(17.6-②).
 * 약관 근거가 비었거나 코딩 에이전트 용도를 허용하지 않는 행은 받자마자 버린다(17.6-③):
 * 비어 있는 칸을 "허용"으로 읽지 않는다.
 *
 * # 파일을 만지지 않는다
 *
 * sidecar는 파일 시스템에 접근하지 않는다(boundary.test.ts). 디스크 저장은 호출자가 주입하는
 * `ManagedCatalogStore`의 몫이고, 네트워크·시계·인증 헤더도 모두 주입이라 순수하게 시험된다.
 * 인증 값은 이 모듈이 저장하거나 기록하지 않는다.
 */

export type ManagedPlan = "Free" | "Pro" | "Max";

export interface ManagedCatalogRow {
  modelId: string;
  name: string;
  provider: string;
  apiModelId: string;
  minimumPlan: ManagedPlan;
  capabilities: {
    toolCalling: "none" | "basic" | "parallel";
    structuredOutput: string;
    imageInput: boolean;
    maxContextTokens: number;
    maxOutputTokens: number;
  };
  pricing: {
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    creditWeight: number;
    verifiedAt: string;
    sources: string[];
  };
  terms: { allowsResaleAndCodingAgent: true; url: string; checkedAt: string };
  retention: { url: string; checkedAt: string };
  processingRegion: string;
}

export interface ManagedCatalogSnapshot {
  /** 단조 증가. 관리형 호출의 사용량 이벤트에 `contentHash`와 함께 남긴다(17.6-②). */
  version: number;
  contentHash: string;
  /** ISO 시각. 이 시각이 지나면 스냅샷은 가격을 증명하지 못한다. */
  coverageUntil: string;
  models: ManagedCatalogRow[];
}

export interface ManagedCatalogStore {
  load(): Promise<unknown>;
  save(snapshot: ManagedCatalogSnapshot): Promise<void>;
}

export type ManagedCatalogUnavailableReason =
  | "not_published" // 404
  | "stale" // 503 catalog_stale, 또는 받은 스냅샷의 coverage가 이미 지났다
  | "unauthorized" // 401·403
  | "offline" // 연결 불가이고 coverage 안의 저장본도 없다
  | "invalid_response"
  | "no_usable_models";

export type ManagedCatalogResult =
  | {
      status: "ready";
      source: "network" | "unchanged" | "offline-cache";
      snapshot: ManagedCatalogSnapshot;
      /** 약관 근거가 없어 버린 행의 modelId. 비어 있지 않으면 화면이 말해야 한다. */
      rejectedModelIds: string[];
    }
  | { status: "unavailable"; reason: ManagedCatalogUnavailableReason; detail?: string };

export interface LoadManagedCatalogOptions {
  /** 예: `https://<서버 origin>`. 끝의 슬래시는 무시한다. */
  baseUrl: string;
  store: ManagedCatalogStore;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 사용자 세션 인증 헤더. 저장·기록하지 않는다. */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  timeoutMs?: number;
}

const CATALOG_PATH = "/api/code/model-catalog";
const DEFAULT_TIMEOUT_MS = 10_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isPosNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonNegNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 행 하나의 모양. 약관 근거 판정(17.6-③)은 모양과 별개라 `hasTermsBasis`에서 한다. */
function parseRow(raw: unknown): ManagedCatalogRow | null {
  if (!isRecord(raw)) return null;
  const { capabilities: c, pricing: p, terms: t, retention: r } = raw;
  if (!isStr(raw.modelId) || !isStr(raw.name) || !isStr(raw.provider) || !isStr(raw.apiModelId)) return null;
  if (raw.minimumPlan !== "Free" && raw.minimumPlan !== "Pro" && raw.minimumPlan !== "Max") return null;
  if (!isStr(raw.processingRegion)) return null;
  if (!isRecord(c) || !isPosNum(c.maxContextTokens) || !isPosNum(c.maxOutputTokens)) return null;
  if (c.toolCalling !== "none" && c.toolCalling !== "basic" && c.toolCalling !== "parallel") return null;
  if (!isStr(c.structuredOutput) || typeof c.imageInput !== "boolean") return null;
  if (!isRecord(p) || !isNonNegNum(p.inputUsdPerMTok) || !isNonNegNum(p.outputUsdPerMTok) || !isPosNum(p.creditWeight))
    return null;
  if (!isStr(p.verifiedAt) || !Array.isArray(p.sources) || !p.sources.every(isStr)) return null;
  if (!isRecord(r) || !isStr(r.url) || !isStr(r.checkedAt)) return null;
  // 약관 근거 칸은 있어야 하고, 허용이 명시(true)돼야 쓴다 — 빈 칸은 허용이 아니다.
  if (!isRecord(t) || t.allowsResaleAndCodingAgent !== true || !isStr(t.url) || !isStr(t.checkedAt)) return null;
  return raw as unknown as ManagedCatalogRow;
}

/**
 * 스냅샷 전체를 받아들인다. 행 하나가 불량이어도 나머지는 살리되 버린 modelId를 돌려준다.
 * 봉투(version·hash·coverage)가 불량이면 null이다.
 */
export function parseManagedSnapshot(
  raw: unknown
): { snapshot: ManagedCatalogSnapshot; rejectedModelIds: string[] } | null {
  if (!isRecord(raw)) return null;
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) return null;
  if (!isStr(raw.contentHash) || !isStr(raw.coverageUntil) || Number.isNaN(Date.parse(raw.coverageUntil))) return null;
  if (!Array.isArray(raw.models)) return null;
  const models: ManagedCatalogRow[] = [];
  const rejectedModelIds: string[] = [];
  for (const entry of raw.models) {
    const row = parseRow(entry);
    if (row) models.push(row);
    else rejectedModelIds.push(isRecord(entry) && isStr(entry.modelId) ? entry.modelId : "(unknown)");
  }
  return {
    snapshot: {
      version: raw.version as number,
      contentHash: raw.contentHash,
      coverageUntil: raw.coverageUntil,
      models,
    },
    rejectedModelIds,
  };
}

/** coverage 안인가. 시각이 같으면 지난 것이다(서버의 `snapshotIsCurrent`와 같은 규칙). */
export const isWithinCoverage = (snapshot: ManagedCatalogSnapshot, now: Date): boolean =>
  Date.parse(snapshot.coverageUntil) > now.getTime();

const ready = (
  source: "network" | "unchanged" | "offline-cache",
  snapshot: ManagedCatalogSnapshot,
  rejectedModelIds: string[]
): ManagedCatalogResult =>
  snapshot.models.length === 0
    ? { status: "unavailable", reason: "no_usable_models" }
    : { status: "ready", source, snapshot, rejectedModelIds };

export async function loadManagedCatalog(options: LoadManagedCatalogOptions): Promise<ManagedCatalogResult> {
  const doFetch = options.fetch ?? fetch;
  const now = (options.now ?? (() => new Date()))();

  let cached: ManagedCatalogSnapshot | null = null;
  let cachedRejected: string[] = [];
  try {
    const parsed = parseManagedSnapshot(await options.store.load());
    if (parsed) {
      cached = parsed.snapshot;
      cachedRejected = parsed.rejectedModelIds;
    }
  } catch {
    cached = null; // 읽지 못한 저장본은 없는 것이다.
  }
  const usableCache = cached && isWithinCoverage(cached, now) ? cached : null;

  const url = new URL(CATALOG_PATH, options.baseUrl.replace(/\/+$/, "") + "/");
  // 지난 저장본의 version은 보내지 않는다 — unchanged가 와도 쓸 수 없기 때문이다.
  if (usableCache) url.searchParams.set("version", String(usableCache.version));

  const offline = (detail: string): ManagedCatalogResult =>
    usableCache
      ? ready("offline-cache", usableCache, cachedRejected)
      : { status: "unavailable", reason: "offline", detail };

  let response: Response;
  try {
    response = await doFetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", ...(await options.headers?.()) },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return offline(error instanceof Error ? error.message : "network error");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const errorCode = isRecord(body) && typeof body.error === "string" ? body.error : undefined;

  if (response.status === 401 || response.status === 403) return { status: "unavailable", reason: "unauthorized" };
  if (response.status === 404) return { status: "unavailable", reason: "not_published", detail: errorCode };
  if (response.status === 503 && errorCode === "catalog_stale") return { status: "unavailable", reason: "stale" };
  if (response.status === 429 || response.status >= 500) return offline(`HTTP ${response.status}`);
  if (!response.ok) return { status: "unavailable", reason: "invalid_response", detail: `HTTP ${response.status}` };

  if (isRecord(body) && body.unchanged === true) {
    if (usableCache && body.version === usableCache.version) return ready("unchanged", usableCache, cachedRejected);
    return { status: "unavailable", reason: "invalid_response", detail: "unchanged without a matching cached version" };
  }

  const parsed = parseManagedSnapshot(body);
  if (!parsed) return { status: "unavailable", reason: "invalid_response", detail: "malformed snapshot" };
  const { snapshot, rejectedModelIds } = parsed;
  if (!isWithinCoverage(snapshot, now)) return { status: "unavailable", reason: "stale", detail: "coverage elapsed" };
  // 스냅샷은 불변·단조 증가다. 후퇴나 같은 version의 다른 내용은 서버 결함이거나 변조다.
  if (cached && snapshot.version < cached.version)
    return { status: "unavailable", reason: "invalid_response", detail: "version went backwards" };
  if (cached && snapshot.version === cached.version && snapshot.contentHash !== cached.contentHash)
    return { status: "unavailable", reason: "invalid_response", detail: "same version, different contentHash" };

  try {
    await options.store.save(snapshot);
  } catch {
    // 저장 실패는 이번 실행을 막지 않는다. 다음 실행이 다시 받는다.
  }
  return ready("network", snapshot, rejectedModelIds);
}
