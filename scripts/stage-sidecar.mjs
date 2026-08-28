/**
 * 동봉 sidecar 번들을 **스테이징**한다 — `tauri build`가 집어갈 디렉터리를 만든다.
 *
 * ```text
 * <stage>/sidecar/
 *   node.exe        ← 핀된 해시와 일치하는 공식 배포본
 *   node.LICENSE    ← 그 런타임의 라이선스
 *   index.js        ← sidecar 진입점 (dist/src/index.js)
 *   <dist/src 트리>
 *   package.json    ← {"type":"module"} — 없으면 진입점 첫 줄에서 죽는다
 *   node_modules/   ← production 의존성만
 *   manifest.json   ← 무엇이 들어갔는지. 착지 검사가 이걸 읽어 다시 해싱한다
 * ```
 *
 * # 왜 `beforeBundleCommand`가 아니라 별도 명령인가
 *
 * tauri 설정 안의 훅으로 두면 **스테이징만 따로 돌려볼 수 없다** — 확인하려면 GUI
 * 라이브러리가 있는 Windows에서 번들 빌드 전체를 태워야 하고, 그러면 이 로직은 개발
 * 환경에서 한 번도 실행되지 않는 코드가 된다. 이 저장소는 그 사고를 이미 겪었다
 * (껍데기 크레이트가 32개 오류로 굳어 있었던 일 — 아무도 컴파일하지 않았기 때문이다).
 *
 * # 무엇을 검증하는가
 *
 * 1. **핀된 sha256과 정확히 일치**하는 node.exe만 넣는다. 다르면 캐시를 지우고 실패한다.
 * 2. production 의존성 목록을 **npm에서 유도**한다. 손으로 적은 목록은 의존성이 늘 때 빠진다.
 * 3. grammar 목록을 **sidecar 자신에게서 읽는다**. 여기 또 적으면 갈라진다.
 * 4. 스테이징이 끝나면 그 트리로 sidecar를 **실제로 띄워** ready 왕복을 받는다 —
 *    잘라내기가 지나쳤는지는 이때만 드러난다.
 *
 * 근거: docs/design/process-architecture.md 10.6절.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_STAGE_ROOT_REL,
  ENTRY_FILE,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  RUNTIME_LICENSE_FILE,
  artifactFor,
  readPin,
  runtimeFileName,
} from "@tomverse/toolchain/node-runtime";
import {
  PRUNED_EXTENSIONS,
  bundlePackageJson,
  planSidecarStage,
  shouldPrune,
} from "@tomverse/toolchain/sidecar-stage";

// `new URL(import.meta.url).pathname`은 Windows에서 `/C:/...`가 된다(CLAUDE.md 함정 기록).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`[stage-sidecar] ${message}`);
  process.exit(1);
}
function log(message) {
  console.log(`[stage-sidecar] ${message}`);
}

// ---- 인자 ----

function parseArgs(argv) {
  const args = {
    stageRoot: path.join(REPO_ROOT, ...DEFAULT_STAGE_ROOT_REL.split("/")),
    targetArch: process.arch,
    targetPlatform: process.platform,
    smoke: true,
    offline: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) fail(`${arg}에 값이 필요합니다`);
      i += 1;
      return v;
    };
    if (arg === "--stage-root") args.stageRoot = path.resolve(value());
    else if (arg === "--target-arch") args.targetArch = value();
    else if (arg === "--target-platform") args.targetPlatform = value();
    else if (arg === "--no-smoke") args.smoke = false;
    else if (arg === "--offline") args.offline = true;
    else fail(`알 수 없는 인자: ${arg}`);
  }
  return args;
}

// ---- 해시와 캐시 ----

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const CACHE_DIR = path.join(REPO_ROOT, ".cache", "node-runtime");

/**
 * 내용 주소 캐시. 파일 이름에 해시가 들어가므로 **다른 내용이 같은 이름을 차지할 수 없다.**
 * 버전만으로 이름 짓고 캐시를 재사용하면, 핀을 바꾼 뒤에도 옛 바이너리가 조용히 재사용된다.
 */
