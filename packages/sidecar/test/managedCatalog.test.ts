import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadManagedCatalog,
  type ManagedCatalogSnapshot,
  type ManagedCatalogStore,
} from "../src/routing/managedCatalog.js";

/**
 * 관리형 카탈로그 클라이언트 — product-strategy.md 17.6-②·③.
 * 네트워크와 디스크는 전부 주입이다. 실제 서버를 부르지 않는다.
 */

const NOW = new Date("2026-10-21T00:00:00Z");
const BASE = "https://catalog.example.test";

const row = (modelId: string, overrides: Record<string, unknown> = {}) => ({
  modelId,
  name: modelId,
  provider: "anthropic",
  apiModelId: `${modelId}-api`,
  minimumPlan: "Pro",
  capabilities: {
    toolCalling: "parallel",
    structuredOutput: "forced_tool_use",
    imageInput: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 32_000,
  },
  pricing: {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    creditWeight: 4,
    verifiedAt: "2026-10-01",
    sources: ["https://example.test/pricing"],
  },
  terms: { allowsResaleAndCodingAgent: true, url: "https://example.test/terms", checkedAt: "2026-10-01" },
  retention: { url: "https://example.test/retention", checkedAt: "2026-10-01" },
  processingRegion: "us",
  ...overrides,
});

const snapshot = (version: number, extra: Record<string, unknown> = {}) => ({
  version,
  contentHash: `hash-${version}`,
  coverageUntil: "2026-11-20T00:00:00Z",
  publishedAt: "2026-10-20T00:00:00Z",
  models: [row("m1"), row("m2")],
  ...extra,
});

function memoryStore(initial: unknown = null) {
  let value: unknown = initial;
  const saves: ManagedCatalogSnapshot[] = [];
  const store: ManagedCatalogStore = {
    load: async () => value,
    save: async (s) => {
      value = s;
      saves.push(s);
    },
  };
  return { store, saves, current: () => value };
}

