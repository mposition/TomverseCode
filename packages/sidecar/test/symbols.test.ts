import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SymbolEntry } from "@tomverse/protocol";
import { ContextEngine } from "../src/context/engine.js";
import { dependenciesWithinHops, symbolMatchFiles } from "../src/context/graph.js";
import { dirnamePosix, joinPosix, resolveImport, rustChildrenDir, rustSuperDir } from "../src/context/imports.js";
import { indexSymbols, SYMBOL_INDEX_VERSION } from "../src/context/symbolIndex.js";
import { rustUsePrefix } from "../src/context/symbols.js";
import {
  grammarForPath,
  loadGrammars,
  resolveGrammarPath,
  SUPPORTED_LANGUAGES,
  type GrammarSet,
} from "../src/context/treeSitter.js";
import { ToolBridge } from "../src/tools/bridge.js";
import { FakeHost } from "./helpers/fakeHost.js";

/**
 * Tree-sitter 심볼/의존성 인덱스 — docs/design/context-engine.md 5·6·16절.
 *
 * 이 파일이 지키는 것은 **그 층이 실제로 도는가**이지 "코드가 있는가"가 아니다. 그래서
 * 대부분의 검사가 진짜 grammar를 싣고 진짜 소스를 파싱한다 — fake로 심볼을 넣어 두면
 * 파서가 한 줄도 안 돌아도 전부 통과한다(13.5절과 같은 종류의 함정).
 */

// ---- 언어별 심볼 추출 (5절이 정한 종류만) ----

async function symbolsOf(files: Record<string, string>): Promise<SymbolEntry[]> {
  const outcome = await indexSymbols({
    targets: Object.keys(files).map((p) => ({ path: p, language: languageFor(p) })),
    knownPaths: new Set(Object.keys(files)),
    read: async (p) => files[p] ?? null,
  });
  return outcome.symbols;
}

function languageFor(p: string): string | null {
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".rs")) return "rust";
  return null;
}

function kindsOf(symbols: readonly SymbolEntry[], name: string): string[] {
  return symbols.filter((s) => s.name === name).map((s) => s.kind);
}

test("TypeScript에서 5절이 정한 종류의 심볼이 뽑힌다", async () => {
  const symbols = await symbolsOf({
    "src/a.ts": [
      'import { dep } from "./dep.js";',
      "export interface Shape { size: number }",
      "export type Alias = Shape;",
      "export const LIMIT = 10;",
      "export function resolveBudget(n: number) { const localOnly = n; return localOnly; }",
      "export class Ledger {",
      "  commit(n: number) { return n; }",
      "}",
      'export { helper } from "./dep.js";',
    ].join("\n"),
    "src/dep.ts": "export function helper() {}\n",
  });

  assert.deepEqual(kindsOf(symbols, "Shape"), ["interface"]);
  assert.deepEqual(kindsOf(symbols, "Alias"), ["type"]);
  assert.deepEqual(kindsOf(symbols, "LIMIT"), ["const"]);
  assert.deepEqual(kindsOf(symbols, "resolveBudget"), ["function"]);
  assert.deepEqual(kindsOf(symbols, "Ledger"), ["class"]);
  assert.deepEqual(kindsOf(symbols, "commit"), ["method"]);
  // 재수출은 정의가 아니지만 **이름은 여기 있다** — 배럴 파일을 고르는 근거가 된다.
  assert.ok(kindsOf(symbols, "helper").includes("export"));
  // **함수 본문 안까지는 들어가지 않는다** — 5절이 정한 범위다. 넓히면 인덱스가 call graph가
  // 되고, 그건 MVP 범위 밖이라고 문서가 못박았다.
  assert.deepEqual(kindsOf(symbols, "localOnly"), []);
  // 줄 번호는 1-base다. 이 값이 어긋나면 앵커가 엉뚱한 자리를 가리킨다(14절).
  assert.equal(symbols.find((s) => s.name === "resolveBudget")?.startLine, 5);
});

