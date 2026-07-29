import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { DEFAULT_PATHEXT, findExecutable, programStem, resolveNodeCli } from "../src/nodeCli.js";
import { MSVC_ENV_ALLOWLIST, READY_MARKER } from "../src/msvc.js";

/**
 * 공용 실행 계층(`js/exec.mjs`) 테스트.
 *
 * 구현이 일반 JavaScript인 이유는 `src/msvc.ts` 상단에 있다 — TypeScript로 두면
 * "Rust를 빌드하려면 TypeScript를 먼저 빌드해야 한다"는 순환이 생긴다. 그 대가로 타입이
 * 손으로 유지되므로, **선언된 이름이 실제로 존재하는지**를 여기서 실행 시점에 확인한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

test("exec.mjs가 빌드 산출물이 아니라 소스 그대로 노출된다", async () => {
  // dist를 거치면 순환이 되살아난다. package exports가 js/를 직접 가리켜야 한다.
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages", "toolchain", "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  const entry = pkg.exports["./exec"] as { types: string; default: string };
  assert.ok(entry, "package.json에 ./exec 서브패스가 없습니다");
  assert.ok(
    !entry.default.includes("dist"),
    `./exec가 빌드 산출물을 가리킵니다 (${entry.default}) — cargo 런처가 빌드 전에 import할 수 없게 됩니다`
  );

  // 실제로 로드된다.
  const loaded = (await import("@tomverse/toolchain/exec")) as Record<string, unknown>;
  assert.equal(typeof loaded.prepareMsvcEnv, "function");
});

test("타입 선언에 있는 이름이 구현에도 전부 있다", async () => {
  const loaded = (await import("@tomverse/toolchain/exec")) as Record<string, unknown>;
  const declaration = readFileSync(path.join(REPO_ROOT, "packages", "toolchain", "js", "exec.d.mts"), "utf8");
  const declared = [...declaration.matchAll(/export declare (?:function|const) (\w+)/g)].map((m) => m[1]!);

  assert.ok(declared.length >= 10, `선언이 너무 적습니다: ${declared.join(", ")}`);
  for (const name of declared) {
    assert.ok(
      Object.hasOwn(loaded, name),
      `exec.d.mts가 ${name}을(를) 선언했지만 exec.mjs에 없습니다 — 선언과 구현이 갈라졌습니다`
    );
  }
});

test("cargo 런처와 TypeScript 쪽이 같은 구현을 쓴다", async () => {
  // 한쪽만 고쳐서 갈라지는 것이 이 구조가 막으려는 실패다. 동일성을 참조 비교로 확인한다.
  const shared = (await import("@tomverse/toolchain/exec")) as Record<string, unknown>;
  const typed = await import("../src/msvc.js");
  assert.equal(typed.prepareMsvcEnv, shared.prepareMsvcEnv);
  assert.equal(typed.parseMsvcEnv, shared.parseMsvcEnv);
  assert.equal(typed.MSVC_ENV_ALLOWLIST, shared.MSVC_ENV_ALLOWLIST);
});

test("배치가 쓰는 표식과 변수 목록이 실제 스크립트와 일치한다", () => {
  // 목록이 어긋나면 배치는 출력하는데 Node가 버리거나, 그 반대가 된다.
  const script = readFileSync(path.join(REPO_ROOT, "scripts", "msvc-env.bat"), "utf8");
  assert.ok(script.includes(`${READY_MARKER}=1`), `배치가 ${READY_MARKER}를 출력하지 않습니다`);
  for (const name of MSVC_ENV_ALLOWLIST) {
    assert.ok(
      new RegExp(`^echo ${name}=`, "im").test(script),
      `allowlist의 ${name}을(를) msvc-env.bat이 출력하지 않습니다`
    );
  }
});

// ---- 실행 파일 해석 (Node 쪽 helper) ----

/** 가상 파일 시스템 — Linux에서 Windows 분기를 태우기 위한 것. */
function fsOf(files: readonly string[]): (p: string) => boolean {
  const set = new Set(files.map((f) => f.replace(/\//g, "\\")));
  return (p) => set.has(p.replace(/\//g, "\\"));
}

/**
 * 실제 Windows Node 설치 — **확장자 없는 `npm`/`npx`가 `.cmd` 옆에 함께 있다.**
 * Node 인스톨러가 Git Bash/MSYS용 셸 스크립트를 같이 깔기 때문이고, 실측에서 해석기가
 * 이걸 집어 실패했다. fixture가 실제 설치를 그대로 흉내내지 않으면 그 결함을 다시 놓친다.
 */
const NODE_INSTALL = [
  "C:\\Program Files\\nodejs\\node.exe",
  "C:\\Program Files\\nodejs\\npm",
  "C:\\Program Files\\nodejs\\npm.cmd",
  "C:\\Program Files\\nodejs\\npx",
  "C:\\Program Files\\nodejs\\npx.cmd",
  "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
];
const WIN_PATH = "C:\\Program Files\\nodejs;C:\\Windows\\System32";

test("programStem은 실행 중인 OS와 무관하게 구분자를 다룬다", () => {
  assert.equal(programStem("npm"), "npm");
  assert.equal(programStem("npm.cmd"), "npm");
  assert.equal(programStem("C:\\Program Files\\nodejs\\npm.cmd"), "npm");
  assert.equal(programStem("/usr/local/bin/npm"), "npm");
});

test("비 Windows에서는 요청을 그대로 통과시킨다", () => {
  const resolved = resolveNodeCli("npm", ["test", "--silent"], { platform: "linux" });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.executable, "npm");
  assert.deepEqual(resolved.args, ["test", "--silent"]);
  assert.equal(resolved.kind, "passthrough");
});

test("Windows에서 npm은 셸 없이 node + npm-cli.js가 된다", () => {
  const resolved = resolveNodeCli("npm", ["test", "--silent"], {
    platform: "win32",
    pathValue: WIN_PATH,
    isFile: fsOf(NODE_INSTALL),
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.kind, "node-cli");
  assert.equal(resolved.executable, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(resolved.args, [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "test",
    "--silent",
  ]);
});

test("Node 설치 구조를 확인하지 못하면 추측하지 않고 실패한다", () => {
  const resolved = resolveNodeCli("npm", ["test"], {
    platform: "win32",
    pathValue: WIN_PATH,
    // npm.cmd만 있고 npm-cli.js가 없다.
    isFile: fsOf(["C:\\Program Files\\nodejs\\npm.cmd", "C:\\Program Files\\nodejs\\node.exe"]),
  });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.ok(resolved.message.includes("npm-cli.js"), resolved.message);
});

test("알려지지 않은 배치 shim은 실행 대상이 되지 않는다", () => {
  const resolved = resolveNodeCli("deploy", [], {
    platform: "win32",
    pathValue: "C:\\tools",
    isFile: fsOf(["C:\\tools\\deploy.cmd"]),
  });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.ok(resolved.message.includes("알려지지 않은"), resolved.message);
});

test("Windows에서 .cmd 옆의 확장자 없는 Unix shim을 집지 않는다", () => {
  // Windows의 실행 파일 판정은 PATHEXT가 한다. 확장자 없는 파일은 실행 파일이 아니다.
  const found = findExecutable("npm", {
    platform: "win32",
    pathValue: WIN_PATH,
    isFile: fsOf(NODE_INSTALL),
  });
  assert.equal(found, "C:\\Program Files\\nodejs\\npm.cmd", `확장자 없는 파일을 집었습니다: ${found}`);

  const resolved = resolveNodeCli("npm", ["test"], {
    platform: "win32",
    pathValue: WIN_PATH,
    isFile: fsOf(NODE_INSTALL),
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.kind, "node-cli");
});

test("Windows에서 확장자 없는 파일은 아예 후보가 되지 않는다", () => {
  const found = findExecutable("thing", {
    platform: "win32",
    pathValue: "C:\\tools",
    isFile: fsOf(["C:\\tools\\thing"]),
  });
  assert.equal(found, undefined, `확장자 없는 파일을 실행 대상으로 골랐습니다: ${found}`);
});

test("비 Windows에서는 확장자 없는 실행 파일이 정상이다", () => {
  // POSIX에는 PATHEXT가 없다. 위 규칙을 그쪽까지 적용하면 모든 명령이 깨진다.
  const found = findExecutable("npm", {
    platform: "linux",
    pathValue: "/usr/bin",
    isFile: (p) => p === "/usr/bin/npm",
  });
  assert.equal(found, "/usr/bin/npm");
});

test("PATHEXT를 지정하지 않으면 기본 목록을 쓴다", () => {
  assert.ok(DEFAULT_PATHEXT.includes(".CMD"));
  const found = findExecutable("npm", {
    platform: "win32",
    pathValue: WIN_PATH,
    isFile: fsOf(NODE_INSTALL),
  });
  assert.equal(found, "C:\\Program Files\\nodejs\\npm.cmd");
});

test("경로가 들어 있으면 PATH를 뒤지지 않는다", () => {
  const found = findExecutable("C:\\elsewhere\\npm.cmd", {
    platform: "win32",
    pathValue: WIN_PATH,
    isFile: fsOf(NODE_INSTALL),
  });
  assert.equal(found, undefined);
});

test("이 helper는 sidecar 제품 코드가 아니라 테스트 하네스만 쓴다", () => {
  // e2e 본체는 논리 명령 `npm test`를 Rust에 요청해야 한다. 제품 소스가 이 helper를 쓰면
  // "e2e가 제품 경로를 검증한다"는 주장이 무너진다.
  const require_ = createRequire(import.meta.url);
  const sidecarSrc = path.join(REPO_ROOT, "packages", "sidecar", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of require_("node:fs").readdirSync(dir, { withFileTypes: true }) as {
      name: string;
      isDirectory(): boolean;
    }[]) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && readFileSync(full, "utf8").includes("@tomverse/toolchain")) {
        offenders.push(full);
      }
    }
  };
  walk(sidecarSrc);
  assert.deepEqual(offenders, [], `sidecar 제품 코드가 toolchain을 import합니다:\n${offenders.join("\n")}`);
});
