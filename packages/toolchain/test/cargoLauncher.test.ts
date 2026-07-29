import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * cargo 런처(`scripts/cargo.mjs`) 회귀 테스트.
 *
 * # 무엇을 막는가
 *
 * 일반 PowerShell에서 `npm run verify`가 `core:build`에서 죽었다 —
 * `stdarg.h: No such file or directory`, `INCLUDE=None`, `LIB=None`. `scripts\verify.bat`은
 * `_env.bat`을 먼저 call하므로 통과했다. **단계 순서는 같은데 환경 준비 의미가 달랐다.**
 *
 * # 가짜 cargo를 어떻게 만드는가
 *
 * **Node 실행 파일을 그대로 복사한다.** 처음에는 셔뱅(`#!/usr/bin/env node`)이 붙은 스크립트에
 * 실행 권한을 줬는데, Windows에는 셔뱅도 실행 비트도 없어서 `cargo`라는 확장자 없는 파일은
 * 실행되지 않았다. 런처는 그걸 찾아 spawn하려다 실패했고, 테스트 5개가 "런처 결함"처럼 보였다.
 *
 * Node 바이너리를 `cargo.exe`(Windows) / `cargo`(그 외)로 복사하면 **실제로 실행되는 진짜
 * 실행 파일**이 되고, 동작은 우리가 넘기는 인자(`-e <script>`)로 통제한다. 런처는 인자를
 * 해석하지 않고 그대로 넘기므로 이 방식이 종료 코드·인자·환경 전달을 그대로 검증한다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LAUNCHER = path.join(REPO_ROOT, "scripts", "cargo.mjs");
const IS_WINDOWS = process.platform === "win32";

/**
 * Node 바이너리를 cargo라는 이름으로 복사한 디렉터리. **한 번만 만들어 공유한다** —
 * Windows의 node.exe는 수십 MB라 테스트마다 복사하면 검증이 눈에 띄게 느려진다.
 */
let sharedFakeCargoDir: string | undefined;

function fakeCargoDir(): string {
  if (sharedFakeCargoDir === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), "tomverse-fake-cargo-"));
    copyFileSync(process.execPath, path.join(dir, IS_WINDOWS ? "cargo.exe" : "cargo"));
    sharedFakeCargoDir = dir;
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return sharedFakeCargoDir;
}

/**
 * 환경변수 이름은 Windows에서 대소문자를 구별하지 않는다. `{...process.env}`를 펼치면
 * Windows가 준 철자(`Path`)로 들어오므로, 여기에 `PATH`를 대입하면 **두 키가 모두** 자식에게
 * 전달되고 어느 쪽이 이길지 정해져 있지 않다. 실제로 이것 때문에 자식이 System32를 잃고
 * `spawnSync cmd.exe ENOENT`가 났다. 기존 철자를 찾아 그 키에 쓴다.
 */
function setEnvVar(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const existing = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  env[existing ?? name] = value;
}

function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const existing = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return existing === undefined ? undefined : env[existing];
}

function runLauncher(
  args: string[],
  options: { pathPrefix?: string; env?: Record<string, string> } = {}
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (options.pathPrefix !== undefined) {
    setEnvVar(env, "PATH", `${options.pathPrefix}${path.delimiter}${envVar(env, "PATH") ?? ""}`);
  }
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: "utf8", env, shell: false });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withFakeCargo(fn: (dir: string) => void): void {
  fn(fakeCargoDir());
}

// ---- 회귀 3: root cargo 명령이 준비 경로를 지난다 ----

test("루트 core:build / core:test가 맨몸 cargo를 부르지 않는다", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const name of ["core:build", "core:test"]) {
    const script = pkg.scripts[name];
    assert.ok(typeof script === "string", `루트에 ${name}이 없습니다`);
    assert.ok(
      !/^\s*cargo\s/.test(script!),
      `${name}이 cargo를 직접 부릅니다 — Windows에서 INCLUDE/LIB 없이 링크에 실패합니다: ${script}`
    );
    assert.ok(script!.includes("scripts/cargo.mjs"), `${name}이 cargo 런처를 지나지 않습니다: ${script}`);
  }
});

test("cargo를 부르는 .bat 래퍼도 같은 런처를 지난다", () => {
  // 두 진입점이 갈라지면 "bat으로는 되는데 npm으로는 안 되는" 상태가 다시 생긴다.
  for (const name of ["cargo-build-core.bat", "cargo-test-core.bat", "cargo-check-desktop.bat"]) {
    const script = readFileSync(path.join(REPO_ROOT, "scripts", name), "utf8");
    assert.ok(script.includes("cargo.mjs"), `${name}이 런처를 지나지 않습니다`);
    assert.ok(!/^\s*cargo\s/m.test(script), `${name}이 cargo를 직접 부릅니다 — 준비 경로가 둘로 갈라집니다`);
    const lfOnly = (script.match(/(?<!\r)\n/g) ?? []).length;
    assert.equal(lfOnly, 0, `${name}에 CRLF가 아닌 줄바꿈이 ${lfOnly}개 있습니다`);
  }
});

test("런처가 Visual Studio 경로를 새로 하드코딩하지 않는다", () => {
  // 탐지는 _env.bat 한 곳에만 있어야 한다.
  const source = readFileSync(LAUNCHER, "utf8");
  assert.ok(!/Program Files/i.test(source), "런처에 Visual Studio 경로가 하드코딩되어 있습니다");
  assert.ok(!/vcvarsall/i.test(source), "런처가 vcvarsall을 직접 찾습니다 — 탐지가 두 곳으로 갈라집니다");
  assert.ok(!/shell:\s*true/.test(source), "런처가 셸을 켭니다");
  assert.ok(source.includes("shell: false"), "런처가 shell:false를 명시하지 않습니다");
});