test("Python에서 5절이 정한 종류의 심볼이 뽑힌다", async () => {
  const symbols = await symbolsOf({
    "pkg/mod.py": [
      "from . import sibling",
      "MAX_ROUNDS = 3",
      "def top(a):",
      "    inner = a",
      "    return inner",
      "class Runner:",
      "    ATTR = 1",
      "    def run(self):",
      "        pass",
    ].join("\n"),
    "pkg/sibling.py": "x = 1\n",
  });

  assert.deepEqual(kindsOf(symbols, "MAX_ROUNDS"), ["const"]);
  assert.deepEqual(kindsOf(symbols, "top"), ["function"]);
  assert.deepEqual(kindsOf(symbols, "Runner"), ["class"]);
  assert.deepEqual(kindsOf(symbols, "run"), ["method"]);
  assert.deepEqual(kindsOf(symbols, "ATTR"), ["const"]);
  assert.deepEqual(kindsOf(symbols, "inner"), []);
});

test("Rust에서 5절이 정한 종류의 심볼이 뽑힌다", async () => {
  const symbols = await symbolsOf({
    "core/src/lib.rs": [
      "pub struct Gate { pub open: bool }",
      "pub enum Verdict { Allow, Deny }",
      "pub trait Policy { fn decide(&self) -> Verdict; }",
      "pub type Outcome = Verdict;",
      "pub const MAX: u32 = 3;",
      "static COUNTER: u32 = 0;",
      "impl Gate { pub fn evaluate(&self) -> bool { let local = true; local } }",
      "pub fn build() {}",
    ].join("\n"),
  });

  // Rust의 개념을 프로토콜의 7종으로 접는 규칙이 여기 고정된다.
  assert.deepEqual(kindsOf(symbols, "Gate"), ["class"]);
  assert.deepEqual(kindsOf(symbols, "Verdict"), ["class"]);
  assert.deepEqual(kindsOf(symbols, "Policy"), ["interface"]);
  assert.deepEqual(kindsOf(symbols, "Outcome"), ["type"]);
  assert.deepEqual(kindsOf(symbols, "MAX"), ["const"]);
  assert.deepEqual(kindsOf(symbols, "COUNTER"), ["const"]);
  assert.deepEqual(kindsOf(symbols, "evaluate"), ["method"]);
  assert.deepEqual(kindsOf(symbols, "build"), ["function"]);
  assert.deepEqual(kindsOf(symbols, "local"), []);
});

// ---- 의존성 엣지 (파일 단위만) ----

test("import/require에서 파일 단위 엣지가 생긴다", async () => {
  const files = {
    // TS 소스가 `.js`라고 적고 실제 파일은 `.ts`인 표기(NodeNext) — 이 저장소 자신의 표기다.
    "src/app.ts": 'import { helper } from "./util.js";\nimport bare from "some-package";\n',
    "src/legacy.cjs": 'const util = require("./util.js");\n',
    "src/util.ts": "export function helper() {}\n",
    "pkg/mod.py": "from .sibling import thing\n",
    "pkg/sibling.py": "thing = 1\n",
    "core/src/lib.rs": "mod tools;\nuse crate::tools::patch::apply;\n",
    "core/src/tools.rs": "pub mod patch;\n",
    "core/src/tools/patch.rs": "pub fn apply() {}\n",
  };
  const outcome = await indexSymbols({
    targets: Object.keys(files).map((p) => ({ path: p, language: languageFor(p) })),
    knownPaths: new Set(Object.keys(files)),
    read: async (p) => files[p as keyof typeof files] ?? null,
  });
  const edges = outcome.edges.map((e) => `${e.fromFile} -${e.kind}-> ${e.toFile}`).sort();

  assert.ok(edges.includes("src/app.ts -import-> src/util.ts"), edges.join("\n"));
  assert.ok(edges.includes("src/legacy.cjs -require-> src/util.ts"), edges.join("\n"));
  assert.ok(edges.includes("pkg/mod.py -import-> pkg/sibling.py"), edges.join("\n"));
  // `mod x;`는 파일 편입이므로 `reference`다 — import와 구별해서 적는다.
  assert.ok(edges.includes("core/src/lib.rs -reference-> core/src/tools.rs"), edges.join("\n"));
  assert.ok(edges.includes("core/src/lib.rs -import-> core/src/tools/patch.rs"), edges.join("\n"));
  // **bare 지정자는 엣지가 아니다.** 워크스페이스 파일이 아니므로 가리킬 곳이 없다.
  assert.ok(!edges.some((e) => e.includes("some-package")));
});

