import test from "node:test";
import assert from "node:assert/strict";
import { ContextEngine, extractKeywords, extractMentions, hasUncommittedChanges, parseBranch, parseNpmScripts } from "../src/context/engine.js";
import { classifyFile, MAX_INDEXED_FILE_BYTES } from "../src/context/exclude.js";
import { estimateTokensUpperBound, packageFiles, truncateToTokens } from "../src/context/budget.js";
import { FakeHost } from "./helpers/fakeHost.js";
import { ToolBridge } from "../src/tools/bridge.js";
import { makeRelevantFile, makeSnapshot } from "./helpers/fixtures.js";

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
