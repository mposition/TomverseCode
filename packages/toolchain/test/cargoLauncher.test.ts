import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
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
 * 여기서 확인하는 것:
 *  - 루트 cargo 명령이 런처를 지나는가 (맨몸 cargo가 아닌가)
 *  - `.bat` 래퍼도 같은 런처를 지나는가 (두 진입점이 갈라지지 않는가)
 *  - 실패 종료 코드가 보존되는가
 *  - 출력에 자격증명이나 전체 환경이 섞이지 않는가
 *
 * 실제 cargo를 부르지 않는다. 런처가 찾을 `cargo`를 가짜로 만들어 PATH에 두고, 그 종료 코드와
 * 출력만 본다 — 이 저장소의 Rust 빌드 전체를 회귀 테스트마다 돌릴 수는 없기 때문이다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LAUNCHER = path.join(REPO_ROOT, "scripts", "cargo.mjs");

/** 지정한 코드로 끝나는 가짜 cargo를 만들고 그 디렉터리를 돌려준다. */
function fakeCargoDir(options: { exitCode: number; echoEnv?: string[] }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tomverse-fake-cargo-"));
  const script = [
    "#!/usr/bin/env node",
    `const wanted = ${JSON.stringify(options.echoEnv ?? [])};`,
    "process.stdout.write('fake-cargo ' + process.argv.slice(2).join(' ') + '\\n');",
    "for (const name of wanted) process.stdout.write(name + '=' + String(process.env[name]) + '\\n');",
    `process.exit(${options.exitCode});`,
    "",
  ].join("\n");
  // Windows가 아닌 이 환경에서는 확장자 없는 실행 파일이면 충분하다.
  const file = path.join(dir, "cargo");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return dir;
}

function runLauncher(
  args: string[],
  options: { pathPrefix?: string; env?: Record<string, string> } = {}
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (options.pathPrefix !== undefined) env.PATH = `${options.pathPrefix}${path.delimiter}${env.PATH ?? ""}`;
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: "utf8", env, shell: false });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withFakeCargo(
  options: { exitCode: number; echoEnv?: string[] },
  fn: (dir: string) => void
): void {
  const dir = fakeCargoDir(options);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.ok(
      script!.includes("scripts/cargo.mjs"),
      `${name}이 cargo 런처를 지나지 않습니다: ${script}`
    );
  }
});

test("cargo를 부르는 .bat 래퍼도 같은 런처를 지난다", () => {
  // 두 진입점이 갈라지면 "bat으로는 되는데 npm으로는 안 되는" 상태가 다시 생긴다.
  for (const name of ["cargo-build-core.bat", "cargo-test-core.bat", "cargo-check-desktop.bat"]) {
    const script = readFileSync(path.join(REPO_ROOT, "scripts", name), "utf8");
    assert.ok(script.includes("cargo.mjs"), `${name}이 런처를 지나지 않습니다`);
    assert.ok(
      !/^\s*cargo\s/m.test(script),
      `${name}이 cargo를 직접 부릅니다 — 준비 경로가 둘로 갈라집니다`
    );
    // CRLF 유지 (LF면 cmd.exe가 조용히 엉뚱하게 동작한다).
    const lfOnly = (script.match(/(?<!\r)\n/g) ?? []).length;
    assert.equal(lfOnly, 0, `${name}에 CRLF가 아닌 줄바꿈이 ${lfOnly}개 있습니다`);
  }
});

test("런처가 Visual Studio 경로를 새로 하드코딩하지 않는다", () => {
  // 탐지는 _env.bat 한 곳에만 있어야 한다.
  const source = readFileSync(LAUNCHER, "utf8");
  assert.ok(!/Program Files/i.test(source), "런처에 Visual Studio 경로가 하드코딩되어 있습니다");
  assert.ok(!/vcvarsall/i.test(source), "런처가 vcvarsall을 직접 찾습니다 — 탐지가 두 곳으로 갈라집니다");
  // 셸 문자열 조합이 없어야 한다.
  assert.ok(!/shell:\s*true/.test(source), "런처가 셸을 켭니다");
  assert.ok(source.includes("shell: false"), "런처가 shell:false를 명시하지 않습니다");
});