test("인덱스에 없는 파일로는 엣지를 만들지 않는다", async () => {
  // 7절의 하드 필터가 그래프를 통해 옆문으로 뚫리면 안 된다(13.4절과 같은 문).
  const outcome = await indexSymbols({
    targets: [{ path: "src/app.ts", language: "typescript" }],
    knownPaths: new Set(["src/app.ts"]),
    read: async () => 'import { key } from "./secrets.js";\n',
  });
  assert.deepEqual(outcome.edges, []);
});

// ---- 경로 해석 (플랫폼 구분자에 걸리지 않는다) ----

test("경로 조작은 POSIX 규칙으로 한다 — 실행 OS와 무관하다", () => {
  assert.equal(joinPosix("a/b", "../c"), "a/c");
  assert.equal(joinPosix("a", "./b/./c"), "a/b/c");
  // 워크스페이스 루트 위로 올라가면 경로가 아니다.
  assert.equal(joinPosix("a", "../.."), null);
  assert.equal(dirnamePosix("a/b/c.ts"), "a/b");
  assert.equal(dirnamePosix("c.ts"), "");
});

test("Rust 모듈 트리의 self/super 디렉터리 규칙", () => {
  assert.equal(rustChildrenDir("core/src/tools/mod.rs"), "core/src/tools");
  assert.equal(rustChildrenDir("core/src/tools/patch.rs"), "core/src/tools/patch");
  assert.equal(rustSuperDir("core/src/tools/mod.rs"), "core/src");
  assert.equal(rustSuperDir("core/src/tools/patch.rs"), "core/src/tools");
  assert.equal(rustUsePrefix("crate::a::{b, c}"), "crate::a");
  assert.equal(rustUsePrefix("crate::a::b as d"), "crate::a::b");
});

test("파이썬 절대 import는 후보가 여럿이면 고르지 않는다", () => {
  const paths = new Set(["a/pkg/mod.py", "b/pkg/mod.py"]);
  assert.equal(
    resolveImport({ fromPath: "x/main.py", language: "python", specifier: "pkg.mod", kind: "import", paths }),
    null
  );
  const single = new Set(["a/pkg/mod.py"]);
  assert.equal(
    resolveImport({ fromPath: "x/main.py", language: "python", specifier: "pkg.mod", kind: "import", paths: single }),
    "a/pkg/mod.py"
  );
});

// ---- 그래프 순회 (순수 함수) ----

test("의존성 순회는 홉 수를 함께 주고 상한을 지킨다", () => {
  const edges = [
    { fromFile: "a.ts", toFile: "b.ts", kind: "import" as const },
    { fromFile: "b.ts", toFile: "c.ts", kind: "import" as const },
    { fromFile: "c.ts", toFile: "d.ts", kind: "import" as const },
  ];
  const found = dependenciesWithinHops(edges, ["a.ts"], 2);
  assert.deepEqual(
    found.map((f) => `${f.path}@${f.hops}`),
    ["b.ts@1", "c.ts@2"]
  );
  // 씨앗은 다시 나오지 않는다 — 순환이 있어도 멈춘다.
  const cyclic = dependenciesWithinHops(
    [
      { fromFile: "a.ts", toFile: "b.ts", kind: "import" as const },
      { fromFile: "b.ts", toFile: "a.ts", kind: "import" as const },
    ],
    ["a.ts"],
    2
  );
  assert.deepEqual(cyclic.map((f) => f.path), ["b.ts"]);
});

test("같은 이름이 여러 파일에 있으면 정의로서 강한 쪽이 앞에 온다", () => {
  const symbols: SymbolEntry[] = [
    { id: "1", name: "run", kind: "export", filePath: "index.ts", startLine: 1, endLine: 1, language: "typescript" },
    { id: "2", name: "run", kind: "function", filePath: "impl.ts", startLine: 9, endLine: 9, language: "typescript" },
    { id: "3", name: "run", kind: "function", filePath: "impl.ts", startLine: 20, endLine: 20, language: "typescript" },
  ];
  const hits = symbolMatchFiles(symbols, "run");
  assert.deepEqual(hits.map((h) => h.path), ["impl.ts", "index.ts"]);
  // 같은 파일의 여러 정의는 **앵커로 합쳐진다**(15절 — 앵커는 근거가 아니라 위치다).
  assert.deepEqual(hits[0]?.anchorLines, [9, 20]);
  // 부분 일치는 하지 않는다 — 그러면 근거의 강도가 정규식과 같아진다(13.3절).
  assert.deepEqual(symbolMatchFiles(symbols, "ru"), []);
});