function mockFetch(handler: (url: URL) => Response | Promise<Response> | never) {
  const calls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const load = (store: ManagedCatalogStore, fetchImpl: typeof fetch) =>
  loadManagedCatalog({ baseUrl: BASE, store, fetch: fetchImpl, now: () => NOW });

test("첫 실행: 받은 스냅샷을 저장하고 version을 보내지 않는다", async () => {
  const { store, saves } = memoryStore();
  const { impl, calls } = mockFetch(() => json(200, snapshot(3)));
  const result = await load(store, impl);
  assert.equal(result.status, "ready");
  assert.ok(result.status === "ready");
  assert.equal(result.source, "network");
  assert.equal(result.snapshot.version, 3);
  assert.equal(result.snapshot.models.length, 2);
  assert.equal(saves.length, 1);
  assert.equal(calls[0].pathname, "/api/code/model-catalog");
  assert.equal(calls[0].searchParams.has("version"), false);
});

test("unchanged: 저장본 version을 보내고 저장본을 그대로 쓴다", async () => {
  const { store, saves } = memoryStore(snapshot(3));
  const { impl, calls } = mockFetch(() => json(200, { unchanged: true, version: 3 }));
  const result = await load(store, impl);
  assert.ok(result.status === "ready");
  assert.equal(result.source, "unchanged");
  assert.equal(result.snapshot.version, 3);
  assert.equal(calls[0].searchParams.get("version"), "3");
  assert.equal(saves.length, 0);
});

test("새 version: 저장본을 교체한다", async () => {
  const { store, saves } = memoryStore(snapshot(3));
  const { impl } = mockFetch(() => json(200, snapshot(4)));
  const result = await load(store, impl);
  assert.ok(result.status === "ready");
  assert.equal(result.source, "network");
  assert.equal(result.snapshot.version, 4);
  assert.equal(saves.at(-1)?.version, 4);
});

test("오프라인: coverage 안의 저장본은 쓴다", async () => {
  const { store } = memoryStore(snapshot(3));
  const { impl } = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  const result = await load(store, impl);
  assert.ok(result.status === "ready");
  assert.equal(result.source, "offline-cache");
  assert.equal(result.snapshot.version, 3);
});

test("오프라인: coverage가 지난 저장본은 쓰지 않는다 (fail-closed)", async () => {
  const { store } = memoryStore(snapshot(3, { coverageUntil: "2026-10-20T00:00:00Z" }));
  const { impl, calls } = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  const result = await load(store, impl);
  assert.deepEqual(result.status === "unavailable" && result.reason, "offline");
  // 지난 저장본의 version은 서버에 보내지 않는다.
  assert.equal(calls[0].searchParams.has("version"), false);
});

test("오프라인이고 저장본도 없으면 모델을 고를 수 없다", async () => {
  const { store } = memoryStore();
  const { impl } = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  const result = await load(store, impl);
  assert.equal(result.status === "unavailable" && result.reason, "offline");
});

test("5xx와 429는 오프라인과 같이 다룬다", async () => {
  for (const status of [500, 502, 429]) {
    const { store } = memoryStore(snapshot(3));
    const result = await load(store, mockFetch(() => json(status, { error: "x" })).impl);
    assert.ok(result.status === "ready" && result.source === "offline-cache", `status ${status}`);
  }
});

test("503 catalog_stale: 저장본이 coverage 안이어도 쓰지 않는다", async () => {
  const { store } = memoryStore(snapshot(3));
  const result = await load(store, mockFetch(() => json(503, { error: "catalog_stale", version: 3 })).impl);
  assert.equal(result.status === "unavailable" && result.reason, "stale");
});

test("catalog_stale 표지 없는 503은 일시 장애다", async () => {
  const { store } = memoryStore(snapshot(3));
  const result = await load(store, mockFetch(() => new Response("bad gateway", { status: 503 })).impl);
  assert.ok(result.status === "ready" && result.source === "offline-cache");
});

test("404 catalog_not_published: 저장본이 있어도 쓰지 않는다", async () => {
  const { store } = memoryStore(snapshot(3));
  const result = await load(store, mockFetch(() => json(404, { error: "catalog_not_published" })).impl);
  assert.equal(result.status === "unavailable" && result.reason, "not_published");
});

test("401은 저장본이 있어도 쓰지 않는다", async () => {
  const { store } = memoryStore(snapshot(3));
  const result = await load(store, mockFetch(() => json(401, { error: "Sign in required." })).impl);
  assert.equal(result.status === "unavailable" && result.reason, "unauthorized");
});

test("서버가 이미 지난 coverage를 보내면 거절한다", async () => {
  const { store, saves } = memoryStore();
  const stale = snapshot(5, { coverageUntil: "2026-10-21T00:00:00Z" }); // now와 같은 시각 = 지남
  const result = await load(store, mockFetch(() => json(200, stale)).impl);
  assert.equal(result.status === "unavailable" && result.reason, "stale");
  assert.equal(saves.length, 0);
});

test("version 후퇴와 같은 version의 다른 hash는 거절하고 저장본을 지키지 않고 덮지도 않는다", async () => {
  const back = memoryStore(snapshot(5));
  const r1 = await load(back.store, mockFetch(() => json(200, snapshot(4))).impl);
  assert.equal(r1.status === "unavailable" && r1.reason, "invalid_response");
  assert.equal(back.saves.length, 0);

  const same = memoryStore(snapshot(5));
  const r2 = await load(same.store, mockFetch(() => json(200, snapshot(5, { contentHash: "other" }))).impl);
  assert.equal(r2.status === "unavailable" && r2.reason, "invalid_response");
  assert.equal(same.saves.length, 0);
});

test("약관 근거가 비었거나 불허인 행은 버리고 나머지만 쓴다", async () => {
  const { store } = memoryStore();
  const body = snapshot(2, {
    models: [
      row("ok"),
      row("no-terms-url", { terms: { allowsResaleAndCodingAgent: true, url: "", checkedAt: "2026-10-01" } }),
      row("denied", { terms: { allowsResaleAndCodingAgent: false, url: "https://x.test", checkedAt: "2026-10-01" } }),
      row("no-terms", { terms: undefined }),
    ],
  });
  const result = await load(store, mockFetch(() => json(200, body)).impl);
  assert.ok(result.status === "ready");
  assert.deepEqual(
    result.snapshot.models.map((m) => m.modelId),
    ["ok"]
  );
  assert.deepEqual(result.rejectedModelIds.sort(), ["denied", "no-terms", "no-terms-url"]);
});

test("쓸 수 있는 행이 하나도 없으면 모델을 고를 수 없다", async () => {
  const { store } = memoryStore();
  const body = snapshot(2, { models: [row("x", { terms: undefined })] });
  const result = await load(store, mockFetch(() => json(200, body)).impl);
  assert.equal(result.status === "unavailable" && result.reason, "no_usable_models");
});

test("형식이 깨진 응답과 깨진 저장본은 쓰지 않는다", async () => {
  const bad = memoryStore();
  const r1 = await load(bad.store, mockFetch(() => json(200, { version: "x", models: 1 })).impl);
  assert.equal(r1.status === "unavailable" && r1.reason, "invalid_response");

  // 저장본이 깨졌으면 없는 것으로 보고 서버에서 새로 받는다.
  const corrupt = memoryStore({ version: 1, models: "nope" });
  const r2 = await load(corrupt.store, mockFetch(() => json(200, snapshot(2))).impl);
  assert.ok(r2.status === "ready" && r2.source === "network");
});

test("저장본 없이 unchanged가 오면 거절한다", async () => {
  const { store } = memoryStore();
  const result = await load(store, mockFetch(() => json(200, { unchanged: true, version: 3 })).impl);
  assert.equal(result.status === "unavailable" && result.reason, "invalid_response");
});

test("저장 실패는 이번 실행을 막지 않는다", async () => {
  const store: ManagedCatalogStore = {
    load: async () => null,
    save: async () => {
      throw new Error("disk full");
    },
  };
  const result = await load(store, mockFetch(() => json(200, snapshot(1))).impl);
  assert.ok(result.status === "ready" && result.source === "network");
});

test("인증 헤더는 요청에만 실리고 결과·저장본에 남지 않는다", async () => {
  const { store, current } = memoryStore();
  let seen: Headers | undefined;
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return json(200, snapshot(1));
  }) as typeof fetch;
  const result = await loadManagedCatalog({
    baseUrl: `${BASE}/`,
    store,
    fetch: impl,
    now: () => NOW,
    headers: () => ({ Authorization: "Bearer test-token" }),
  });
  assert.equal(seen?.get("authorization"), "Bearer test-token");
  assert.equal(JSON.stringify(result).includes("test-token"), false);
  assert.equal(JSON.stringify(current()).includes("test-token"), false);
});

