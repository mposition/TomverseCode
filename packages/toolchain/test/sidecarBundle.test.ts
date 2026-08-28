import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_DIR,
  DEFAULT_STAGE_ROOT_REL,
  ENTRY_FILE,
  MANIFEST_FILE,
  RUNTIME_LICENSE_FILE,
  artifactFor,
  artifactKeyFor,
  normalizeFingerprint,
  readPin,
  readSigningKeys,
  requiredBundleFiles,
  runtimeFileName,
} from "@tomverse/toolchain/node-runtime";
import {
  PRUNED_EXTENSIONS,
  SELF_PACKAGE,
  bundlePackageJson,
  packageNameFromPath,
  planSidecarStage,
  shouldPrune,
  splitPath,
} from "@tomverse/toolchain/sidecar-stage";

/**
 * **sidecar 동봉의 Linux에서 확인 가능한 절반.**
 *
 * 동봉이 틀리는 방식은 대부분 조용하다 — 설치본은 나오고, 앱은 뜨고, 개발 머신에는 PATH에
 * node가 있으므로 아무 일도 없는 것처럼 보인다. 배포된 머신에서만 다르게 죽는다.
 * 그래서 여기서 지키는 것은 **세 파일 사이의 합의**다:
 *
 * - `launcher.rs`(찾는 쪽) ↔ `js/nodeRuntime.mjs`(넣는 쪽)의 레이아웃
 * - `js/nodeRuntime.mjs`(스테이징 자리) ↔ `tauri.conf.json`(집어가는 자리)
 * - `node-runtime.json`(핀) ↔ `node-signing-keys.json`(그 핀을 만든 서명자)
 *
 * 실제로 번들을 만드는 것(다운로드·복사·설치본)은 Windows에서만 확인된다 —
 * docs/design/windows-landing-record.md 14절.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LAUNCHER_RS = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "core", "src", "launcher.rs");
const TAURI_CONF = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json");
const TREE_SITTER_TS = path.join(REPO_ROOT, "packages", "sidecar", "src", "context", "treeSitter.ts");

function launcherSource(): string {
  const source = readFileSync(LAUNCHER_RS, "utf8");
  assert.ok(source.length > 0, `${LAUNCHER_RS}가 비었습니다`);
  return source;
}

/** needle을 런타임에 조립한다 — 상수 이름을 그대로 적으면 이 파일 자신이 검색 대상이 될 때
 *  개수가 어긋난다(CLAUDE.md 함정 기록). */
function rustStrConst(source: string, name: string): string {
  const needle = new RegExp(`${name}: &str = "([^"]*)"`);
  const match = needle.exec(source);
  assert.ok(match, `launcher.rs에서 ${name}를 찾지 못했습니다 — 이름이 바뀌었습니까?`);
  return match[1];
}

// ---- 1. 찾는 쪽과 넣는 쪽의 레이아웃이 같은가 ----

test("번들 디렉터리와 진입점 이름이 launcher.rs와 같다", () => {
  const source = launcherSource();
  assert.equal(rustStrConst(source, "BUNDLE_" + "DIR"), BUNDLE_DIR);
  assert.equal(rustStrConst(source, "ENTRY_" + "FILE"), ENTRY_FILE);
});

/**
 * `.exe` 접미사는 **대상 플랫폼**을 따라야 한다. 뒤집히면 Windows 번들이 `node`라는 이름을
 * 만들고, launcher는 `node.exe`를 찾다 못 찾아 **조용히 PATH로 떨어진다.**
 */
test("런타임 파일 이름 규칙이 launcher.rs와 같다", () => {
  const source = launcherSource();
  const fn = /fn runtime_file_name\(windows: bool\) -> &'static str \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(fn, "launcher.rs에서 runtime_file_name을 찾지 못했습니다");
  const names = [...fn[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, [runtimeFileName(true), runtimeFileName(false)], "Windows/비Windows 순서와 값이 같아야 합니다");
});

// ---- 2. 스테이징 자리와 tauri가 집어가는 자리가 같은가 ----

/**
 * 이 둘이 갈라지면 **sidecar 없는 설치본**이 나온다. 그리고 그 빌드는 통과한다 —
 * `bundle.resources`가 없는 경로를 가리켜도 tauri는 대개 조용하고, 나온 앱은 개발 머신에서
 * PATH의 node로 잘 뜬다. 5절이 기록한 상태가 정확히 이것이었다.
 */
test("tauri.conf.json이 스테이징 디렉터리를 실행 파일 옆 sidecar로 집어간다", () => {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8")) as {
    bundle?: { resources?: Record<string, string> };
  };
  const resources = conf.bundle?.resources;
  assert.ok(resources, "tauri.conf.json에 bundle.resources가 없습니다 — 그러면 번들에 sidecar가 들어가지 않습니다");

  // tauri.conf.json의 경로는 그 파일이 있는 디렉터리 기준이다.
  const confDir = path.dirname(TAURI_CONF);
  const entries = Object.entries(resources);
  const staged = entries.find(([, to]) => to.split(/[\\/]/).filter(Boolean).join("/") === BUNDLE_DIR);
  assert.ok(staged, `bundle.resources에 ${BUNDLE_DIR}로 놓이는 항목이 없습니다: ${JSON.stringify(resources)}`);

  const from = path.resolve(confDir, staged[0]);
  const expected = path.resolve(REPO_ROOT, ...DEFAULT_STAGE_ROOT_REL.split("/"), BUNDLE_DIR);
  assert.equal(
    from,
    expected,
    `tauri가 집어가는 자리(${from})와 스테이징이 만드는 자리(${expected})가 다릅니다`
  );
});