// ---- 선정: symbol-match / dependency가 실제 파일을 고른다 ----

/**
 * 그래프가 있는 작은 워크스페이스. **호출할 때마다 새로 만든다** — `contents`를 공유하면
 * 변경 도구를 쓰는 검사가 다음 검사의 입력을 바꿔 놓고, 그 오염은 "왜 이 검사만 순서에
 * 따라 다르지"로 나타난다.
 */
function graphWorkspace() {
  return structuredClone(GRAPH_WORKSPACE_TEMPLATE);
}

const GRAPH_WORKSPACE_TEMPLATE = {
  files: [
    { path: "src/entry.ts", isDir: false, sizeBytes: 120 },
    { path: "src/ledger.ts", isDir: false, sizeBytes: 120 },
    { path: "src/types.ts", isDir: false, sizeBytes: 60 },
    { path: "src/deep.ts", isDir: false, sizeBytes: 60 },
    { path: "src/unrelated.ts", isDir: false, sizeBytes: 40 },
    { path: "package.json", isDir: false, sizeBytes: 40 },
  ],
  contents: {
    "src/entry.ts": 'import { resolveBudget } from "./ledger.js";\nresolveBudget(1);\n',
    "src/ledger.ts": 'import type { Limit } from "./types.js";\nexport function resolveBudget(limit: Limit) {\n  return limit;\n}\n',
    "src/types.ts": 'import { deepThing } from "./deep.js";\nexport type Limit = number;\n',
    "src/deep.ts": "export const deepThing = 1;\n",
    "src/unrelated.ts": "export const other = 1;\n",
    "package.json": '{"scripts":{"test":"node --test"}}',
  },
  gitStatus: "## main",
};

test("symbol-match와 dependency가 1~2홉으로 실제 파일을 고른다", async () => {
  const host = new FakeHost(graphWorkspace());
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });
  const byPath = new Map(snapshot.relevantFiles.map((f) => [f.path, f]));

  // 정의가 있는 파일 — 파서가 안다.
  assert.equal(byPath.get("src/ledger.ts")?.reason, "symbol-match");
  // 1홉: 정의 파일이 import하는 타입 정의. 4절이 말한 "컴파일에 필요한 주변 맥락"이다.
  assert.equal(byPath.get("src/types.ts")?.reason, "dependency");
  assert.match(byPath.get("src/types.ts")?.reasonDetail ?? "", /1홉/);
  // 2홉까지 간다.
  assert.equal(byPath.get("src/deep.ts")?.reason, "dependency");
  assert.match(byPath.get("src/deep.ts")?.reasonDetail ?? "", /2홉/);
  // 그래프로 닿지 않는 파일은 들어오지 않는다.
  assert.ok(!byPath.has("src/unrelated.ts"), [...byPath.keys()].join(", "));
});

test("예산이 모자라면 dependency가 먼저 잘린다 — 4절 우선순위 그대로", async () => {
  const host = new FakeHost(graphWorkspace());
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });
  const reasons = snapshot.relevantFiles.map((f) => f.reason);
  const rank = ["project-meta", "mentioned", "symbol-match", "content-match", "recently-changed", "dependency"];
  const positions = reasons.map((r) => rank.indexOf(r));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `우선순위가 뒤섞였습니다: ${reasons.join(" > ")}`
  );
});

test("사용자가 이름을 댄 파일도 심볼의 줄 번호를 얻는다", async () => {
  // 15.2절이 고친 자리 — 근거는 먼저 것(`mentioned`)을 지키고 **앵커는 합친다.**
  const host = new FakeHost(graphWorkspace());
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const snapshot = await new ContextEngine().createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "src/ledger.ts 의 resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });
  const ledger = snapshot.relevantFiles.find((f) => f.path === "src/ledger.ts");
  assert.equal(ledger?.reason, "mentioned");
  assert.ok((ledger?.anchorLines ?? []).includes(2), `앵커가 없습니다: ${JSON.stringify(ledger?.anchorLines)}`);
});