const EXPIRES = new Date("2026-10-21T00:00:01Z");
const shortSnapshot = (version: number) => snapshot(version, { coverageUntil: EXPIRES.toISOString() });

test("네트워크 응답을 기다리는 사이 coverage가 지나면 저장하거나 반환하지 않는다", async () => {
  let current = NOW;
  const { store, saves } = memoryStore();
  const { impl } = mockFetch(() => {
    current = EXPIRES;
    return json(200, shortSnapshot(1));
  });
  const result = await loadManagedCatalog({ baseUrl: BASE, store, fetch: impl, now: () => current });
  assert.equal(result.status === "unavailable" && result.reason, "stale");
  assert.equal(saves.length, 0);
});

test("JSON 해석을 기다리는 사이 coverage가 지나도 새 스냅샷을 쓰지 않는다", async () => {
  let current = NOW;
  const { store, saves } = memoryStore();
  const response = json(200, shortSnapshot(1));
  response.json = async () => {
    current = EXPIRES;
    return shortSnapshot(1);
  };
  const result = await loadManagedCatalog({
    baseUrl: BASE, store, fetch: mockFetch(() => response).impl, now: () => current,
  });
  assert.equal(result.status === "unavailable" && result.reason, "stale");
  assert.equal(saves.length, 0);
});