/** 스테이징 산출물은 커밋되지 않아야 한다 — node.exe 약 90 MiB가 저장소에 들어간다. */
test("스테이징 디렉터리와 런타임 캐시가 .gitignore에 있다", () => {
  const ignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  const lines = ignore.split(/\r?\n/).map((l) => l.trim());
  assert.ok(
    lines.some((l) => l === `${DEFAULT_STAGE_ROOT_REL}/` || l === DEFAULT_STAGE_ROOT_REL),
    `.gitignore에 ${DEFAULT_STAGE_ROOT_REL}가 없습니다`
  );
  assert.ok(lines.includes(".cache/"), ".gitignore에 .cache/가 없습니다");
});

// ---- 3. 핀 ----

test("핀 파일이 읽히고 모양이 맞다", () => {
  const pin = readPin();
  assert.match(pin.version, /^v\d+\.\d+\.\d+$/);
  assert.ok(Object.keys(pin.artifacts).length >= 1);
  for (const [key, artifact] of Object.entries(pin.artifacts) as [string, { sha256: string; url: string }][]) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `${key}의 sha256`);
    assert.ok(artifact.url.startsWith("https://"), `${key}의 url이 https가 아닙니다`);
  }
});

/**
 * **싣는 버전이 요구 버전보다 낮으면 그건 결함이다.**
 *
 * 반대(싣는 것이 더 높다)는 정상이다 — 요구는 하한이고, 개발 머신의 런타임이 배포본보다
 * 낮아도 개발은 돌아야 한다. 그래서 두 값을 같게 만들지 않고 **한 방향만** 막는다.
 * (`nodeVersion.test.ts`가 요구 쪽 두 선언이 같은지를 따로 지킨다.)
 */
test("동봉하는 Node가 sidecar가 요구하는 최소 버전 이상이다", () => {
  const pin = readPin();
  const bundled = Number(pin.version.replace(/^v/, "").split(".")[0]);
  const needle = new RegExp("MIN_NODE_" + "MAJOR" + ": u32 = ([0-9]+);");
  const match = needle.exec(launcherSource());
  assert.ok(match, "launcher.rs에서 최소 버전 상수를 찾지 못했습니다");
  const required = Number(match[1]);
  assert.ok(Number.isInteger(bundled) && bundled > 0, `핀 버전을 읽지 못했습니다: ${pin.version}`);
  assert.ok(
    bundled >= required,
    `동봉 런타임이 Node ${bundled}인데 sidecar는 ${required} 이상을 요구합니다 — 설치본이 조용히 죽습니다`
  );
});

/** 핀을 만든 서명자가 allowlist에 있어야 한다. 없으면 그 핀의 출처가 확인되지 않은 것이다. */
test("핀의 서명 키가 allowlist에 있다", () => {
  const pin = readPin();
  const allowlist = readSigningKeys();
  const fingerprint = normalizeFingerprint(pin.provenance.signingKeyFingerprint);
  assert.ok(
    allowlist.keys.some((k: { fingerprint: string }) => k.fingerprint === fingerprint),
    `핀의 서명자 ${fingerprint}가 node-signing-keys.json에 없습니다`
  );
});

test("모르는 아키텍처를 조용히 x64로 떨어뜨리지 않는다", () => {
  assert.equal(artifactKeyFor("win32", "x64").ok, true);
  assert.equal(artifactKeyFor("win32", "arm64").ok, true);
  assert.equal(artifactKeyFor("win32", "ia32").ok, false);
  assert.equal(artifactKeyFor("linux", "x64").ok, false);
  assert.throws(() => artifactFor(readPin(), "win32", "ia32"), /아키텍처/);
});

// ---- 4. 스테이징 계획 ----

