import test from "node:test";
import assert from "node:assert/strict";
import {
  ContextEngine,
  escapeRegExp,
  extractKeywords,
  extractMentions,
  hasUncommittedChanges,
  listingCoverageNote,
  parseBranch,
  parseNpmScripts,
} from "../src/context/engine.js";
import { classifyFile, MAX_INDEXED_FILE_BYTES } from "../src/context/exclude.js";
import {
  estimateTokensUpperBound,
  packageFiles,
  truncateToTokens,
  windowAroundLines,
} from "../src/context/budget.js";
import { FAKE_MAX_LIST_ENTRIES, FAKE_MAX_SEARCH_MATCHES, FakeHost } from "./helpers/fakeHost.js";
import { ToolBridge } from "../src/tools/bridge.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NdjsonTransport } from "../src/ipc/transport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { makeRelevantFile, makeSnapshot } from "./helpers/fixtures.js";
import { renderSnapshot } from "../src/providers/prompts.js";

// ---- 제외 규칙 (secret / binary / 대용량) ----

test("secret 파일은 컨텍스트에 들어가지 않는다", () => {
  const secrets = [
    ".env",
    ".env.local",
    ".env.production",
    "config/.env",
    "certs/server.pem",
    "keys/private.key",
    "id_rsa",
    "deploy/id_ed25519",
    "credentials.json",
    "gcp-service-account-prod.json",
    "secrets.yaml",
    ".npmrc",
    ".ssh/config",
  ];
  for (const path of secrets) {
    const verdict = classifyFile(path, 100);
    assert.equal(verdict.excluded, true, `${path}는 제외되어야 합니다`);
    assert.ok(verdict.reason);
  }
});

test("일반 소스 파일은 제외되지 않는다", () => {
  for (const path of ["src/app.ts", "lib/env.ts", "src/keyboard.tsx", "docs/environment.md"]) {
    assert.equal(classifyFile(path, 100).excluded, false, `${path}는 포함되어야 합니다`);
  }
});

test("빌드 산출물과 node_modules는 제외한다", () => {
  for (const path of ["node_modules/react/index.js", "dist/bundle.js", "target/debug/app", "__pycache__/x.pyc", ".git/config"]) {
    assert.equal(classifyFile(path, 100).excluded, true, `${path}는 제외되어야 합니다`);
  }
});

test("바이너리 확장자는 제외한다", () => {
  for (const path of ["assets/logo.png", "vendor.zip", "app.exe", "font.woff2"]) {
    assert.equal(classifyFile(path, 100).excluded, true);
  }
});

test("대용량 파일은 명시 지목되어도 제외하고 사유를 남긴다", () => {
  const verdict = classifyFile("src/generated.ts", MAX_INDEXED_FILE_BYTES + 1);
  assert.equal(verdict.excluded, true);
  assert.ok(verdict.reason!.includes("너무 큼"));
});

// ---- 토큰 예산 ----

test("예산 안에서는 파일을 그대로 넣는다", () => {
  const files = [makeRelevantFile({ path: "a.ts", content: "x".repeat(100) })];
  const result = packageFiles(files, 10_000);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.truncated, false);
  assert.equal(result.dropped.length, 0);
});

test("예산을 넘으면 파일을 자르고 잘렸음을 표시한다", () => {
  const files = [makeRelevantFile({ path: "big.ts", content: "x".repeat(100_000) })];
  const result = packageFiles(files, 1_000);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.truncated, true);
  assert.ok(result.files[0]!.content.length < 100_000);
  // 잘렸다는 사실이 선정 사유에도 기록되어야 한다.
  assert.ok(result.files[0]!.reasonDetail.includes("토큰 예산"));
});

test("예산이 소진되면 뒤쪽 파일을 사유와 함께 버린다", () => {
  const files = [
    makeRelevantFile({ path: "first.ts", content: "x".repeat(20_000) }),
    makeRelevantFile({ path: "second.ts", content: "y".repeat(20_000) }),
    makeRelevantFile({ path: "third.ts", content: "z".repeat(20_000) }),
  ];
  const result = packageFiles(files, 3_000);
  // 우선순위 순서대로 채우고, 남지 않으면 조용히 빠지는 대신 사유를 남긴다.
  assert.ok(result.dropped.length > 0);
  assert.ok(result.dropped[0]!.reason.includes("예산"));
});

/**
 * **한글은 영문보다 토큰을 훨씬 많이 먹는다.** 종전 근사는 둘을 같게 봤고, 그래서 한국어
 * 텍스트를 3~7배 과소 추정했다 — 이 제품 사용자의 기본 경로에 있는 오차였다.
 */
test("같은 문자 수라도 한글이 영문보다 크게 추정된다", () => {
  const ascii = estimateTokensUpperBound("x".repeat(300));
  const hangul = estimateTokensUpperBound("가".repeat(300));
  assert.ok(hangul > ascii * 2, `한글 ${hangul} vs 영문 ${ascii}`);
  assert.equal(ascii, 100);
  assert.equal(hangul, 300);
});

/** 서로게이트 쌍을 2문자로 세면 이모지가 든 텍스트의 추정이 실제와 어긋난다. */
test("코드 포인트 단위로 센다", () => {
  // 이모지 하나는 UTF-16에서 2단위지만 문자 하나다.
  assert.equal(estimateTokensUpperBound("😀"), 1);
});

/**
 * **자른 결과가 허용치를 넘지 않아야 한다.** 종전에는 `허용 토큰 × 문자당 토큰`으로 문자 수를
 * 역산했는데, 계수가 문자 종류마다 다른 지금 그 역산은 한글 구간에서 허용치의 3배를 남긴다.
 */
test("토큰 기준 자르기는 허용치를 넘지 않는다", () => {
  const mixed = ("가나다라마" + "abcdefghij").repeat(50);
  for (const limit of [1, 7, 50, 137]) {
    const cut = truncateToTokens(mixed, limit);
    assert.ok(
      estimateTokensUpperBound(cut) <= limit,
      `limit ${limit}: 잘린 뒤 ${estimateTokensUpperBound(cut)} 토큰`
    );
  }
  // 그리고 **가능한 만큼은 넣는다** — 0을 돌려주고 "넘지 않았다"고 하면 안 된다.
  assert.ok(truncateToTokens(mixed, 137).length > 0);
});

/** 서로게이트 쌍이 반으로 쪼개지면 잘린 자리에 깨진 문자가 남는다. */
test("자를 때 서로게이트 쌍을 쪼개지 않는다", () => {
  const text = "😀".repeat(10);
  for (let limit = 0; limit <= 10; limit += 1) {
    const cut = truncateToTokens(text, limit);
    assert.ok(!/[\uD800-\uDBFF]$/.test(cut), `limit ${limit}에서 상위 서로게이트로 끝났습니다`);
  }
});

// ---- git 출력 파싱 ----

test("porcelain 출력에서 브랜치를 뽑는다", () => {
  assert.equal(parseBranch("## main...origin/main\n M src/a.ts"), "main");
  assert.equal(parseBranch("## feature/x [ahead 2]"), "feature/x");
  assert.equal(parseBranch(""), "(unknown)");
});

test("미커밋 변경 유무를 판정한다", () => {
  assert.equal(hasUncommittedChanges("## main"), false);
  assert.equal(hasUncommittedChanges("## main\n M src/a.ts"), true);
});

test("깨진 package.json에서 스크립트를 지어내지 않는다", () => {
  assert.equal(parseNpmScripts("{ not json").size, 0);
  assert.equal(parseNpmScripts(null).size, 0);
  assert.deepEqual([...parseNpmScripts('{"scripts":{"test":"jest"}}')], ["test"]);
});

// ---- 언급/키워드 추출 ----

test("메시지에서 파일 경로를 뽑는다", () => {
  const mentions = extractMentions("src/auth/login.ts 의 버그를 고쳐줘. app.tsx도 봐.");
  assert.ok(mentions.includes("src/auth/login.ts"));
  assert.ok(mentions.includes("app.tsx"));
});

test("키워드 추출은 흔한 단어를 걸러낸다", () => {
  const keywords = extractKeywords("please fix the bug in calculateTotalPrice with the test");
  assert.ok(keywords.includes("calculateTotalPrice"));
  assert.ok(!keywords.includes("the"));
  assert.ok(!keywords.includes("bug"));
});