// ---- 회귀 4: 실패 코드 보존 ----

test("cargo의 실패 종료 코드를 그대로 돌려준다", () => {
  for (const code of [0, 1, 101, 3]) {
    withFakeCargo({ exitCode: code }, (dir) => {
      const result = runLauncher(["build", "--manifest-path", "x/Cargo.toml"], { pathPrefix: dir });
      assert.equal(result.status, code, `종료 코드가 ${code}에서 ${result.status}로 바뀌었습니다`);
    });
  }
});

test("인자를 그대로 cargo에 넘긴다", () => {
  withFakeCargo({ exitCode: 0 }, (dir) => {
    const result = runLauncher(["test", "--manifest-path", "a b/Cargo.toml", "--", "--nocapture"], {
      pathPrefix: dir,
    });
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes("fake-cargo test --manifest-path a b/Cargo.toml -- --nocapture"),
      `인자가 변형되었습니다: ${result.stdout}`
    );
  });
});

test("인자 없이 부르면 성공으로 끝나지 않는다", () => {
  const result = runLauncher([]);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("사용법"), result.stderr);
});

test("cargo를 찾지 못하면 조용히 통과하지 않는다", () => {
  // PATH를 비워 cargo를 찾을 수 없게 만든다.
  const empty = mkdtempSync(path.join(tmpdir(), "tomverse-empty-path-"));
  try {
    const result = spawnSync(process.execPath, [LAUNCHER, "build"], {
      encoding: "utf8",
      env: { ...process.env, PATH: empty },
      shell: false,
    });
    assert.notEqual(result.status, 0, "cargo가 없는데 성공으로 끝났습니다");
    assert.ok((result.stderr ?? "").includes("cargo를 찾지 못했습니다"), result.stderr);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// ---- 회귀 5: 자격증명 비노출 ----

test("런처 출력에 API 키나 전체 환경이 섞이지 않는다", () => {
  withFakeCargo({ exitCode: 0 }, (dir) => {
    const result = runLauncher(["build"], {
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
  // MSVC 변수는 병합하지만, 그 외에는 부모 환경 그대로여야 한다 — 예상치 못한 변수를
  // 지어내면 "내 셸에서는 되는데 앱에서는 안 된다"의 반대 방향 혼란이 생긴다.
  withFakeCargo({ exitCode: 0, echoEnv: ["TOMVERSE_LAUNCHER_PROBE"] }, (dir) => {
    const result = runLauncher(["build"], {
      pathPrefix: dir,
      env: { TOMVERSE_LAUNCHER_PROBE: "inherited" },
    });
    assert.ok(result.stdout.includes("TOMVERSE_LAUNCHER_PROBE=inherited"), result.stdout);
  });
});

// ---- clean dist 상태 검증 가능성 ----

test("런처는 빌드된 dist 없이도 실행된다", () => {
  // 이게 무너지면 "Rust를 빌드하려면 TypeScript를 먼저 빌드해야 한다"는 순환이 생기고,
  // clean clone에서 core:build가 막힌다. 런처가 import하는 것이 js/ 소스인지 확인한다.
  const source = readFileSync(LAUNCHER, "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
  for (const specifier of imports) {
    assert.ok(
      !specifier.includes("dist"),
      `런처가 빌드 산출물을 import합니다: ${specifier}`
    );
    if (specifier.startsWith("@tomverse/")) {
      assert.equal(
        specifier,
        "@tomverse/toolchain/exec",
        `런처는 빌드가 필요 없는 서브패스만 써야 합니다: ${specifier}`
      );
    }
  }

  // 실제로도 dist를 건드리지 않는지: 가짜 cargo로 한 번 돌려본다.
  withFakeCargo({ exitCode: 0 }, (dir) => {
    const probe = mkdtempSync(path.join(tmpdir(), "tomverse-launcher-probe-"));
    try {
      mkdirSync(path.join(probe, "unused"), { recursive: true });
      const result = runLauncher(["build"], { pathPrefix: dir });
      assert.equal(result.status, 0);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });
});