/**
 * 가짜 저장소 루트. **`path.join("C:", "repo")`로 만들지 않는다** — Windows에서 그건
 * `C:repo`(드라이브 상대 경로)가 되어 절대 경로가 아니고, `path.relative`가 다른 답을 낸다.
 * 실행 중인 OS의 규칙으로 절대 경로를 만드는 방법은 이것뿐이다(CLAUDE.md: `std::path`/`path`는
 * 실행 중인 OS의 구분자만 안다).
 */
const FAKE_ROOT = path.resolve(path.sep, "tomverse-plan-fixture");

const PLAN_INPUT = {
  repoRoot: FAKE_ROOT,
  stageRoot: path.join(FAKE_ROOT, "stage"),
  windows: true,
  sidecarDistDir: path.join(FAKE_ROOT, "packages", "sidecar", "dist", "src"),
  grammarWasmFiles: ["tree-sitter-typescript.wasm", "tree-sitter-rust.wasm"],
};

function planWith(depPaths: string[]) {
  return planSidecarStage({ ...PLAN_INPUT, depPaths });
}

test("진입점이 번들 루트에 놓인다", () => {
  const plan = planWith([]);
  const sidecar = plan.copies.find((c: { what: string }) => c.what === "sidecar");
  assert.ok(sidecar);
  assert.equal(sidecar.to, plan.bundleDir);
  assert.ok(plan.required.includes(path.join(plan.bundleDir, ENTRY_FILE)));
  assert.ok(plan.required.includes(path.join(plan.bundleDir, "node.exe")));
  assert.ok(plan.required.includes(path.join(plan.bundleDir, MANIFEST_FILE)));
  assert.ok(plan.required.includes(path.join(plan.bundleDir, RUNTIME_LICENSE_FILE)));
  // ESM 앵커. 없으면 Node가 .js를 CommonJS로 읽어 진입점 첫 줄에서 죽는다.
  assert.ok(plan.required.includes(path.join(plan.bundleDir, "package.json")));
});

test("우리 자신은 node_modules에 다시 들어가지 않는다", () => {
  const self = path.join(FAKE_ROOT, "node_modules", "@tomverse", "sidecar");
  const plan = planWith([self]);
  assert.ok(!plan.copies.some((c: { what: string }) => c.what === SELF_PACKAGE));
  assert.ok(plan.skipped.some((s: { path: string }) => s.path === self));
});

test("의존성은 저장소 루트 기준 상대 경로를 그대로 보존한다 — 중첩 node_modules 포함", () => {
  const nested = path.join(FAKE_ROOT, "node_modules", "openai", "node_modules", "ws");
  const plan = planWith([path.join(FAKE_ROOT, "node_modules", "openai"), nested]);
  const targets = plan.copies.map((c: { to: string }) => c.to);
  assert.ok(targets.includes(path.join(plan.bundleDir, "node_modules", "openai")));
  assert.ok(
    targets.includes(path.join(plan.bundleDir, "node_modules", "openai", "node_modules", "ws")),
    "중첩을 평탄화하면 두 버전이 한 자리를 다투고 복사 순서가 승자를 정합니다"
  );
});

/**
 * grammar만 골라 담는 규칙은 **sidecar가 준 목록 그대로**여야 한다.
 * 여기서 목록을 다시 만들면 갈라지고, 갈라진 결과는 오류가 아니라 조용한 성능 저하다.
 */
test("tree-sitter-wasms는 넘겨받은 grammar만 담는다", () => {
  const plan = planWith([path.join(FAKE_ROOT, "node_modules", "tree-sitter-wasms")]);
  const copy = plan.copies.find((c: { what: string }) => c.what === "tree-sitter-wasms");
  assert.ok(copy);
  assert.deepEqual(copy.prune.keepOnly, [
    "out/tree-sitter-typescript.wasm",
    "out/tree-sitter-rust.wasm",
  ]);
  for (const file of PLAN_INPUT.grammarWasmFiles) {
    assert.ok(
      plan.required.includes(path.join(plan.bundleDir, "node_modules", "tree-sitter-wasms", "out", file)),
      `${file}이 필수 목록에 없습니다`
    );
  }
});

test("다른 패키지는 전부 담는다 (keepOnly 없음)", () => {
  const plan = planWith([path.join(FAKE_ROOT, "node_modules", "openai")]);
  const copy = plan.copies.find((c: { what: string }) => c.what === "openai");
  assert.ok(copy);
  assert.equal(copy.prune.keepOnly, null);
});

/** 빈 목록으로 계획하면 grammar가 통째로 빠진 번들이 **조용히** 만들어진다. */
test("grammar 목록이 비면 계획을 만들지 않는다", () => {
  assert.throws(() => planSidecarStage({ ...PLAN_INPUT, depPaths: [], grammarWasmFiles: [] }), /grammar/);
});