// ---- 스냅샷 생성 (ToolBridge 경유) ----

test("스냅샷은 secret 파일을 relevantFiles에 넣지 않는다", async () => {
  const host = new FakeHost({
    files: [
      { path: "src/app.ts", isDir: false, sizeBytes: 50 },
      { path: ".env", isDir: false, sizeBytes: 30 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: {
      "src/app.ts": "export const a = 1;\n",
      ".env": "OPENAI_API_KEY=sk-super-secret\n",
      "package.json": '{"scripts":{"test":"node --test"}}',
    },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "app.ts 의 .env 설정을 읽는 코드 고쳐줘",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const paths = snapshot.relevantFiles.map((f) => f.path);
  assert.ok(paths.includes("src/app.ts"));
  // 사용자가 .env를 직접 언급했지만 하드 필터가 이긴다.
  assert.ok(!paths.includes(".env"), `secret이 컨텍스트에 들어갔습니다: ${paths.join(", ")}`);

  // 그리고 어떤 파일 본문에도 키가 없어야 한다.
  const allContent = snapshot.relevantFiles.map((f) => f.content).join("\n");
  assert.ok(!allContent.includes("sk-super-secret"));

  // 제외됐다는 사실은 사용자에게 알린다 — 조용히 빠지면 왜 모델이 못 봤는지 알 수 없다.
  assert.ok(snapshot.excludedNotes?.some((n) => n.path === ".env"));
});

/**
 * 17.9.1절 — 기준 판정의 "이 파일이 실재하는가"가 스냅샷을 보고 있었다. 스냅샷은 토큰 예산이
 * 고른 부분집합이므로 그 질문에 답할 수 없다. 인덱스가 답한다.
 */
test("knownFilePaths는 스냅샷이 아니라 인덱스를 보고, 제외 목록도 존재의 증거로 센다", async () => {
  const host = new FakeHost({
    files: [
      { path: "src/app.ts", isDir: false, sizeBytes: 50 },
      { path: "test/far-away.test.ts", isDir: false, sizeBytes: 50 },
      { path: ".env", isDir: false, sizeBytes: 30 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: {
      "src/app.ts": "export const a = 1;\n",
      "test/far-away.test.ts": "test('x', () => {});\n",
      ".env": "OPENAI_API_KEY=sk-super-secret\n",
      "package.json": '{"scripts":{"test":"node --test"}}',
    },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();

  // 인덱스가 만들어지기 전에는 **빈 배열**이다. 그건 "워크스페이스가 비었다"가 아니라
  // "아직 모른다"이며, 읽는 쪽이 그걸 "없다"로 말하지 않는 것이 사용 조건이다.
  assert.deepEqual(engine.knownFilePaths(), []);

  const snapshot = await engine.createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "app.ts 를 고쳐줘",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const known = engine.knownFilePaths();
  assert.ok(known.includes("src/app.ts"));
  // 요청과 무관해서 스냅샷에 안 실린 테스트도 **실재한다.** 여기가 종전에 틀리던 자리다.
  assert.ok(known.includes("test/far-away.test.ts"), known.join(", "));
  // 하드 필터로 제외된 secret도 존재 자체는 확인됐다 — 제외는 "없다"가 아니라 "있는데 뺐다"다.
  assert.ok(known.includes(".env"), known.join(", "));

  // 그리고 이 비교가 공허하지 않다는 것: 스냅샷은 실제로 그 테스트를 싣지 않았다.
  const inSnapshot = snapshot.relevantFiles.map((f) => f.path);
  assert.ok(!inSnapshot.includes("test/far-away.test.ts"), inSnapshot.join(", "));
});

test("스냅샷은 프로젝트 규칙 파일을 항상 포함한다", async () => {
  const host = new FakeHost({
    files: [
      { path: "CLAUDE.md", isDir: false, sizeBytes: 20 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
      { path: "src/app.ts", isDir: false, sizeBytes: 50 },
    ],
    contents: {
      "CLAUDE.md": "# 규칙\n한국어로 응답할 것.",
      "package.json": '{"scripts":{"test":"node --test","build":"tsc"}}',
      "src/app.ts": "export const a = 1;\n",
    },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "아무 관련 없는 요청",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  assert.equal(snapshot.projectMeta.agentsMdPresent, true);
  assert.ok(snapshot.projectMeta.agentsMdContent!.includes("한국어로 응답할 것"));
  assert.deepEqual(snapshot.projectMeta.agentsMdSources, ["CLAUDE.md"]);
});

test("스냅샷은 프로젝트에 실제로 있는 검증 명령만 argv로 감지한다", async () => {
  const host = new FakeHost({
    files: [{ path: "package.json", isDir: false, sizeBytes: 40 }],
    contents: { "package.json": '{"scripts":{"test":"node --test","build":"tsc"}}' },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "테스트 고쳐줘",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  // 셸 문자열이 아니라 argv여야 한다 — 문자열을 쓰면 어딘가에서 셸 파싱이 되살아난다.
  assert.deepEqual(snapshot.projectMeta.testCommand, {
    program: "npm",
    args: ["test"],
    cwd: ".",
    source: "package.json scripts.test",
  });
  assert.deepEqual(snapshot.projectMeta.buildCommand?.args, ["run", "build"]);
  // lint 스크립트가 없으므로 명령을 만들어내지 않는다.
  assert.equal(snapshot.projectMeta.lintCommand, undefined);
});

test("파일별 선정 이유를 기록한다", async () => {
  const host = new FakeHost({
    files: [
      { path: "src/login.ts", isDir: false, sizeBytes: 50 },
      { path: "src/unrelated.ts", isDir: false, sizeBytes: 50 },
    ],
    contents: { "src/login.ts": "// login", "src/unrelated.ts": "// other" },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "src/login.ts 를 고쳐줘",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const login = snapshot.relevantFiles.find((f) => f.path === "src/login.ts")!;
  assert.equal(login.reason, "mentioned");
  assert.ok(login.reasonDetail.includes("직접 지목"), login.reasonDetail);
});

test("같은 워크스페이스/HEAD에서는 인덱스를 재사용한다", async () => {
  const host = new FakeHost({
    files: [{ path: "src/app.ts", isDir: false, sizeBytes: 50 }],
    contents: { "src/app.ts": "// x" },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();

  await engine.ensureIndex(bridge, "ws-1");
  const listCallsAfterFirst = host.toolRequests.filter((r) => r.tool === "list_files").length;
  await engine.ensureIndex(bridge, "ws-1");
  const listCallsAfterSecond = host.toolRequests.filter((r) => r.tool === "list_files").length;

  // 3절 전략 C: 첫 태스크만 느리고 이후는 재사용한다.
  assert.equal(listCallsAfterSecond, listCallsAfterFirst);
});

// ---- 인덱스 캐시 (context-engine.md 2절, process-architecture.md 11.4절) ----

function indexHost(): FakeHost {
  return new FakeHost({
    files: [{ path: "src/app.ts", isDir: false, sizeBytes: 50 }],
    contents: { "src/app.ts": "// x" },
  });
}

function listCalls(host: FakeHost): number {
  return host.toolRequests.filter((r) => r.tool === "list_files").length;
}

/**
 * **캐시는 프로세스보다 오래 살아야 한다.** 워크스페이스를 전환하면 sidecar가 종료되므로
 * (11.3절 — 살려두지 않는 이유는 자격증명이다) 프로세스 안 캐시로는 전환이 싸지지 않는다.
 * 새 엔진이 저장된 인덱스를 그대로 집어야 한다.
 */
test("새 엔진이 저장된 인덱스를 재사용한다 — 전환 후에도 파일 목록을 다시 훑지 않는다", async () => {
  const host = indexHost();
  const bridge = new ToolBridge(host.asTransport(), "task-1");

  await new ContextEngine().ensureIndex(bridge, "ws-1");
  const afterFirst = listCalls(host);
  assert.equal(host.indexSaves.length, 1, "인덱스를 저장하지 않았습니다");

  // sidecar가 죽고 새로 뜬 상황 = 새 ContextEngine 인스턴스.
  const index = await new ContextEngine().ensureIndex(bridge, "ws-1");
  assert.equal(listCalls(host), afterFirst, "저장된 인덱스를 두고 다시 훑었습니다");
  assert.equal(index.fileTree[0]?.path, "src/app.ts");
});

/**
 * 워크스페이스가 바뀌면 **다시 만든다.** 이 판정을 지문에 맡기는 이유는 인덱스가 파일 집합이기
 * 때문이다 — 낡은 파일 목록으로 모델을 부르면 조용히 틀린 답이 나온다.
 */
test("지문이 바뀌면 인덱스를 다시 만든다", async () => {
  const host = indexHost();
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();

  await engine.ensureIndex(bridge, "ws-1");
  const afterFirst = listCalls(host);

  host.setIndexFingerprint("sha256:changed");
  await engine.ensureIndex(bridge, "ws-1");
  assert.ok(listCalls(host) > afterFirst, "워크스페이스가 바뀌었는데 캐시를 그대로 썼습니다");
  // 새 상태의 인덱스도 저장된다 — 저장하지 않으면 전환 후 매번 다시 만든다.
  assert.equal(host.indexSaves.length, 2);
  assert.equal(host.indexSaves[1]?.fingerprint, "sha256:changed");
});

/**
 * **지문을 낼 수 없으면 캐시를 쓰지 않는다.** git 저장소가 아닌 워크스페이스가 그렇다 —
 * 같은 상태인지 판정할 방법이 없는데 재사용하면 "모른다"를 "같다"로 읽는 것이다.
 * 그리고 저장도 하지 않는다: 어떤 상태의 인덱스인지 말할 수 없는 것을 저장하면 다음에
 * 무엇과 비교해야 할지 알 수 없다.
 */
test("지문이 없는 워크스페이스에서는 캐시를 쓰지도 저장하지도 않는다", async () => {
  const host = new FakeHost({
    files: [{ path: "src/app.ts", isDir: false, sizeBytes: 50 }],
    contents: { "src/app.ts": "// x" },
    indexFingerprint: null,
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();

  await engine.ensureIndex(bridge, "ws-1");
  const afterFirst = listCalls(host);
  await engine.ensureIndex(bridge, "ws-1");

  assert.ok(listCalls(host) > afterFirst, "판정할 수 없는데 재사용했습니다");
  assert.equal(host.indexSaves.length, 0, "지문 없이 저장했습니다");
});

/**
 * 캐시 RPC가 실패해도 **태스크는 진행된다.** 캐시는 잃어도 되는 데이터이고, 못 썼다고
 * 작업을 세우는 것은 꼬리가 몸통을 흔드는 것이다.
 */
test("캐시를 읽지 못해도 인덱스를 만든다", async () => {
  const host = indexHost();
  const inner = host.asTransport();
  const broken = {
    request: (method: string, params: unknown) => {
      if (method.startsWith("index.")) return Promise.reject(new Error("캐시 계층 고장"));
      return inner.request(method, params);
    },
  } as unknown as typeof inner;

  const bridge = new ToolBridge(broken, "task-1");
  const index = await new ContextEngine().ensureIndex(bridge, "ws-1");
  assert.equal(index.fileTree.length, 1, "캐시 고장이 인덱스 구축을 막았습니다");
});

/**
 * 저장된 값의 **모양이 다르면 없는 것으로 다룬다.** 앱을 업데이트해 인덱스 모양이 바뀌면
 * 옛 행이 그대로 남아 있고, 그걸 그대로 쓰면 조용히 빈 목록이 되거나 엉뚱한 곳에서 터진다.
 */
test("모양이 깨진 캐시는 무시하고 다시 만든다", async () => {
  const host = indexHost();
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  // Rust가 지문은 맞다고 주지만 payload가 옛 모양인 상황.
  await bridge.saveCachedIndex("sha256:fake", { workspaceId: "ws-1", notAnIndex: true }, 1);

  const index = await new ContextEngine().ensureIndex(bridge, "ws-1");
  assert.equal(index.fileTree[0]?.path, "src/app.ts", "깨진 캐시를 그대로 썼습니다");
});

test("M0 인덱스는 심볼 그래프를 비워두고 그 사실을 감추지 않는다", async () => {
  const host = new FakeHost({ files: [{ path: "src/app.ts", isDir: false, sizeBytes: 50 }], contents: { "src/app.ts": "// x" } });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const index = await new ContextEngine().ensureIndex(bridge, "ws-1");
  assert.deepEqual(index.symbols, []);
  assert.deepEqual(index.dependencyEdges, []);
});

// ---- 변경 이후 스냅샷 다시 읽기 (6.1절) ----
//
// 여기서 검증하는 결함은 **화면에 아무 증상도 내지 않았다**: FIX_LOOP는 정상적으로 돌고
// 라운드도 세어졌으며, 다만 모델이 패치 **이전**의 파일을 보면서 "당신의 변경이 이미
// 반영되어 있다"는 말을 듣고 있었다.

function snapshotWith(files: Parameters<typeof makeRelevantFile>[0][]): ReturnType<typeof makeSnapshot> {
  return makeSnapshot({ relevantFiles: files.map((f) => makeRelevantFile(f)) });
}

test("변경 이후 다시 읽으면 파일 내용이 지금의 것으로 바뀐다", async () => {
  const host = new FakeHost({ contents: { "src/app.ts": "export const a = 2;\n" } });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const before = snapshotWith([{ path: "src/app.ts", content: "export const a = 1;\n" }]);

  const refreshed = await new ContextEngine().refreshSnapshot(bridge, before, ["src/app.ts"]);

  assert.equal(refreshed.snapshot.relevantFiles[0]!.content, "export const a = 2;\n");
  assert.deepEqual(refreshed.changed, ["src/app.ts"]);
  // 새 스냅샷은 새 id를 갖는다 — 전송 기록이 마지막 SNAPSHOT_CREATED를 읽으므로
  // id를 물려주면 "지금 무엇이 나가 있는가"에 옛 답이 남는다.
  assert.notEqual(refreshed.snapshot.snapshotId, before.snapshotId);
});

test("내용이 그대로면 바뀐 파일로 세지 않는다", async () => {
  const host = new FakeHost({ contents: { "src/app.ts": "export const a = 1;\n" } });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const before = snapshotWith([{ path: "src/app.ts", content: "export const a = 1;\n" }]);

  const refreshed = await new ContextEngine().refreshSnapshot(bridge, before, []);
  assert.deepEqual(refreshed.changed, []);
});

test("변경이 건드린 파일이 앞으로 오고 프로젝트 규칙 파일은 자리를 지킨다", async () => {
  const host = new FakeHost({
    contents: { "README.md": "# p\n", "src/other.ts": "b\n", "src/target.ts": "c\n" },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const before = snapshotWith([
    { path: "README.md", reason: "project-meta", content: "# p\n" },
    { path: "src/other.ts", content: "b\n" },
    { path: "src/target.ts", content: "c\n" },
  ]);

  const refreshed = await new ContextEngine().refreshSnapshot(bridge, before, ["src/target.ts"]);

  // 예산이 모자라면 뒤에서부터 잘린다 — FIX_LOOP에서 답이 있는 파일이 잘리면 그 라운드는
  // 처음부터 가망이 없다.
  assert.deepEqual(
    refreshed.snapshot.relevantFiles.map((f) => f.path),
    ["README.md", "src/target.ts", "src/other.ts"]
  );
});

test("변경이 만든 파일은 스냅샷에 새로 들어온다", async () => {
  const host = new FakeHost({ contents: { "src/app.ts": "a\n", "src/new.ts": "새 파일\n" } });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const before = snapshotWith([{ path: "src/app.ts", content: "a\n" }]);

  const refreshed = await new ContextEngine().refreshSnapshot(bridge, before, ["src/new.ts"]);

  assert.deepEqual(refreshed.added, ["src/new.ts"]);
  assert.ok(refreshed.snapshot.relevantFiles.some((f) => f.path === "src/new.ts" && f.content === "새 파일\n"));
});

test("변경이 건드렸다는 이유로 secret 파일이 컨텍스트에 들어오지는 않는다", async () => {
  // 새 진입 지점을 내면서 7절의 자물쇠를 빼놓지 않는다.
  const host = new FakeHost({ contents: { "src/app.ts": "a\n", ".env": "OPENAI_API_KEY=sk-real\n" } });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const before = snapshotWith([{ path: "src/app.ts", content: "a\n" }]);

  const refreshed = await new ContextEngine().refreshSnapshot(bridge, before, [".env"]);

  assert.deepEqual(refreshed.added, []);
  assert.ok(!refreshed.snapshot.relevantFiles.some((f) => f.path === ".env"));
  assert.ok(!JSON.stringify(refreshed.snapshot.relevantFiles).includes("sk-real"));
  assert.ok(refreshed.snapshot.excludedNotes?.some((n) => n.path === ".env"));
});

test("변경이 지운 파일은 빠지고, 건드린 적 없는데 못 읽는 파일은 옛 내용을 지킨다", async () => {
  // "사라졌다"와 "모른다"는 다른 사실이다. 후자까지 빼면 읽기 경로가 잠깐 깨졌을 때
  // 모델이 빈 컨텍스트를 받는다.
  const host = new FakeHost({ contents: {} });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const before = snapshotWith([
    { path: "src/deleted.ts", content: "지워질 것\n" },
    { path: "src/untouched.ts", content: "그대로일 것\n" },
  ]);

  const refreshed = await new ContextEngine().refreshSnapshot(bridge, before, ["src/deleted.ts"]);

  assert.deepEqual(refreshed.removed, ["src/deleted.ts"]);
  assert.deepEqual(refreshed.unreadable, ["src/untouched.ts"]);
  assert.deepEqual(
    refreshed.snapshot.relevantFiles.map((f) => f.path),
    ["src/untouched.ts"]
  );
  assert.equal(refreshed.snapshot.relevantFiles[0]!.content, "그대로일 것\n");
});

/**
 * **선정이 파일 내용을 본다** — state-machine 51절.
 *
 * 종전에는 파일 **이름**만 봤다. 그래서 `resolveBudget`을 고쳐 달라는 요청에서 그 함수가
 * `ledger.ts`에 있으면 그 파일은 영원히 선정되지 않았고, 모델은 엉뚱한 컨텍스트로 초안을
 * 썼다 — 그 실패는 "모델이 잘못했다"로 보인다.
 *
 * `search_text` 도구는 처음부터 있었고 Rust가 구현하고 있었는데 **선정이 한 번도 부르지
 * 않았다.** 문은 있고 길이 없었다.
 */
test("이름이 안 맞아도 본문에 정의가 있으면 선정된다", async () => {
  const host = new FakeHost({
    files: [
      { path: "src/ledger.ts", isDir: false, sizeBytes: 80 },
      { path: "src/unrelated.ts", isDir: false, sizeBytes: 40 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: {
      "src/ledger.ts": "export function resolveBudget(limit: number) {\n  return limit;\n}\n",
      "src/unrelated.ts": "export const other = 1;\n",
      "package.json": '{"scripts":{"test":"node --test"}}',
    },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const ledger = snapshot.relevantFiles.find((f) => f.path === "src/ledger.ts");
  assert.ok(ledger, `본문에 정의가 있는 파일이 빠졌습니다: ${snapshot.relevantFiles.map((f) => f.path).join(", ")}`);
  assert.equal(ledger.reason, "content-match");
  // **근거의 강도가 이름에 남는다.** `symbol-match`로 적으면 "파서가 확인했다"로 읽힌다.
  assert.match(ledger.reasonDetail, /정규식 — 심볼 그래프 아님/);
  assert.match(ledger.reasonDetail, /정의처럼 보이는/);
  // 무관한 파일까지 쓸어담지 않는다 — 그러면 예산만 먹는다.
  assert.ok(!snapshot.relevantFiles.some((f) => f.path === "src/unrelated.ts"));
});

/**
 * **정의가 없으면 넓게 찾되, 그 사실을 근거가 말한다.** 부르는 곳만 있는 경우에도 아무것도
 * 못 고르는 것보다는 낫지만, 사용자가 근거의 강도를 판단할 수 있어야 한다.
 */
test("정의를 못 찾으면 등장 위치로 내려가고 근거가 달라진다", async () => {
  const host = new FakeHost({
    files: [
      { path: "src/caller.ts", isDir: false, sizeBytes: 60 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: {
      "src/caller.ts": "import { helper } from './x';\nhelper(applyDiscount);\n",
      "package.json": '{"scripts":{"test":"node --test"}}',
    },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "applyDiscount 호출이 잘못됐습니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const caller = snapshot.relevantFiles.find((f) => f.path === "src/caller.ts");
  assert.ok(caller, "본문에 등장하는 파일이 빠졌습니다");
  assert.equal(caller.reason, "content-match");
  assert.match(caller.reasonDetail, /나타남/);
  assert.ok(!caller.reasonDetail.includes("정의처럼"), caller.reasonDetail);
});

/**
 * **제외 규칙이 옆문으로 뚫리지 않는다.**
 *
 * 검색은 우리 인덱스의 제외를 똑같이 적용하지 않는다. 비밀값 파일은 실제 도구도 건너뛰지만
 * (`tools/mod.rs`), **크기 제한은 우리 인덱스만의 규칙**이라 검색은 큰 파일도 그대로 돌려준다.
 * 그래서 인덱스에 없는 경로는 받지 않는다 — 이 검사가 겨냥하는 것이 그 자리다.
 *
 * (처음에는 `.env`로 이 검사를 썼는데, fake가 실제 도구처럼 비밀값을 건너뛰므로 **필터를
 * 지워도 통과했다.** 프로브가 그걸 잡았고, 검사가 겨냥한 것과 실제로 지키는 것이 달랐다.)
 */
test("본문 검색이 인덱스에서 제외된 파일을 되살리지 않는다", async () => {
  const huge = MAX_INDEXED_FILE_BYTES + 1;
  const host = new FakeHost({
    files: [
      { path: "src/app.ts", isDir: false, sizeBytes: 40 },
      { path: "src/generated.ts", isDir: false, sizeBytes: huge },
      { path: ".env", isDir: false, sizeBytes: 40 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: {
      "src/app.ts": "export const a = 1;\n",
      // 크기 때문에 인덱스에서 빠진 파일. **검색은 이걸 그대로 돌려준다.**
      "src/generated.ts": "export function applyDiscount() {}\n",
      ".env": "DISCOUNT_TOKEN=sk-secret-applyDiscount\n",
      "package.json": '{"scripts":{"test":"node --test"}}',
    },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "applyDiscount 설정이 잘못됐습니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const paths = snapshot.relevantFiles.map((f) => f.path);
  assert.ok(
    !paths.includes("src/generated.ts"),
    `크기로 제외된 파일이 본문 검색으로 들어왔습니다: ${paths.join(", ")}`
  );
  assert.ok(!paths.includes(".env"), `secret이 본문 검색으로 들어왔습니다: ${paths.join(", ")}`);
  const allContent = snapshot.relevantFiles.map((f) => f.content).join("\n");
  assert.ok(!allContent.includes("sk-secret-applyDiscount"));
});

/**
 * **검색 실패를 "없음"으로 읽지 않는다.** 읽지 못한 것과 없는 것은 다른 사실이고, 뭉개면
 * 컨텍스트가 조용히 좁아진 채 모델이 불린다.
 */
test("본문 검색이 실패하면 그 사실이 범위 노트에 남는다", async () => {
  const host = new FakeHost({
    files: [
      { path: "src/app.ts", isDir: false, sizeBytes: 40 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: { "src/app.ts": "export const a = 1;\n", "package.json": "{}" },
    gitStatus: "## main",
    failSearchText: true,
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  // **파일 노트가 아니다**(17절). 검색이 실패한 것은 파일의 성질이 아니라 우리 시야의 성질이고,
  // 파일 목록에 넣으면 `(search: foo)`가 파일 이름으로 프롬프트와 화면에 나간다.
  assert.ok(
    snapshot.coverageNotes?.some((n) => n.reason.includes("검색이 실패")),
    JSON.stringify(snapshot.coverageNotes)
  );
  assert.ok(
    !(snapshot.excludedNotes ?? []).some((n) => n.reason.includes("검색이 실패")),
    JSON.stringify(snapshot.excludedNotes)
  );
});

/** 키워드를 정규식에 그대로 넣지 않는다 — `a.b` 같은 토큰이 다른 것을 찾는다. */
test("검색 키워드는 정규식으로 escape된다", () => {
  assert.equal(escapeRegExp("a.b"), "a\\.b");
  assert.equal(escapeRegExp("x(y)"), "x\\(y\\)");
  assert.equal(escapeRegExp("plain"), "plain");
});

// ---- 앵커 주변 창 (context-engine 14절) ----

/** 100줄짜리 파일에서 `target`번째 줄에만 표식을 둔다. */
function numbered(lines: number, marker: number, text = "MARKER"): string {
  return Array.from({ length: lines }, (_unused, i) => (i + 1 === marker ? text : `line ${i + 1}`)).join("\n");
}

/**
 * **찾아 놓고 잘라 버리지 않는다** — context-engine 14절.
 *
 * 13절이 본문 검색으로 파일을 고르게 만들었는데 자르기는 여전히 접두사였다. 그러면 파일
 * 뒤쪽에 있는 정의는 찾아 놓고도 잘려 나가고, **찾은 값어치가 거기서 사라진다.**
 */
test("앵커가 파일 뒤쪽에 있어도 그 자리가 실린다", () => {
  const content = numbered(400, 380);
  const window = windowAroundLines(content, [380], 300);
  assert.ok(window.text.includes("MARKER"), `앵커가 잘려 나갔습니다: ${window.startLine}~${window.endLine}`);
  assert.ok(window.startLine > 1, "앞에서부터 잘랐습니다");
  assert.equal(window.totalLines, 400);
});

/** 앵커가 없으면 종전대로 앞에서부터다 — 그 경우 파일 앞부분이 구조를 가장 잘 말해 준다. */
test("앵커가 없으면 앞에서부터 자른다", () => {
  const content = numbered(400, 380);
  const window = windowAroundLines(content, [], 300);
  assert.equal(window.startLine, 1);
  assert.ok(!window.text.includes("MARKER"));
});

/** **범위 밖 앵커는 버린다.** 검색과 읽기 사이에 파일이 바뀔 수 있다. */
test("파일 끝 너머를 가리키는 앵커는 무시된다", () => {
  const content = numbered(20, 5);
  const window = windowAroundLines(content, [9999, -3, 1.5], 300);
  assert.equal(window.startLine, 1);
  assert.equal(window.totalLines, 20);
});

/**
 * **창은 연속된 하나다.** 조각을 이어 붙이면 본문에 구멍이 생기고, 그 구멍은 표시하지 않으면
 * 거짓이고 표시하면 모델이 그 표시를 patch context로 복사한다.
 */
test("실린 본문은 원본의 연속된 조각 그대로다", () => {
  const content = numbered(200, 150);
  const window = windowAroundLines(content, [150], 400);
  const expected = content.split("\n").slice(window.startLine - 1, window.endLine).join("\n");
  assert.equal(window.text, expected);
});

/** 앵커 **앞쪽**도 남긴다 — import·타입·주석이 없으면 모델이 이름을 지어낸다. */
test("앵커보다 앞도 조금 남는다", () => {
  const content = numbered(400, 300);
  const window = windowAroundLines(content, [300], 400);
  assert.ok(window.startLine < 300, `앵커 앞이 하나도 없습니다: ${window.startLine}`);
  assert.ok(window.endLine >= 300);
});

/** 예산이 한 줄도 못 담을 만큼 작아도 **빈 창을 내지 않는다.** */
test("예산이 아주 작아도 앵커 줄은 실린다", () => {
  const content = numbered(100, 50, "M".repeat(400));
  const window = windowAroundLines(content, [50], 5);
  assert.ok(window.text.length > 0, "빈 창이 나왔습니다");
});

/**
 * **어디를 실었는지 값으로 남는다.** 본문에 표시를 넣지 않는 대신 이 값이 프롬프트 머리글로
 * 간다 — 표시를 본문에 넣으면 모델이 그것을 patch context로 복사한다.
 */
test("packageFiles가 실린 줄 범위를 값으로 남긴다", () => {
  const content = numbered(400, 380);
  const packaged = packageFiles(
    [
      {
        path: "src/ledger.ts",
        reason: "content-match",
        reasonDetail: "본문에서 찾음",
        content,
        truncated: false,
        sizeBytes: content.length,
        anchorLines: [380],
      },
    ],
    600
  );
  const file = packaged.files[0]!;
  assert.equal(file.truncated, true);
  assert.ok(file.includedRange, "실린 범위가 없습니다");
  assert.equal(file.includedRange.totalLines, 400);
  assert.ok(file.includedRange.startLine > 1);
  assert.ok(file.content.includes("MARKER"));
  // 사람이 읽는 근거에도 남는다 — 자릿수가 아니라 줄 번호로.
  assert.match(file.reasonDetail, /줄만 포함/);
});

// ---- 앵커가 여럿일 때 창을 어디에 두는가 (context-engine 15절) ----

/** 여러 줄에 표식을 둔다. `numbered`의 다중 앵커 판. */
function marked(lines: number, markers: readonly number[]): string {
  const set = new Set(markers);
  return Array.from({ length: lines }, (_unused, i) => (set.has(i + 1) ? `MARKER${i + 1}` : `line ${i + 1}`)).join(
    "\n"
  );
}

/**
 * **첫 앵커가 최선이 아니다** — context-engine 15절.
 *
 * 14절은 창을 첫 앵커에 걸었다. 첫 매치가 import 줄이고 정작 정의와 그 호출부가 파일 뒤쪽에
 * 몰려 있으면, 첫 앵커에 창을 걸어 놓고 나머지를 전부 잘라 버린다 — **14절이 고치려던 바로
 * 그 실패**이고, 잘린 자리가 파일 앞이 아니라 첫 매치 근처라는 것만 다르다.
 */
test("가장 많은 앵커를 덮는 자리에 창이 놓인다", () => {
  // 앵커 하나는 파일 앞에 외따로, 셋은 뒤쪽에 몰려 있다.
  const content = marked(400, [3, 300, 305, 310]);
  const window = windowAroundLines(content, [3, 300, 305, 310], 300);

  assert.ok(window.text.includes("MARKER300"), `뒤쪽 무리를 놓쳤습니다: ${window.startLine}~${window.endLine}`);
  assert.ok(window.text.includes("MARKER305"));
  assert.ok(window.text.includes("MARKER310"));
  assert.equal(window.anchors.covered, 3);
  assert.equal(window.anchors.total, 4);
});

/**
 * **덮은 수가 같으면 앞쪽을 쓴다.** 결정적이어야 하고(같은 입력이 같은 스냅샷을 내야 대조가
 * 성립한다), 앞쪽이 대개 정의 쪽이다.
 */
test("같은 수를 덮으면 앞쪽 창을 고른다", () => {
  // 두 무리가 대칭이라 어느 쪽을 골라도 2개를 덮는다.
  const content = marked(400, [50, 55, 340, 345]);
  const window = windowAroundLines(content, [50, 55, 340, 345], 200);
  assert.equal(window.anchors.covered, 2);
  assert.ok(window.text.includes("MARKER50"), `뒤쪽을 골랐습니다: ${window.startLine}~${window.endLine}`);
  assert.ok(!window.text.includes("MARKER340"));
});

/** 예산이 넉넉해 전부 덮이면 **놓친 것이 없다**고 나와야 한다 — 그래야 "놓쳤다"가 신호가 된다. */
test("전부 덮으면 놓친 앵커가 0이다", () => {
  const content = marked(100, [10, 20, 30]);
  const window = windowAroundLines(content, [10, 20, 30], 100_000);
  assert.equal(window.anchors.covered, 3);
  assert.equal(window.anchors.total, 3);
});

/**
 * **범위 밖 앵커를 "놓쳤다"로 세지 않는다.** 그건 파일이 바뀌었다는 뜻이지 우리가 놓친 것이
 * 아니다 — 함께 세면 머리글이 모델에게 없는 지점을 찾으라고 말한다.
 */
test("범위 밖 앵커는 놓친 수에 들어가지 않는다", () => {
  const content = marked(50, [10]);
  const window = windowAroundLines(content, [10, 9999, -2], 100_000);
  assert.equal(window.anchors.total, 1);
  assert.equal(window.anchors.covered, 1);
});

/** **같은 줄을 두 번 세지 않는다.** 중복을 접지 않으면 덮은 수가 부풀려져 후보 비교가 틀린다. */
test("중복 앵커는 접힌다", () => {
  const content = marked(50, [10]);
  const window = windowAroundLines(content, [10, 10, 10], 100_000);
  assert.equal(window.anchors.total, 1);
});

/**
 * **놓친 앵커가 스냅샷에 남는다** — 14.6절이 미뤄 둔 이유가 "분포를 잰 적이 없다"였다.
 * 재는 장치가 없으면 고쳐도 나아졌는지 모른다.
 */
test("packageFiles가 앵커 덮개를 값으로 남긴다", () => {
  const content = marked(400, [3, 300, 305, 310]);
  const packaged = packageFiles(
    [
      {
        path: "src/ledger.ts",
        reason: "content-match",
        reasonDetail: "본문에서 찾음",
        content,
        truncated: false,
        sizeBytes: content.length,
        anchorLines: [3, 300, 305, 310],
      },
    ],
    600
  );
  const file = packaged.files[0]!;
  assert.ok(file.anchorCoverage, "앵커 덮개가 없습니다");
  assert.equal(file.anchorCoverage.total, 4);
  assert.ok(
    file.anchorCoverage.covered < file.anchorCoverage.total,
    "이 예산에서 전부 덮였다면 아래 머리글 검사가 공허해집니다"
  );
});

/**
 * **모델에게도 말한다.** 관련 지점이 창 밖에 있다는 것은 모델이 patch를 자신 있게 쓰면 안
 * 되는 이유다. 값으로만 남기고 프롬프트에 넣지 않으면 모델은 자기가 본 조각이 관련 지점
 * 전부라고 가정한다.
 */
test("머리글이 창 밖에 남은 지점 수를 말한다", () => {
  const content = marked(400, [3, 300, 305, 310]);
  const packaged = packageFiles(
    [
      {
        path: "src/ledger.ts",
        reason: "content-match",
        reasonDetail: "본문에서 찾음",
        content,
        truncated: false,
        sizeBytes: content.length,
        anchorLines: [3, 300, 305, 310],
      },
    ],
    600
  );
  const rendered = renderSnapshot(makeSnapshot({ relevantFiles: packaged.files }));
  assert.match(rendered, /fall OUTSIDE this slice/);
  assert.match(rendered, /1 of 4 matching locations/);
});

/** 전부 덮였으면 **그 문장이 없어야 한다** — 언제나 붙으면 신호가 아니라 배경이 된다. */
test("전부 덮였으면 머리글에 그 문장이 없다", () => {
  const content = marked(400, [300, 302]);
  const packaged = packageFiles(
    [
      {
        path: "src/ledger.ts",
        reason: "content-match",
        reasonDetail: "본문에서 찾음",
        content,
        truncated: false,
        sizeBytes: content.length,
        anchorLines: [300, 302],
      },
    ],
    600
  );
  const file = packaged.files[0]!;
  assert.equal(file.truncated, true, "잘리지 않았다면 이 검사는 공허합니다");
  assert.equal(file.anchorCoverage!.covered, file.anchorCoverage!.total);
  const rendered = renderSnapshot(makeSnapshot({ relevantFiles: packaged.files }));
  assert.ok(rendered.includes("TRUNCATED"), "잘림 표시 자체는 있어야 합니다");
  assert.ok(!rendered.includes("fall OUTSIDE"), "놓친 것이 없는데 놓쳤다고 말합니다");
});

/**
 * **모델에게도 두 사실을 갈라서 말한다** — context-engine 17절.
 *
 * 한동안 검색 쪽 노트가 `excludedNotes`에 섞여 있었고, 프롬프트는 그 목록을
 * *"Files deliberately excluded from context"* 라는 제목 아래 내면서 *"필요하면 요청하라"*
 * 고 덧붙였다. 그래서 모델이 읽은 것은 **`(search: foo)`라는 파일이 제외됐다**는 문장이었고,
 * 있지도 않은 파일을 요청하라는 지시가 붙어 있었다.
 *
 * 두 문단은 하는 말이 다르다: 하나는 "이 파일의 내용을 넣지 않았다", 다른 하나는 "이 범위를
 * 확인하지 못했으니 없다고 결론 내리지 말라"이다.
 */
test("프롬프트가 제외된 파일과 보지 못한 범위를 다른 문단으로 말한다", () => {
  const rendered = renderSnapshot(
    makeSnapshot({
      excludedNotes: [{ path: ".env", reason: "비밀값 파일" }],
      coverageNotes: [
        { kind: "search_secret_skipped", scope: "본문 검색: resolveBudget", reason: "비밀값 파일 2개는 검색하지 않았습니다" },
      ],
    })
  );

  const excludedAt = rendered.indexOf("Files deliberately excluded");
  const coverageAt = rendered.indexOf("did NOT cover");
  assert.notEqual(excludedAt, -1, rendered);
  assert.notEqual(coverageAt, -1, rendered);
  assert.notEqual(excludedAt, coverageAt, "두 문단이 하나로 합쳐졌습니다");

  // **파일 문단에 범위가 들어가지 않는다.** 이게 종전 상태다.
  const excludedBlock = rendered.slice(excludedAt, coverageAt);
  assert.ok(!excludedBlock.includes("본문 검색"), excludedBlock);
  assert.ok(excludedBlock.includes(".env"), excludedBlock);

  // 그리고 **지시문이 다르다.** "필요하면 요청하라"는 파일에만 붙는다.
  const coverageBlock = rendered.slice(coverageAt);
  assert.ok(excludedBlock.includes("ask instead"), excludedBlock);
  assert.ok(!coverageBlock.includes("ask instead"), coverageBlock);
  assert.match(coverageBlock, /not evidence of absence/);
});

/** 범위 노트가 없으면 **그 문단이 없다** — 언제나 붙으면 신호가 아니라 배경이 된다. */
test("보지 못한 범위가 없으면 그 문단이 없다", () => {
  const rendered = renderSnapshot(makeSnapshot({ excludedNotes: [{ path: ".env", reason: "비밀값 파일" }] }));
  assert.ok(rendered.includes("Files deliberately excluded"), rendered);
  assert.ok(!rendered.includes("did NOT cover"), rendered);
});

/**
 * **검색이 찾은 줄이 실제로 실린다** — context-engine 14절, 끝에서 끝까지.
 *
 * 위 단위 검사들은 `windowAroundLines`가 앵커를 존중한다는 것과 `packageFiles`가 범위를
 * 남긴다는 것을 각각 본다. 그런데 그 둘 사이에 **배선**이 있다: 검색 결과의 줄 번호가
 * 후보를 거쳐 파일까지 와야 한다.
 *
 * 프로브로 그 배선을 끊어 보니 **아무 검사도 실패하지 않았다.** 조각마다 검사가 있어도
 * 이어지지 않으면 기능은 없는 것이다 — 이 절이 고치려던 것과 같은 모양의 결함이다.
 */
test("검색이 찾은 줄이 예산에 쫓겨도 컨텍스트에 남는다", async () => {
  // 정의는 파일 **뒤쪽**에 있다. 앞에서부터 자르면 이 줄이 사라진다.
  const lines = Array.from({ length: 600 }, (_unused, i) =>
    i === 560 ? "export function resolveBudget(limit) { return limit; }" : `const filler${i} = ${i};`
  );
  const content = lines.join("\n");

  const host = new FakeHost({
    files: [
      { path: "src/ledger.ts", isDir: false, sizeBytes: content.length },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: { "src/ledger.ts": content, "package.json": "{}" },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    // 파일 전체를 담기에는 모자란 예산 — 잘라야만 한다.
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 1_200 }],
  });

  const ledger = snapshot.relevantFiles.find((f) => f.path === "src/ledger.ts");
  assert.ok(ledger, "파일이 아예 빠졌습니다");
  assert.equal(ledger.truncated, true, "이 검사는 잘리는 상황을 봐야 합니다");
  assert.ok(
    ledger.content.includes("resolveBudget(limit)"),
    `찾아 놓고 잘라 버렸습니다: ${ledger.includedRange?.startLine}~${ledger.includedRange?.endLine}`
  );
  assert.ok(ledger.includedRange && ledger.includedRange.startLine > 1, "앞에서부터 잘랐습니다");
});

/**
 * **사용자가 이름을 댄 파일이 앵커를 잃었다** — context-engine 15절, 끝에서 끝까지.
 *
 * 선정은 여러 단계가 같은 파일을 더할 수 있다. 종전 `add`는 이미 있는 경로면 호출을 통째로
 * 버렸고, **앵커도 함께 버려졌다.** 그 손해가 가장 큰 경우가 가장 흔한 경우다: 사용자가
 * `ledger.ts`라고 이름을 대면 2단계가 앵커 없이 먼저 넣고, 5단계의 본문 검색이 정의를
 * 찾아도 그 줄 번호가 버려진다. 그러면 **지목했고 정의도 거기 있는 파일** — 가장 중요한
 * 파일 — 이 14절 이전으로 돌아가 앞에서부터 잘린다.
 *
 * 위 검사가 이걸 못 잡은 이유는 거기서는 사용자가 파일 이름을 대지 않았기 때문이다.
 */
test("이름을 댄 파일도 본문 검색이 찾은 줄을 지킨다", async () => {
  const lines = Array.from({ length: 600 }, (_unused, i) =>
    i === 560 ? "export function resolveBudget(limit) { return limit; }" : `const filler${i} = ${i};`
  );
  const content = lines.join("\n");

  const host = new FakeHost({
    files: [
      { path: "src/ledger.ts", isDir: false, sizeBytes: content.length },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: { "src/ledger.ts": content, "package.json": "{}" },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    // **파일 이름을 직접 댄다** — 이것이 위 검사와의 차이다.
    userMessage: "src/ledger.ts 의 resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 1_200 }],
  });

  const ledger = snapshot.relevantFiles.find((f) => f.path === "src/ledger.ts");
  assert.ok(ledger, "파일이 아예 빠졌습니다");
  assert.equal(ledger.truncated, true, "이 검사는 잘리는 상황을 봐야 합니다");
  assert.ok(
    ledger.anchorLines && ledger.anchorLines.length > 0,
    "앵커가 하나도 없습니다 — 지목이 검색 결과를 덮어썼습니다"
  );
  assert.ok(
    ledger.content.includes("resolveBudget(limit)"),
    `찾아 놓고 잘라 버렸습니다: ${ledger.includedRange?.startLine}~${ledger.includedRange?.endLine}`
  );
});

/**
 * **앵커는 여러 단계에서 모인다.** 합치지 않으면 15절의 "가장 많이 덮는 창"이 덮을 것이
 * 하나뿐이라 아무 일도 하지 않는다 — 문을 만들고 걸어 들어가는 길을 막는 꼴이다.
 */
test("여러 키워드가 같은 파일을 찾으면 앵커가 합쳐진다", async () => {
  const lines = Array.from({ length: 600 }, (_unused, i) => {
    if (i === 100) return "export function resolveBudget(limit) { return limit; }";
    if (i === 520) return "export function settleReservation(id) { return id; }";
    return `const filler${i} = ${i};`;
  });
  const content = lines.join("\n");

  const host = new FakeHost({
    files: [
      { path: "src/ledger.ts", isDir: false, sizeBytes: content.length },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: { "src/ledger.ts": content, "package.json": "{}" },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 과 settleReservation 이 서로 어긋납니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 1_200 }],
  });

  const ledger = snapshot.relevantFiles.find((f) => f.path === "src/ledger.ts");
  assert.ok(ledger, "파일이 아예 빠졌습니다");
  const anchors = ledger.anchorLines ?? [];
  // 두 정의가 멀리 떨어져 있으므로 창 하나로는 둘 다 덮지 못한다 — 그래도 **둘 다 앵커여야**
  // 15절의 고르기가 일할 거리를 갖는다.
  assert.ok(anchors.includes(101), `resolveBudget의 줄이 없습니다: ${anchors.join(",")}`);
  assert.ok(anchors.includes(521), `settleReservation의 줄이 없습니다: ${anchors.join(",")}`);
  assert.ok(ledger.anchorCoverage, "앵커 덮개가 없습니다");
  assert.equal(ledger.anchorCoverage.total, anchors.length);
});

// ---- 검색이 못 본 것 (state-machine 58절) ----

/**
 * **"검색했는데 없다"와 "검색하지 않았다"를 구별한다** — state-machine 58절.
 *
 * 실제 `search_text`는 비밀값 파일을 **읽기 전에** 건너뛰고 그 개수를 `skippedSecretFiles`로
 * 돌려준다. `tools/mod.rs`의 주석이 그 값의 목적을 이렇게 적어 두었다:
 * *"오케스트레이터가 '여기 없으니 없다'고 결론 내리는 것을 막고."*
 *
 * 그런데 **Node 쪽에서 그 값을 읽는 코드가 하나도 없었다.** 문은 있고 걸어 들어가는 길이
 * 없는 자리이며, 13절이 검색 *실패*에 대해 세운 규율("실패를 없음으로 읽지 않는다")이
 * *일부러 안 본* 경우에는 서 있지 않았던 것이다.
 */
test("검색이 건너뛴 비밀값 파일이 스냅샷 노트에 남는다", async () => {
  const host = new FakeHost({
    files: [
      { path: "src/ledger.ts", isDir: false, sizeBytes: 40 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
      // **인덱스에도 올린다.** 인덱스가 secret으로 제외하므로 지목하면 파일 노트가 하나
      // 생기고, 그래야 아래 "파일 노트에는 없다"가 빈 목록에 대한 전칭 명제가 되지 않는다.
      { path: ".env", isDir: false, sizeBytes: 20 },
    ],
    contents: {
      "src/ledger.ts": "export const other = 1;\n",
      "package.json": "{}",
      // fake의 검색은 이 파일을 **읽기 전에 건너뛴다** — 실제 도구와 같다.
      ".env": "resolveBudget=secret\n",
    },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    // **`.env`를 지목한다.** 그래야 파일 노트가 하나 생기고, 아래 "파일 노트에는 없다"와
    // "파일 노트의 경로는 실재한다"가 빈 목록에 대한 전칭 명제가 되지 않는다.
    userMessage: "resolveBudget 이 이상합니다 (.env 도 봐주세요)",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 60_000 }],
  });

  // **`coverageNotes`다**(17절). 파일 노트와 같은 목록에 있으면 `(search: foo)`가 파일
  // 이름으로 프롬프트와 화면에 나간다.
  const note = (snapshot.coverageNotes ?? []).find((n) => n.reason.includes("검색하지 않았습니다"));
  assert.ok(note, JSON.stringify(snapshot.coverageNotes));
  assert.match(note.reason, /비밀값 파일 1개/);
  // **"찾지 못했습니다"로 끝나지 않는다** — 거기 있었을 수도 있다는 사실이 남아야 한다.
  assert.match(note.reason, /거기 있었다면/);

  // **파일 노트에는 없다.** 섞이면 화면의 "이름만 나간 파일" 개수가 파일 수가 아니게 된다.
  assert.ok(
    !(snapshot.excludedNotes ?? []).some((n) => n.reason.includes("검색하지 않았습니다")),
    JSON.stringify(snapshot.excludedNotes)
  );
  // 그리고 **파일 노트의 경로는 전부 실재한다** — 판정 기준은 손으로 적은 모양이 아니라
  // 이 워크스페이스가 아는 파일 목록이다. `(search: …)` 같은 것이 다시 섞이면 여기서 걸린다.
  const known = new Set(["src/ledger.ts", "package.json", ".env"]);
  assert.ok((snapshot.excludedNotes ?? []).some((n) => n.path === ".env"), JSON.stringify(snapshot.excludedNotes));
  for (const n of snapshot.excludedNotes ?? []) {
    assert.ok(known.has(n.path), `파일이 아닌 것이 파일 노트에 있습니다: ${n.path}`);
  }
  // 빈 목록이면 위 반복이 공허하다 — 이 시나리오에는 `.env` 노트가 있어야 한다.
  assert.ok((snapshot.excludedNotes ?? []).length > 0, JSON.stringify(snapshot));
});

/** 건너뛴 것이 없으면 **그 노트도 없다** — 언제나 붙으면 신호가 아니라 배경이 된다. */
test("건너뛴 것이 없으면 그 노트가 없다", async () => {
  const host = new FakeHost({
    files: [{ path: "src/ledger.ts", isDir: false, sizeBytes: 40 }],
    contents: { "src/ledger.ts": "export function resolveBudget() {}\n" },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 이상합니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 60_000 }],
  });
  assert.ok(
    !(snapshot.coverageNotes ?? []).some((n) => n.reason.includes("검색하지 않았습니다")),
    JSON.stringify(snapshot.coverageNotes)
  );
});

/**
 * **결과가 잘렸으면 "여기 없다"는 결론이 성립하지 않는다.**
 *
 * 상한에 걸린 검색은 찾은 것이 전부가 아니고, 그 사실을 말하지 않으면 그 위의 판단이
 * 조용히 틀린다 — 비밀값 건너뛰기와 같은 모양이다.
 */
test("검색 결과가 잘렸다는 사실이 노트에 남는다", async () => {
  const files = Array.from({ length: FAKE_MAX_SEARCH_MATCHES + 2 }, (_u, i) => `src/f${i}.ts`);
  const host = new FakeHost({
    files: files.map((path) => ({ path, isDir: false, sizeBytes: 40 })),
    contents: Object.fromEntries(files.map((path) => [path, "resolveBudget();\n"])),
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 이상합니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 60_000 }],
  });
  const note = (snapshot.coverageNotes ?? []).find((n) => n.reason.includes("상한에서 잘렸습니다"));
  assert.ok(note, JSON.stringify(snapshot.coverageNotes));
  assert.match(note.reason, /전부가 아닙니다/);
  // **범위이지 경로가 아니다.** 필드 이름이 `scope`인 것이 그 구별이다.
  assert.match(note.scope, /본문 검색/);
});

/**
 * **목록도 잘린다 — 그리고 아무도 그 사실을 읽지 않았다** — context-engine 18절.
 *
 * 실제 `list_files`는 5000개에서 자르고 `truncated`를 함께 내는데, 브리지가 배열만 꺼내면서
 * 그 값을 버렸다. 그래서 인덱스가 워크스페이스의 **일부만** 담은 채 만들어져도 그 사실이
 * 아무 데도 남지 않았다 — 16절이 검색에서 고친 것과 같은 모양이고, 이쪽이 더 넓게 퍼진다:
 * 인덱스는 캐시에 저장되고 다음 태스크가 그대로 쓴다.
 */
test("파일 목록이 잘리면 그 사실이 범위 노트에 남는다", async () => {
  const files = Array.from({ length: FAKE_MAX_LIST_ENTRIES + 2 }, (_u, i) => `src/f${i}.ts`);
  const host = new FakeHost({
    files: files.map((path) => ({ path, isDir: false, sizeBytes: 20 })),
    contents: Object.fromEntries(files.map((path) => [path, "export const a = 1;\n"])),
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "무언가 고쳐주세요",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 60_000 }],
  });

  const note = (snapshot.coverageNotes ?? []).find((n) => n.scope === "파일 목록");
  assert.ok(note, JSON.stringify(snapshot.coverageNotes));
  assert.match(note.reason, /잘렸습니다/);
  // **"여기 없으니 없다"를 막는 문장이어야 한다.** 잘렸다는 사실만으로는 읽는 쪽이 무엇을
  // 하지 말아야 하는지 모른다.
  assert.match(note.reason, /있을 수 있습니다/);
});

/** 안 잘렸으면 **그 노트가 없다** — 언제나 붙으면 신호가 아니라 배경이 된다. */
test("파일 목록이 안 잘렸으면 그 노트가 없다", async () => {
  const host = new FakeHost({
    files: [{ path: "src/a.ts", isDir: false, sizeBytes: 20 }],
    contents: { "src/a.ts": "export const a = 1;\n" },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "무언가 고쳐주세요",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 60_000 }],
  });
  assert.ok(
    !(snapshot.coverageNotes ?? []).some((n) => n.scope === "파일 목록"),
    JSON.stringify(snapshot.coverageNotes)
  );
});

/**
 * **세 값이 세 문장이다** — `false`만 침묵이다.
 *
 * 호스트가 말하지 않은 것(`null`)을 "안 잘렸다"로 접으면 우리가 모르는 것을 안다고 주장하게
 * 된다. 16절이 개수에 대해 세운 규칙과 같고, 이 절은 그것을 불리언에도 적용한다.
 */
test("호스트가 말하지 않은 것과 안 잘린 것을 구별한다", () => {
  assert.equal(listingCoverageNote(false), null);
  const unknown = listingCoverageNote(null);
  const cut = listingCoverageNote(true);
  assert.ok(unknown && cut);
  assert.notEqual(unknown.reason, cut.reason, "모르는 것과 잘린 것을 같은 문장으로 말합니다");
  assert.match(unknown.reason, /말하지 않았습니다/);
  // 필드가 아예 없는 경우(이 필드가 생기기 전에 저장된 캐시)도 "모른다"다.
  assert.deepEqual(listingCoverageNote(undefined), unknown);
});

/**
 * **`null`과 `0`을 뭉개지 않는다** — 호스트가 이 사실을 말하지 않은 것과 "건너뛴 것이 없다"는
 * 다른 사실이다. 뭉개면 옛 호스트나 게으른 fake가 조용히 "건너뛴 것 없음"을 주장한다.
 */
test("호스트가 말하지 않으면 건너뛴 수는 null이다", async () => {
  // **옛 호스트를 흉내낸다**: `matches`만 내고 나머지 필드를 아예 내지 않는다.
  // FakeHost로는 이걸 만들 수 없다 — 그쪽은 이제 세 값을 모두 내기 때문이다(58절).
  const transport = {
    request: async () => ({
      result: {
        requestId: "r",
        status: "ok",
        output: { matches: [] },
        durationMs: 1,
        completedAt: "now",
      },
      policy: { decision: "auto_approve", riskLevel: "none", reason: "", matchedRule: "", normalizedTarget: "" },
    }),
  } as unknown as NdjsonTransport;

  const found = await new ToolBridge(transport, "task-1").searchText("x");
  assert.equal(found.skippedSecretFiles, null, "필드가 없는데 0으로 위장했습니다");
  // **불리언도 같은 규칙이다**(18절). 16절은 이 규칙을 개수에만 적용하고 여기서는 `false`로
  // 접었는데, 그건 말하지 않은 호스트가 "안 잘렸다"고 주장하는 것과 같다.
  assert.equal(found.truncated, null, "필드가 없는데 false로 위장했습니다");
});

/**
 * **재는 장치의 값이 기록에 닿아야 한다** — state-machine 61절.
 *
 * 15.3절이 `anchorCoverage`를 만든 이유는 "앵커 분포를 잰 적이 없다"였다. 그런데 그 값이
 * 스냅샷에만 있고 이벤트에 없으면 **여전히 잰 적이 없다** — 값이 메모리에서 태어나 기록에
 * 닿지 못한 채 사라진다.
 *
 * 16.1절이 본 것("값은 있는데 읽는 사람이 없다")보다 한 단계 앞이고, 증상은 더 조용하다:
 * 읽는 코드를 나중에 만들어도 읽을 것이 없다.
 */
test("앵커 덮개가 SNAPSHOT_CREATED에 실린다", async () => {
  const lines = Array.from({ length: 600 }, (_u, i) => {
    if (i === 100) return "export function resolveBudget(limit) { return limit; }";
    if (i === 520) return "export function resolveBudget2(id) { return id; }";
    return `const filler${i} = ${i};`;
  });
  const content = lines.join("\n");

  const host = new FakeHost({
    files: [
      { path: "src/ledger.ts", isDir: false, sizeBytes: content.length },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: { "src/ledger.ts": content, "package.json": "{}" },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 이상합니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 1_200 }],
  });

  const ledger = snapshot.relevantFiles.find((f) => f.path === "src/ledger.ts");
  assert.ok(ledger?.anchorCoverage, "스냅샷에 앵커 덮개가 없습니다 — 이 검사가 공허합니다");

  // 그리고 그 값이 **이벤트 payload 모양**으로 살아남아야 한다. payload를 만드는 코드는
  // 오케스트레이터에 있으므로 여기서는 그 모양을 소스에서 확인한다.
  const orchestrator = readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "packages", "sidecar", "src", "orchestrator", "orchestrator.ts"),
    "utf8"
  );
  const payloadAt = orchestrator.indexOf("private snapshotPayload(");
  assert.notEqual(payloadAt, -1, "snapshotPayload를 찾지 못했습니다");
  const body = orchestrator.slice(payloadAt, orchestrator.indexOf("\n  }", payloadAt));
  assert.ok(body.includes("anchorCoverage"), "SNAPSHOT_CREATED payload가 앵커 덮개를 싣지 않습니다");
});