// ---- 폴백: 심볼이 없어도 컨텍스트가 좁아지지 않는다 ----

test("범위 밖 언어는 content-match 폴백으로 여전히 선정된다", async () => {
  const host = new FakeHost({
    files: [
      { path: "cmd/main.go", isDir: false, sizeBytes: 80 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: {
      "cmd/main.go": "package main\n\nfunc resolveBudget(limit int) int {\n\treturn limit\n}\n",
      "package.json": '{"scripts":{"test":"node --test"}}',
    },
    gitStatus: "## main",
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();
  const snapshot = await engine.createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const go = snapshot.relevantFiles.find((f) => f.path === "cmd/main.go");
  assert.equal(go?.reason, "content-match", "범위 밖 언어의 폴백이 끊겼습니다");

  const index = await engine.ensureIndex(bridge, "ws-1");
  // **"심볼이 없다"가 아니라 "파서가 없다"로 적힌다.** 빈 배열로 뭉개면 두 사실이 같아진다.
  assert.equal(index.fileTree.find((f) => f.path === "cmd/main.go")?.symbolStatus, "unsupported-language");
});

test("파싱에 실패한 파일은 심볼을 잃되 인덱스에서 사라지지 않는다", async () => {
  // 6.1절이 미리 정해 둔 규칙. 고치는 중의 파일은 문법이 깨져 있는 것이 정상이다.
  const host = new FakeHost({
    files: [
      { path: "src/broken.ts", isDir: false, sizeBytes: 40 },
      { path: "src/ok.ts", isDir: false, sizeBytes: 40 },
      { path: "package.json", isDir: false, sizeBytes: 40 },
    ],
    contents: {
      "src/broken.ts": "export function half(a: number {\n  return a;\n",
      "src/ok.ts": "export function whole() {}\n",
      "package.json": "{}",
    },
    gitStatus: "## main",
  });
  const engine = new ContextEngine();
  const index = await engine.ensureIndex(new ToolBridge(host.asTransport(), "task-1"), "ws-1");

  const broken = index.fileTree.find((f) => f.path === "src/broken.ts");
  assert.ok(broken, "파싱에 실패했다고 파일이 인덱스에서 사라지면 안 됩니다");
  assert.equal(broken.symbolStatus, "parse-failed");
  assert.deepEqual(index.symbols.filter((s) => s.filePath === "src/broken.ts"), []);
  // 옆 파일은 멀쩡히 인덱싱된다 — 한 파일의 실패가 층 전체를 죽이지 않는다.
  assert.equal(index.fileTree.find((f) => f.path === "src/ok.ts")?.symbolStatus, "indexed");
  assert.equal(index.symbolIndex.filesParseFailed, 1);
});

// ---- grammar를 못 실었을 때: 폴백이지 침묵이 아니다 ----

const NO_GRAMMARS: GrammarSet = {
  parse: () => null,
  report: () => SUPPORTED_LANGUAGES.map((language) => ({ language, loaded: false, error: "테스트가 막았습니다" })),
  anyLoaded: () => false,
};

test("grammar를 못 실으면 그 사실이 스냅샷에 남는다", async () => {
  const host = new FakeHost(graphWorkspace());
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine({ grammars: NO_GRAMMARS });
  const snapshot = await engine.createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  const note = (snapshot.excludedNotes ?? []).find((n) => n.path.includes("symbol-index"));
  assert.ok(note, `grammar 적재 실패가 어디에도 남지 않았습니다: ${JSON.stringify(snapshot.excludedNotes)}`);
  assert.match(note.reason, /grammar를 싣지 못해/);
  assert.match(note.reason, /테스트가 막았습니다/);

  // **빈 symbol-match를 만들어 "구현했다"고 보이게 하지 않는다.**
  assert.ok(!snapshot.relevantFiles.some((f) => f.reason === "symbol-match"));
  assert.ok(!snapshot.relevantFiles.some((f) => f.reason === "dependency"));
  // 그래도 컨텍스트는 좁아지지 않는다 — 본문 검색이 같은 파일을 집는다.
  assert.equal(snapshot.relevantFiles.find((f) => f.path === "src/ledger.ts")?.reason, "content-match");

  const index = await engine.ensureIndex(bridge, "ws-1");
  assert.equal(index.fileTree.find((f) => f.path === "src/ledger.ts")?.symbolStatus, "grammar-unavailable");
});

test("그 언어의 파일이 없으면 grammar 실패를 알리지 않는다", async () => {
  // 잡음이 섞이면 정작 읽어야 할 줄이 안 읽힌다.
  const host = new FakeHost({
    files: [{ path: "README.md", isDir: false, sizeBytes: 20 }],
    contents: { "README.md": "# hi\n" },
    gitStatus: "## main",
  });
  const snapshot = await new ContextEngine({ grammars: NO_GRAMMARS }).createSnapshot(
    new ToolBridge(host.asTransport(), "task-1"),
    { workspaceId: "ws-1", userMessage: "무엇이든", tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }] }
  );
  assert.ok(!(snapshot.excludedNotes ?? []).some((n) => n.path.includes("symbol-index")));
});

// ---- 증분 갱신 (6절 표) ----

test("도구가 바꾼 파일만 다시 파싱해 심볼이 갱신된다", async () => {
  const host = new FakeHost({
    ...graphWorkspace(),
    mutationEffects: {
      "src/ledger.ts": 'import type { Limit } from "./types.js";\nexport function renamedBudget(limit: Limit) {\n  return limit;\n}\n',
    },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();
  const snapshot = await engine.createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });
  assert.ok((await engine.ensureIndex(bridge, "ws-1")).symbols.some((s) => s.name === "resolveBudget"));

  // 도구가 파일을 바꿨다 — FakeHost의 mutationEffects가 실제로 내용을 갈아끼운다.
  await bridge.execute("apply_patch", { path: "src/ledger.ts" });
  await engine.refreshSnapshot(bridge, snapshot, ["src/ledger.ts"]);

  const index = await engine.ensureIndex(bridge, "ws-1");
  // **낡은 심볼을 남기면 모델이 지금은 없는 함수를 "본다"**(6.1절).
  assert.ok(!index.symbols.some((s) => s.name === "resolveBudget"), "지워진 함수의 심볼이 남았습니다");
  assert.ok(index.symbols.some((s) => s.name === "renamedBudget"), "새 함수의 심볼이 들어오지 않았습니다");
  // 건드리지 않은 파일의 심볼은 그대로다 — 그게 증분이다.
  assert.ok(index.symbols.some((s) => s.filePath === "src/deep.ts"));
});

test("고치는 중의 깨진 파일은 심볼만 잃는다", async () => {
  const host = new FakeHost({
    ...graphWorkspace(),
    mutationEffects: { "src/ledger.ts": "export function resolveBudget(limit: Limit {\n" },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();
  const snapshot = await engine.createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });

  await bridge.execute("apply_patch", { path: "src/ledger.ts" });
  const refreshed = await engine.refreshSnapshot(bridge, snapshot, ["src/ledger.ts"]);
  const index = await engine.ensureIndex(bridge, "ws-1");

  assert.equal(index.fileTree.find((f) => f.path === "src/ledger.ts")?.symbolStatus, "parse-failed");
  assert.deepEqual(index.symbols.filter((s) => s.filePath === "src/ledger.ts"), []);
  // 파일은 사라지지 않고, 깨진 내용 그대로 스냅샷에 실린다(6.1절 "깨진 중간 상태를 감추지 않는다").
  assert.ok(index.fileTree.some((f) => f.path === "src/ledger.ts"));
  assert.ok(refreshed.snapshot.relevantFiles.some((f) => f.path === "src/ledger.ts"));
});

/**
 * 6절 표 2행 — 도구를 거치지 않은 편집을 다음 인덱스가 잡는가.
 *
 * **읽은 파일 수를 함께 센다.** 심볼이 맞는지만 보면 전체 재구축도 통과하고, 그러면 이
 * 검사는 "증분"에 대해 아무것도 말하지 않는다.
 */
test("지문이 바뀌면 바뀐 파일만 다시 파싱한다", async () => {
  const workspace = graphWorkspace();
  const host = new FakeHost(workspace);
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();
  await engine.ensureIndex(bridge, "ws-1");

  // 외부 편집: 내용과 크기가 함께 바뀐다.
  workspace.contents["src/ledger.ts"] =
    'import type { Limit } from "./types.js";\nexport function externallyRenamed(limit: Limit) {\n  return limit;\n}\n';
  workspace.files.find((f) => f.path === "src/ledger.ts")!.sizeBytes =
    workspace.contents["src/ledger.ts"].length;
  host.setIndexFingerprint("sha256:changed");

  const before = host.toolRequests.length;
  const index = await engine.ensureIndex(bridge, "ws-1");
  const reread = host.toolRequests
    .slice(before)
    .filter((r) => r.tool === "read_file")
    .map((r) => String(r.args.path));

  assert.ok(index.symbols.some((s) => s.name === "externallyRenamed"), "외부 편집이 반영되지 않았습니다");
  assert.ok(!index.symbols.some((s) => s.name === "resolveBudget"), "옛 심볼이 남았습니다");
  // **안 바뀐 소스 파일은 다시 읽지 않는다.** 이게 증분이라는 말의 내용이다.
  assert.ok(!reread.includes("src/deep.ts"), `증분이 아니라 전체를 다시 읽었습니다: ${reread.join(", ")}`);
  assert.ok(reread.includes("src/ledger.ts"), reread.join(", "));
  // 안 바뀐 파일의 심볼은 그대로 살아 있다 — 지우고 다시 만든 것이 아니다.
  assert.ok(index.symbols.some((s) => s.filePath === "src/deep.ts"));
});

test("크기가 그대로인 편집은 git status가 잡는다", async () => {
  // 한 글자 교체는 `list_files`의 크기 비교로는 보이지 않는다. 두 신호를 함께 쓰는 이유다.
  const workspace = graphWorkspace();
  const host = new FakeHost(workspace);
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();
  await engine.ensureIndex(bridge, "ws-1");

  const original = workspace.contents["src/ledger.ts"];
  const edited = original.replace("resolveBudget", "resolveBudgeT");
  assert.equal(edited.length, original.length, "이 검사는 길이가 같아야 성립합니다");
  workspace.contents["src/ledger.ts"] = edited;
  workspace.gitStatus = "## main\n M src/ledger.ts";
  host.setIndexFingerprint("sha256:dirty");

  const index = await engine.ensureIndex(bridge, "ws-1");
  assert.ok(index.symbols.some((s) => s.name === "resolveBudgeT"), "더러운 파일을 다시 읽지 않았습니다");
});

test("바뀐 파일이 상한을 넘으면 전체 재구축으로 간다", async () => {
  // 6절 표 3행. 증분의 이득은 "안 바뀐 것을 다시 안 한다"인데, 대부분이 바뀌었으면 그 이득이
  // 없고 옛 인덱스를 들고 다니는 복잡도만 남는다.
  const workspace = graphWorkspace();
  const host = new FakeHost(workspace);
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine({ maxIncrementalFiles: 1 });
  await engine.ensureIndex(bridge, "ws-1");

  for (const path of ["src/ledger.ts", "src/types.ts"] as const) {
    workspace.contents[path] += "\nexport const added = 1;\n";
    workspace.files.find((f) => f.path === path)!.sizeBytes = workspace.contents[path].length;
  }
  host.setIndexFingerprint("sha256:many");

  const before = host.toolRequests.length;
  await engine.ensureIndex(bridge, "ws-1");
  const reread = host.toolRequests
    .slice(before)
    .filter((r) => r.tool === "read_file")
    .map((r) => String(r.args.path));
  assert.ok(reread.includes("src/deep.ts"), `상한을 넘었는데 증분으로 돌았습니다: ${reread.join(", ")}`);
});

test("삭제된 파일의 심볼과 엣지는 인덱스에서 빠진다", async () => {
  const host = new FakeHost({
    ...graphWorkspace(),
    mutationEffects: { "src/types.ts": null },
  });
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const engine = new ContextEngine();
  const snapshot = await engine.createSnapshot(bridge, {
    workspaceId: "ws-1",
    userMessage: "resolveBudget 이 음수를 받으면 터집니다",
    tokenBudgets: [{ modelId: "fake-executor", maxTokens: 50_000 }],
  });
  await bridge.execute("delete_file", { path: "src/types.ts" });
  await engine.refreshSnapshot(bridge, snapshot, ["src/types.ts"]);

  const index = await engine.ensureIndex(bridge, "ws-1");
  assert.ok(!index.symbols.some((s) => s.filePath === "src/types.ts"));
  assert.ok(!index.dependencyEdges.some((e) => e.toFile === "src/types.ts" || e.fromFile === "src/types.ts"));
});

// ---- 캐시 (2.1절) ----

test("심볼 층이 없던 캐시 행은 없는 것으로 다룬다", async () => {
  const host = new FakeHost(graphWorkspace());
  const bridge = new ToolBridge(host.asTransport(), "task-1");
  const built = await new ContextEngine().ensureIndex(bridge, "ws-1");
  assert.equal(built.symbolIndex.version, SYMBOL_INDEX_VERSION);

  // 앱을 업데이트하기 전의 행을 흉내낸다.
  const legacy = { ...built } as Record<string, unknown>;
  delete legacy.symbolIndex;
  await bridge.saveCachedIndex("sha256:fake", legacy, 1);

  const engine = new ContextEngine();
  const reloaded = await engine.ensureIndex(bridge, "ws-1");
  // 모양이 다르면 다시 만든다 — 그러지 않으면 `symbolStatus`가 없는 파일들이 조용히 생긴다.
  assert.equal(reloaded.symbolIndex.version, SYMBOL_INDEX_VERSION);
  assert.ok(reloaded.fileTree.every((f) => typeof f.symbolStatus === "string"));
});

// ---- 신뢰 경계 ----

test("grammar 경로는 워크스페이스가 아니라 우리 패키지에서 온다", () => {
  // 원칙 2가 막는 것은 **사용자 워크스페이스**에 대한 직접 접근이다. grammar wasm은 우리
  // 프로그램의 일부이고, 그 사실이 경로로 확인돼야 한다 — 워크스페이스에서 유도한 경로가
  // 여기 들어오면 신뢰 경계에 구멍이 생긴 것이다.
  // npm workspaces가 의존성을 루트로 끌어올리므로 기준은 **저장소 루트**다
  // (`packages/sidecar/node_modules`가 아니다).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..", "..");
  for (const grammar of ["typescript", "tsx", "javascript", "python", "rust"] as const) {
    const resolved = resolveGrammarPath(grammar);
    assert.ok(
      resolved.includes(`node_modules${path.sep}tree-sitter-wasms`),
      `grammar가 예상 밖의 곳에서 옵니다: ${resolved}`
    );
    assert.ok(path.isAbsolute(resolved));
    assert.ok(!path.relative(repoRoot, resolved).startsWith(".."), `저장소 밖입니다: ${resolved}`);
  }
});

test("Context Engine 소스는 grammar 파일을 스스로 읽지 않는다", () => {
  // `Language.load(경로)`가 파일을 여는 것은 라이브러리의 일이다. 우리 소스가 그 파일을
  // 직접 읽기 시작하면 `boundary.test.ts`가 잡겠지만, **왜 그것이 규칙인지**는 여기에 적어
  // 둔다: 편의를 위해 fs를 들이는 첫걸음이 언제나 "우리 파일 하나만 읽으면 되는데"이다.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.resolve(here, "..", "..", "src", "context", "treeSitter.ts"), "utf8");
  assert.ok(!/readFile|node:fs/.test(source.replace(/^\s*\*.*$/gm, "")), "treeSitter.ts가 파일을 직접 읽습니다");
});

// ---- grammar가 실제로 실린다 (이 검사가 없으면 위 검사들이 폴백만 검사할 수 있다) ----

test("MVP 3개 언어의 grammar가 실제로 실린다", async () => {
  const grammars = await loadGrammars();
  const report = grammars.report();
  const failed = report.filter((entry) => !entry.loaded);
  assert.deepEqual(failed, [], `grammar 적재 실패: ${JSON.stringify(failed)}`);
  assert.equal(grammarForPath("a.tsx"), "tsx");
  assert.equal(grammarForPath("a.ts"), "typescript");
  assert.equal(grammarForPath("a.go"), null);
});