test("저장 성공·실패를 기다리는 사이 coverage가 지나면 ready를 반환하지 않는다", async () => {
  for (const failSave of [false, true]) {
    let current = NOW;
    const store: ManagedCatalogStore = {
      load: async () => null,
      save: async () => {
        current = EXPIRES;
        if (failSave) throw new Error("disk full");
      },
    };
    const result = await loadManagedCatalog({
      baseUrl: BASE, store, fetch: mockFetch(() => json(200, shortSnapshot(1))).impl, now: () => current,
    });
    assert.equal(result.status === "unavailable" && result.reason, "stale", `save failure: ${failSave}`);
  }
});

test("unchanged 응답 대기 중 만료된 저장본을 반환하지 않는다", async () => {
  let current = NOW;
  const { store, saves } = memoryStore(shortSnapshot(3));
  const { impl, calls } = mockFetch(() => {
    current = EXPIRES;
    return json(200, { unchanged: true, version: 3 });
  });
  const result = await loadManagedCatalog({ baseUrl: BASE, store, fetch: impl, now: () => current });
  assert.equal(calls[0].searchParams.get("version"), "3");
  assert.equal(result.status === "unavailable" && result.reason, "stale");
  assert.equal(saves.length, 0);
});

test("오프라인·5xx 응답 대기 중 만료된 저장본은 fallback으로 쓰지 않는다", async () => {
  for (const failure of ["network", "http"] as const) {
    let current = NOW;
    const { store } = memoryStore(shortSnapshot(3));
    const { impl } = mockFetch(() => {
      current = EXPIRES;
      if (failure === "network") throw new TypeError("fetch failed");
      return json(500, { error: "temporary" });
    });
    const result = await loadManagedCatalog({ baseUrl: BASE, store, fetch: impl, now: () => current });
    assert.equal(result.status === "unavailable" && result.reason, "offline", failure);
  }
});

test("저장본 읽기 중 만료되면 version을 보내지 않고 새 스냅샷을 요청한다", async () => {
  let current = NOW;
  const store: ManagedCatalogStore = {
    load: async () => {
      current = EXPIRES;
      return shortSnapshot(3);
    },
    save: async () => {},
  };
  const { impl, calls } = mockFetch(() => json(200, snapshot(4)));
  const result = await loadManagedCatalog({ baseUrl: BASE, store, fetch: impl, now: () => current });
  assert.equal(calls[0].searchParams.has("version"), false);
  assert.ok(result.status === "ready" && result.snapshot.version === 4);
});

test("인증 헤더 준비 중 만료된 저장본은 오프라인 fallback으로 쓰지 않는다", async () => {
  let current = NOW;
  const { store } = memoryStore(shortSnapshot(3));
  const result = await loadManagedCatalog({
    baseUrl: BASE, store, now: () => current,
    headers: async () => {
      current = EXPIRES;
      return { Authorization: "Bearer test-token" };
    },
    fetch: mockFetch(() => { throw new TypeError("fetch failed"); }).impl,
  });
  assert.equal(result.status === "unavailable" && result.reason, "offline");
});

test("걸러낸 모델 경고는 저장 뒤 unchanged·오프라인에서도 보존한다", async () => {
  for (const source of ["unchanged", "offline"] as const) {
    const { store, current } = memoryStore();
    const first = await load(store, mockFetch(() => json(200, snapshot(2, {
      models: [row("ok"), row("denied", { terms: undefined })],
    }))).impl);
    assert.ok(first.status === "ready");
    assert.deepEqual(first.rejectedModelIds, ["denied"]);
    const second = await load(store, mockFetch(() => {
      if (source === "offline") throw new TypeError("fetch failed");
      return json(200, { unchanged: true, version: 2 });
    }).impl);
    assert.ok(second.status === "ready");
    assert.deepEqual(second.rejectedModelIds, ["denied"], source);
    assert.deepEqual((current() as { rejectedModelIds: string[] }).rejectedModelIds, ["denied"]);
    assert.equal("rejectedModelIds" in second.snapshot, false);
  }
});