// ---- 회귀 4: 실패 코드 보존 ----

test("cargo의 종료 코드를 그대로 돌려준다", () => {
  withFakeCargo((dir) => {
    for (const code of [0, 1, 101, 3]) {
      const result = runLauncher(["-e", `process.exit(${code})`], { pathPrefix: dir });
      assert.equal(
        result.status,
        code,
        `종료 코드가 ${code}에서 ${result.status}로 바뀌었습니다\nstderr: ${result.stderr}`
      );
    }
  });
});

test("인자를 그대로 cargo에 넘긴다", () => {
  withFakeCargo((dir) => {
    // 공백이 든 인자와 `--` 뒤 인자가 변형 없이 도착해야 한다.
    const result = runLauncher(
      ["-e", "process.stdout.write(process.argv.slice(1).join('|'))", "a b/Cargo.toml", "--", "--nocapture"],
      { pathPrefix: dir }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "a b/Cargo.toml|--|--nocapture", `인자가 변형되었습니다: ${result.stdout}`);
  });
});

test("인자 없이 부르면 성공으로 끝나지 않는다", () => {
  const result = runLauncher([]);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("사용법"), result.stderr);
});

test("cargo를 찾을 수 없는 PATH에서는 조용히 통과하지 않는다", () => {
  // PATH에서 가짜 cargo를 빼고 돌린다. 이 머신에 진짜 cargo가 있으면 그게 실행되겠지만,
  // 저장소 루트에는 Cargo.toml이 없으므로(core/는 자체 워크스페이스다) 그 경우에도 실패한다.
  // 어느 쪽이든 **0으로 끝나서는 안 된다** — 그게 이 테스트가 지키는 불변식이다.
  const result = runLauncher(["build"]);
  assert.notEqual(result.status, 0, `cargo가 없거나 실행할 수 없는데 성공으로 끝났습니다:\n${result.stdout}`);
  assert.ok(
    (result.stderr ?? "").trim().length > 0,
    "실패했는데 아무 설명도 없습니다 — 사용자가 원인에 도달할 수 없습니다"
  );
});

// ---- 회귀 5: 자격증명 비노출 ----

test("런처 출력에 API 키나 전체 환경이 섞이지 않는다", () => {
  withFakeCargo((dir) => {
    const result = runLauncher(["-e", "process.exit(0)"], {
      pathPrefix: dir,
      env: {
        OPENAI_API_KEY: "sk-launcher-must-not-print-this",
        ANTHROPIC_API_KEY: "sk-ant-launcher-must-not-print-this",
      },
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.ok(!combined.includes("sk-launcher-must-not-print-this"), `런처가 키를 출력했습니다:\n${combined}`);
    assert.ok(!combined.includes("sk-ant-launcher-must-not-print-this"));
    assert.ok(!/OPENAI_API_KEY/.test(combined), "런처가 키 변수 이름을 출력했습니다");
  });
});

test("런처가 환경을 덤프하는 코드를 갖고 있지 않다", () => {
  const source = readFileSync(LAUNCHER, "utf8");
  assert.ok(
    !/console\.(log|dir)\s*\(\s*process\.env/.test(source) && !/write\(.*process\.env\s*\)/.test(source),
    "런처가 process.env를 출력합니다"
  );
});

test("자식 cargo는 부모 환경을 물려받되 우리가 지어내지 않는다", () => {
  // MSVC 변수는 병합하지만 그 외에는 부모 환경 그대로여야 한다.
  withFakeCargo((dir) => {
    const result = runLauncher(["-e", "process.stdout.write(String(process.env.TOMVERSE_LAUNCHER_PROBE))"], {
      pathPrefix: dir,
      env: { TOMVERSE_LAUNCHER_PROBE: "inherited" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "inherited", `부모 환경이 전달되지 않았습니다: ${result.stdout}`);
  });
});

test("자식이 PATH를 하나만 받는다 (Windows의 Path/PATH 중복 없음)", () => {
  // 대소문자만 다른 키를 둘 다 넘기면 어느 쪽이 이길지 정해져 있지 않고, 지면 방금 준비한
  // MSVC 경로가 통째로 무시되어 다시 링크에서 실패한다.
  withFakeCargo((dir) => {
    const result = runLauncher(
      [
        "-e",
        "process.stdout.write(String(Object.keys(process.env).filter((k) => k.toLowerCase() === 'path').length))",
      ],
      { pathPrefix: dir }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "1", `자식이 PATH 계열 키를 ${result.stdout}개 받았습니다`);
  });
});

// ---- clean dist 상태 검증 가능성 ----

test("런처는 빌드된 dist 없이도 실행된다", () => {
  // 이게 무너지면 "Rust를 빌드하려면 TypeScript를 먼저 빌드해야 한다"는 순환이 생기고,
  // clean clone에서 core:build가 막힌다.
  const source = readFileSync(LAUNCHER, "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
  for (const specifier of imports) {
    assert.ok(!specifier.includes("dist"), `런처가 빌드 산출물을 import합니다: ${specifier}`);
    if (specifier.startsWith("@tomverse/")) {
      assert.equal(
        specifier,
        "@tomverse/toolchain/exec",
        `런처는 빌드가 필요 없는 서브패스만 써야 합니다: ${specifier}`
      );
    }
  }

  withFakeCargo((dir) => {
    const result = runLauncher(["-e", "process.exit(0)"], { pathPrefix: dir });
    assert.equal(result.status, 0, result.stderr);
  });
});
