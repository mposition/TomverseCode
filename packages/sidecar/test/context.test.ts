import test from "node:test";
import assert from "node:assert/strict";
import { ContextEngine, extractKeywords, extractMentions, hasUncommittedChanges, parseBranch, parseNpmScripts } from "../src/context/engine.js";
import { classifyFile, MAX_INDEXED_FILE_BYTES } from "../src/context/exclude.js";
import { approximateTokens, packageFiles } from "../src/context/budget.js";
import { FakeHost } from "./helpers/fakeHost.js";
import { ToolBridge } from "../src/tools/bridge.js";
import { makeRelevantFile } from "./helpers/fixtures.js";

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

test("토큰 근사는 문자 수에 비례한다", () => {
  assert.ok(approximateTokens("x".repeat(350)) === 100);
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

test("M0 인덱스는 심볼 그래프를 비워두고 그 사실을 감추지 않는다", async () => {
  const host = new FakeHost({ files: [{ path: "src/app.ts", isDir: false, sizeBytes: 50 }], contents: { "src/app.ts": "// x" } });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const index = await new ContextEngine().ensureIndex(bridge, "ws-1");
  assert.deepEqual(index.symbols, []);
  assert.deepEqual(index.dependencyEdges, []);
});