function cachePathFor(stamp, suffix) {
  return path.join(CACHE_DIR, `${stamp}${suffix}`);
}

async function download(url, destination) {
  log(`받는 중: ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return bytes.length;
}

/**
 * 핀된 해시와 **정확히 일치하는** 바이트를 돌려준다.
 *
 * 일치하지 않으면 받은 파일을 **지우고** 실패한다. 남겨두면 다음 실행이 그것을 캐시로
 * 재사용해 같은 실패를 반복하거나, 더 나쁘게는 사람이 핀을 바꿔서 "고친다".
 */
async function ensurePinnedRuntime(artifact, offline) {
  const cached = cachePathFor(artifact.sha256, ".exe");
  if (fs.existsSync(cached)) {
    const actual = sha256File(cached);
    if (actual === artifact.sha256) {
      log(`캐시 적중: ${cached}`);
      return cached;
    }
    // 이름이 해시인데 내용이 다르다 — 디스크 손상이거나 누가 손댔다.
    fs.rmSync(cached, { force: true });
    log(`캐시가 손상되어 버립니다 (기대 ${artifact.sha256} / 실제 ${actual})`);
  }
  if (offline) throw new Error(`--offline인데 캐시에 런타임이 없습니다: ${cached}`);

  const temp = `${cached}.partial`;
  const size = await download(artifact.url, temp);
  const actual = sha256File(temp);
  if (actual !== artifact.sha256) {
    fs.rmSync(temp, { force: true });
    throw new Error(
      "받은 런타임의 sha256이 핀과 다릅니다.\n" +
        `  url  : ${artifact.url}\n` +
        `  기대 : ${artifact.sha256}\n` +
        `  실제 : ${actual}\n` +
        "핀을 실제 값으로 고쳐서 이 검사를 통과시키지 말 것 — " +
        "핀은 'nodejs.org가 지금 주는 것'이 아니라 '우리가 서명으로 확인한 것'이다.\n" +
        "버전을 올리려면: npm run node-runtime:pin -- --version <vX.Y.Z> --write"
    );
  }
  fs.renameSync(temp, cached);
  log(`검증됨: ${artifact.sha256} (${(size / 1048576).toFixed(1)} MiB)`);
  return cached;
}

/**
 * 런타임 라이선스. **해시를 핀하지 않는다** — 태그된 URL이라 내용이 고정이지만 그 사실이
 * 서명으로 보증되지는 않는다. 대신 받은 것의 해시를 manifest에 적어 무엇을 실었는지 남긴다.
 * 라이선스는 실행되는 코드가 아니므로 공급망 위협 모델이 다르다.
 */
async function ensureLicense(pin, offline) {
  const stamp = createHash("sha256").update(pin.licenseUrl).digest("hex").slice(0, 16);
  const cached = cachePathFor(stamp, ".LICENSE");
  if (!fs.existsSync(cached)) {
    if (offline) throw new Error(`--offline인데 캐시에 라이선스가 없습니다: ${cached}`);
    await download(pin.licenseUrl, cached);
  }
  if (fs.statSync(cached).size === 0) throw new Error(`라이선스가 비어 있습니다: ${cached}`);
  return cached;
}

// ---- 복사 ----

/** `keepOnly`가 있으면 그 목록 + **패키지 최상위 파일**만 담는다(package.json·LICENSE 등). */
function keeps(relPosix, keepOnly) {
  if (keepOnly === null) return true;
  if (!relPosix.includes("/")) return true;
  return keepOnly.includes(relPosix);
}

function copyTree(from, to, prune, stats) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    // 워크스페이스 패키지는 심볼릭 링크다. **따라가서 실물을 복사한다** — 링크를 그대로
    // 두면 설치본 안에서 존재하지 않는 개발 트리를 가리킨다. (`statSync`가 따라간다.)
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      // 의존성 안의 중첩 node_modules는 npm ls가 따로 항목으로 준다. 여기서 통째로
      // 따라가면 같은 트리를 두 번 복사한다.
      if (entry.name === "node_modules") {
        stats.skippedNested += 1;
        continue;
      }
      copyTree(source, target, prune, stats);
      continue;
    }
    const relPosix = path.relative(prune.root, source).split(path.sep).join("/");
    if (shouldPrune(entry.name) || !keeps(relPosix, prune.keepOnly)) {
      stats.pruned += 1;
      stats.prunedBytes += stat.size;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    stats.files += 1;
    stats.bytes += stat.size;
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    const stat = fs.statSync(p);
    total += stat.isDirectory() ? dirSize(p) : stat.size;
  }
  return total;
}

// ---- 입력 수집 ----

/**
 * Windows의 `npm`은 `npm.exe`가 아니라 `npm.cmd`다(CLAUDE.md 함정 기록). shim을 거치지 않고
 * `node npm-cli.js`를 직접 부른다 — 제품의 `tools/program.rs`가 하는 것과 같은 일이다.
 */
function npmCliPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`npm-cli.js를 찾지 못했습니다. 확인한 경로:\n  ${candidates.join("\n  ")}`);
}

/** production 의존성 폐포. **손으로 적지 않는다** — 의존성이 늘 때 목록이 빠지기 때문이다. */
function productionDependencyPaths() {
  const result = spawnSync(
    process.execPath,
    [npmCliPath(), "ls", "--omit=dev", "--workspace=@tomverse/sidecar", "--all", "--parseable"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`npm ls가 실패했습니다 (exit ${result.status}):\n${result.stderr}`);
  }
  const paths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (paths.length === 0) throw new Error("npm ls가 아무 경로도 내지 않았습니다");
  return paths;
}

/** grammar 목록을 **sidecar가 선언한 그대로** 읽는다. 여기 또 적으면 언젠가 갈라진다. */
async function grammarWasmFiles(sidecarDistDir) {
  const module = path.join(sidecarDistDir, "context", "treeSitter.js");
  if (!fs.existsSync(module)) {
    throw new Error(`sidecar가 빌드되지 않았습니다: ${module}\n먼저 npm run build를 돌리세요.`);
  }
  const { WASM_BASENAME } = await import(pathToFileURL(module).href);
  const files = Object.values(WASM_BASENAME ?? {});
  if (files.length === 0) throw new Error(`${module}에서 grammar 목록을 읽지 못했습니다`);
  return files;
}

// ---- smoke: 실제로 띄워 본다 ----

/**
 * 스테이징된 트리로 sidecar를 띄우고 ping 왕복을 받는다.
 *
 * **이것이 잘라내기의 안전망이다.** 계획이 지나치게 잘랐거나 `package.json`을 빠뜨렸으면
 * 여기서 죽는다. 없으면 그 실패는 사용자 머신에서 처음 드러나고, 증상이 "앱이 조용히 뜨지
 * 않는다"라 원인에 닿지 못한다.
 */
function smokeTest(bundleDir, windows) {
  const program = path.join(bundleDir, runtimeFileName(windows));
  const entry = path.join(bundleDir, ENTRY_FILE);
  return new Promise((resolve) => {
    const child = spawn(program, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 이미 죽었다 */
      }
      resolve({ ok, detail, stderr });
    };
    const timer = setTimeout(() => done(false, "10초 안에 ping 응답이 오지 않았습니다"), 10_000);
    // 상대가 먼저 죽으면 EPIPE가 프로세스를 죽인다(CLAUDE.md 함정 기록).
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.on("error", (error) => done(false, `spawn 실패: ${error.message}`));
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.kind === "response" && message.id === "smoke") {
          if (message.ok && message.result && message.result.pong) {
            done(true, `protocol ${message.result.protocolVersion} / node ${message.result.nodeVersion}`);
          } else {
            done(false, `ping이 거부됐습니다: ${JSON.stringify(message)}`);
          }
        }
      }
    });
    child.on("exit", (code) => done(false, `sidecar가 응답 전에 종료했습니다 (exit ${code})`));
    child.stdin.write(`${JSON.stringify({ kind: "request", id: "smoke", method: "ping", params: {} })}\n`);
  });
}

/**
 * 번들이 **자기 안의 것만** 쓰는지 본다 — 그리고 grammar가 실제로 적재되는지도.
 *
 * # 왜 "뜬다"만으로는 부족한가 (실측으로 드러났다)
 *
 * 스테이징 트리는 저장소 **안에** 있고, Node의 모듈 해석은 찾을 때까지 상위 디렉터리를
 * 거슬러 올라간다. 그래서 번들의 `node_modules`가 통째로 비어 있어도 저장소 루트의
 * `node_modules`가 잡혀 **smoke가 통과한다.** 설치본에는 그 상위가 없으므로 거기서만 죽는다 —
 * 개발에서는 보이지 않고 배포에서만 다르게 죽는, 이 저장소가 가장 경계하는 모양이다.
 *
 * 실제로 확인했다: 번들에서 `tree-sitter-python.wasm`을 지워도 적재는 성공했다.
 * 저장소의 것을 집었기 때문이다.
 *
 * 그래서 판정 기준을 "해석되는가"가 아니라 **"번들 안으로 해석되는가"**로 둔다.
 * 이건 위치와 무관하게 성립하므로 저장소 안에서 돌려도 뜻이 있다.
 *
 * # grammar를 따로 보는 이유
 *
 * grammar는 지연 적재라 `ping` 왕복이 건드리지 않는데, 잘라내기가 가장 과감한 곳이 정확히
 * 여기다(`tree-sitter-wasms` 50개 중 45개를 버린다). 게다가 적재 실패는 **던지지 않는다**
 * (폴백이 ripgrep이므로 태스크는 계속 돌아야 한다) — 빠져도 오류가 없고 증상은
 * "그 언어만 심볼이 없다"는 조용한 저하다.
 */
function resolutionSmoke(bundleDir, windows, dependencies) {
  const program = path.join(bundleDir, runtimeFileName(windows));
  const entryUrl = pathToFileURL(path.join(bundleDir, ENTRY_FILE)).href;
  const treeSitterUrl = pathToFileURL(path.join(bundleDir, "context", "treeSitter.js")).href;
  const script = `
    const { createRequire } = await import("node:module");
    const require = createRequire(${JSON.stringify(entryUrl)});
    const resolved = {};
    for (const name of ${JSON.stringify(dependencies)}) {
      // 루트 진입점이 없는 패키지가 있다(tree-sitter-wasms는 wasm 파일 묶음일 뿐이고,
      // openai/anthropic은 서브패스만 export한다). 그건 결함이 아니라 그 패키지의 모양이므로,
      // **원본에서도 같은 이유로 실패하는지**를 부모가 대조한다.
      try { resolved[name] = require.resolve(name); }
      catch (e) { resolved[name] = "UNRESOLVED:" + e.code; }
    }
    const m = await import(${JSON.stringify(treeSitterUrl)});
    const grammars = {};
    for (const id of Object.keys(m.WASM_BASENAME)) {
      try { grammars[id] = m.resolveGrammarPath(id); }
      catch (e) { grammars[id] = "ERROR: " + e.code; }
    }
    const set = await m.loadGrammars();
    process.stdout.write(JSON.stringify({ resolved, grammars, report: set.report(), any: set.anyLoaded() }));
  `;
  const result = spawnSync(program, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: bundleDir,
  });
  if (result.status !== 0) {
    return { ok: false, detail: `해석 스크립트가 실패했습니다 (exit ${result.status}): ${result.stderr ?? ""}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, detail: `해석 결과를 읽지 못했습니다: ${result.stdout?.slice(0, 400)}` };
  }

  const inside = path.resolve(bundleDir) + path.sep;
  const escapes = [];

  // **디스크 존재부터 본다.** Node는 가장 가까운 `node_modules`를 먼저 보므로, 번들 안에
  // 있는 패키지는 상위의 것에 가려질 수 없다. 즉 위로 새는 경우는 **복사하지 못한 패키지**뿐이고,
  // 그건 해석을 돌리지 않아도 알 수 있다. (해석만으로 판정하면 루트를 export하지 않는
  // 패키지에서 "실패"와 "샜다"를 구별할 수 없다.)
  for (const name of dependencies) {
    const marker = path.join(bundleDir, "node_modules", ...name.split("/"), "package.json");
    if (!fs.existsSync(marker)) escapes.push(`${name} → 번들에 없음 (${marker})`);
  }

  // 원본(저장소)에서의 해석 가능성. **여기서 되는데 번들에서 안 되면** 우리가 진입점을
  // 잘라낸 것이고, 양쪽 다 안 되면 그 패키지에 루트 진입점이 없는 것이다.
  const fromSource = createRequire(pathToFileURL(path.join(REPO_ROOT, "packages", "sidecar", "dist", "src", ENTRY_FILE)));
  for (const [name, where] of Object.entries(parsed.resolved)) {
    if (typeof where === "string" && where.startsWith("UNRESOLVED:")) {
      let resolvableAtSource = true;
      try {
        fromSource.resolve(name);
      } catch {
        resolvableAtSource = false;
      }
      if (resolvableAtSource) {
        escapes.push(`${name} → 원본에서는 해석되는데 번들에서 안 됩니다 (${where}) — 진입점을 잘라냈습니까?`);
      }
      continue;
    }
    if (typeof where !== "string" || !path.resolve(where).startsWith(inside)) {
      // 여기가 요점이다. "찾았다"가 아니라 "우리 것을 찾았다"여야 한다.
      escapes.push(`${name} → 번들 밖 (${where})`);
    }
  }
  for (const [id, where] of Object.entries(parsed.grammars)) {
    if (typeof where !== "string" || where.startsWith("ERROR:")) {
      escapes.push(`grammar ${id} → 해석 실패 (${where})`);
    } else if (!path.resolve(where).startsWith(inside)) {
      escapes.push(`grammar ${id} → 번들 밖 (${where})`);
    }
  }
  if (escapes.length > 0) {
    return {
      ok: false,
      detail:
        `번들이 자기 밖의 모듈을 쓰고 있습니다 — 설치본에는 그 경로가 없습니다:\n  ${escapes.join("\n  ")}\n` +
        "스테이징이 그 패키지를 빠뜨렸거나 잘라내기가 지나쳤습니다.",
    };
  }

  const failed = Object.entries(parsed.report ?? {})
    .filter(([, v]) => v && v.loaded === false)
    .map(([k, v]) => `${k}: ${v.reason ?? "사유 없음"}`);
  if (!parsed.any || failed.length > 0) {
    return { ok: false, detail: `grammar 적재에 실패한 언어가 있습니다:\n  ${failed.join("\n  ")}` };
  }

  const counts = `의존성 ${Object.keys(parsed.resolved).length}개 · grammar ${Object.keys(parsed.grammars).length}개 · 언어 ${Object.keys(parsed.report ?? {}).length}개 적재`;
  return { ok: true, detail: `전부 번들 안에서 해석됨 (${counts})` };
}