test("저장소 밖의 의존성은 담지 않고 이유를 남긴다", () => {
  const outside = path.resolve(path.sep, "elsewhere", "node_modules", "evil");
  const plan = planWith([outside]);
  assert.ok(!plan.copies.some((c: { from: string }) => c.from === outside));
  assert.ok(plan.skipped.some((s: { path: string }) => s.path === outside));
});

/**
 * **회귀** — 경로를 나누는 규칙이 Windows 구분자를 놓치면 번들이 조용히 빈다.
 *
 * 실제로 겪었다: 문자 클래스의 `\\`가 한 겹 벗겨져 `/[\/]/`가 되자 `\`로 이어진 경로가
 * 하나도 나뉘지 않았고, 그래서 **모든 의존성이 "node_modules 아래가 아니다"로 걸러졌다.**
 * 계획은 성공을 돌려주고 복사할 것만 0개가 되므로, 이 층에서 잡지 않으면 증상이
 * "설치본에 node_modules가 없다"로만 나타난다.
 */
test("경로를 나눌 때 Windows 구분자와 POSIX 구분자를 모두 받는다", () => {
  assert.deepEqual(splitPath("node_modules/openai"), ["node_modules", "openai"]);
  assert.deepEqual(splitPath("node_modules\\openai"), ["node_modules", "openai"]);
  assert.deepEqual(splitPath("a\\b/c"), ["a", "b", "c"]);
  assert.deepEqual(splitPath(""), []);
});

/** 위 결함이 계획 층에 어떻게 나타나는지 — 이 각도에서도 한 번 잡는다. */
test("Windows 구분자로 온 의존성이 조용히 사라지지 않는다", () => {
  const plan = planSidecarStage({
    ...PLAN_INPUT,
    repoRoot: "C:\\repo",
    stageRoot: "C:\\repo\\stage",
    depPaths: ["C:\\repo\\node_modules\\openai"],
  });
  assert.ok(
    plan.copies.some((c: { what: string }) => c.what === "openai"),
    `Windows 경로가 걸러졌습니다: ${JSON.stringify(plan.skipped)}`
  );
});

test("스코프 패키지 이름을 두 조각으로 읽는다", () => {
  const root = FAKE_ROOT;
  assert.equal(packageNameFromPath(root, path.join(root, "node_modules", "@babel", "runtime")), "@babel/runtime");
  assert.equal(packageNameFromPath(root, path.join(root, "node_modules", "openai")), "openai");
  assert.equal(packageNameFromPath(root, root), null);
});

// ---- 5. 잘라내기 ----

/**
 * 런타임이 여는 확장자를 잘라내면 배포된 뒤에야 드러난다. `.wasm`이 특히 중요하다 —
 * grammar가 그것이고, 빠져도 오류가 아니라 조용한 저하다.
 */
test("런타임이 여는 확장자는 잘라내지 않는다", () => {
  for (const keep of ["index.js", "a.mjs", "a.cjs", "package.json", "g.wasm", "n.node", "LICENSE"]) {
    assert.equal(shouldPrune(keep), false, `${keep}을 잘라내고 있습니다`);
  }
  for (const drop of ["index.js.map", "index.d.ts", "a.ts", "b.tsx", "c.mts", "d.cts"]) {
    assert.equal(shouldPrune(drop), true, `${drop}이 남고 있습니다`);
  }
  assert.ok(PRUNED_EXTENSIONS.includes(".map"));
});

test("번들 package.json이 ESM을 선언한다", () => {
  const pkg = bundlePackageJson("v24.0.0");
  assert.equal(pkg.type, "module", "type이 module이 아니면 진입점의 import 첫 줄에서 죽습니다");
  assert.equal(pkg.main, `./${ENTRY_FILE}`);
});

// ---- 6. grammar 목록의 단일 출처 ----

/**
 * 스테이징은 grammar 목록을 sidecar에서 **읽는다.** 그 export가 사라지면 스테이징이
 * 죽는데, 그 실패는 Windows 번들 빌드에서만 나온다. 여기서 소스로 먼저 잡는다.
 */
test("sidecar가 grammar 파일 목록을 export한다", () => {
  const source = readFileSync(TREE_SITTER_TS, "utf8");
  assert.match(
    source,
    new RegExp("export const WASM_" + "BASENAME"),
    "treeSitter.ts가 grammar 목록을 export하지 않으면 스테이징이 목록을 복사해 두게 됩니다"
  );
});

test("필수 파일 목록이 플랫폼을 따른다", () => {
  assert.ok(requiredBundleFiles(true).includes("node.exe"));
  assert.ok(requiredBundleFiles(false).includes("node"));
  assert.ok(requiredBundleFiles(true).includes(MANIFEST_FILE));
});