// ---- manifest 재료 ----

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function lockfileHash() {
  const lock = path.join(REPO_ROOT, "package-lock.json");
  return fs.existsSync(lock) ? sha256File(lock) : null;
}

// ---- 본체 ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const windows = args.targetPlatform === "win32";
  const pin = readPin();
  const artifact = artifactFor(pin, args.targetPlatform, args.targetArch);
  log(`대상 ${args.targetPlatform}/${args.targetArch} · Node ${pin.version} (${artifact.key})`);

  const sidecarDistDir = path.join(REPO_ROOT, "packages", "sidecar", "dist", "src");
  if (!fs.existsSync(path.join(sidecarDistDir, ENTRY_FILE))) {
    fail(`sidecar 진입점이 없습니다: ${path.join(sidecarDistDir, ENTRY_FILE)}\n먼저 npm run build를 돌리세요.`);
  }

  const grammars = await grammarWasmFiles(sidecarDistDir);
  log(`grammar ${grammars.length}개: ${grammars.join(", ")}`);

  const depPaths = productionDependencyPaths();
  const plan = planSidecarStage({
    repoRoot: REPO_ROOT,
    stageRoot: args.stageRoot,
    windows,
    sidecarDistDir,
    depPaths,
    grammarWasmFiles: grammars,
  });

  // **먼저 지운다.** 이전 빌드의 잔여물이 남으면 "지금 빌드가 만든 것"과 "예전에 만든 것"이
  // 섞이고, 그 상태에서 통과한 검사는 아무것도 보증하지 못한다.
  fs.rmSync(args.stageRoot, { recursive: true, force: true });
  fs.mkdirSync(plan.bundleDir, { recursive: true });

  const runtime = await ensurePinnedRuntime(artifact, args.offline);
  const license = await ensureLicense(pin, args.offline);
  fs.copyFileSync(runtime, path.join(plan.bundleDir, runtimeFileName(windows)));
  fs.copyFileSync(license, path.join(plan.bundleDir, RUNTIME_LICENSE_FILE));

  const stats = { files: 0, bytes: 0, pruned: 0, prunedBytes: 0, skippedNested: 0 };
  for (const copy of plan.copies) {
    copyTree(copy.from, copy.to, { ...copy.prune, root: copy.from }, stats);
  }
  for (const skipped of plan.skipped) {
    if (!skipped.why.startsWith("node_modules 아래가")) log(`건너뜀: ${skipped.path} — ${skipped.why}`);
  }

  fs.writeFileSync(
    path.join(plan.bundleDir, "package.json"),
    `${JSON.stringify(bundlePackageJson(pin.version), null, 2)}\n`
  );

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: "tomverse-sidecar-bundle",
    node: {
      version: pin.version,
      artifact: artifact.key,
      url: artifact.url,
      sha256: artifact.sha256,
      licenseSha256: sha256File(license),
    },
    sidecar: {
      commit: gitCommit(),
      lockfileSha256: lockfileHash(),
      entry: ENTRY_FILE,
      grammars,
      dependencies: plan.copies
        .filter((c) => c.what !== "sidecar")
        .map((c) => c.what)
        .sort(),
    },
    prunedExtensions: PRUNED_EXTENSIONS,
  };
  fs.writeFileSync(path.join(plan.bundleDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

  const missing = plan.required.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    fail(`스테이징 후 있어야 할 파일이 없습니다:\n  ${missing.join("\n  ")}`);
  }

  const size = dirSize(plan.bundleDir);
  log(
    `번들 ${(size / 1048576).toFixed(1)} MiB — 파일 ${stats.files}개 ` +
      `(잘라냄 ${stats.pruned}개 / ${(stats.prunedBytes / 1048576).toFixed(1)} MiB)`
  );

  if (args.smoke) {
    if (args.targetPlatform !== process.platform || args.targetArch !== process.arch) {
      log(`smoke 건너뜀 — 대상(${args.targetPlatform}/${args.targetArch})이 이 머신과 다릅니다`);
    } else {
      const result = await smokeTest(plan.bundleDir, windows);
      if (!result.ok) {
        fail(
          `스테이징된 번들로 sidecar를 띄우지 못했습니다: ${result.detail}\n` +
            `stderr:\n${result.stderr || "(없음)"}\n` +
            "잘라내기가 지나쳤거나 의존성이 빠졌을 수 있습니다."
        );
      }
      log(`smoke 통과 — ${result.detail}`);

      // **ping이 떴다는 것으로 충분하지 않다.** 스테이징 트리가 저장소 안에 있으면 모듈
      // 해석이 위로 올라가 저장소의 node_modules를 집으므로, 번들이 비어 있어도 뜬다.
      const resolution = resolutionSmoke(plan.bundleDir, windows, manifest.sidecar.dependencies);
      if (!resolution.ok) fail(`해석 smoke 실패: ${resolution.detail}`);
      log(`해석 smoke 통과 — ${resolution.detail}`);
    }
  }

  log(`완료: ${plan.bundleDir}`);
}

main().catch((error) => fail(error.stack ?? String(error)));
