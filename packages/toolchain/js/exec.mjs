// @ts-check
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

/**
 * 공용 실행 계층 — **일반 JavaScript다. 빌드가 필요 없다.**
 *
 * # 왜 TypeScript가 아닌가
 *
 * `npm run core:build`는 Rust를 빌드한다. 그런데 Windows에서 그러려면 MSVC 환경 준비가
 * 먼저 필요하고, 그 준비 로직이 TypeScript로 작성되면 **"Rust를 빌드하려면 TypeScript를 먼저
 * 빌드해야 한다"는 순환**이 생긴다. clean clone에서는 그 순환이 곧 막다른 길이다.
 *
 * 그래서 준비 로직은 컴파일이 필요 없는 곳에 두고, TypeScript 쪽
 * (`src/msvc.ts`, `src/nodeCli.ts`)은 **여기를 타입만 붙여 다시 내보낸다.** 구현은 하나다 —
 * 런처(`scripts/cargo.mjs`)와 가설 게이트가 갈라질 수 없다.
 *
 * # 이 모듈이 하는 두 가지
 *
 * 1. **MSVC 환경 준비** — `scripts/msvc-env.bat`을 고정 argv로 한 번 실행해 allowlist된
 *    변수만 받아온다.
 * 2. **실행 파일 해석** — PATH/PATHEXT를 직접 훑어 실제 실행 대상을 찾는다. Node의
 *    `spawn`은 POSIX에서 **부모 프로세스의** PATH로 탐색하므로, 방금 병합한 PATH를 반영하려면
 *    우리가 직접 찾아 절대 경로로 spawn해야 한다.
 */

// ---------------------------------------------------------------------------
// MSVC 환경
// ---------------------------------------------------------------------------

/**
 * 배치에서 받아 실제로 병합할 변수. 이 목록에 없는 것은 버린다.
 * @type {readonly string[]}
 */
export const MSVC_ENV_ALLOWLIST = [
  "PATH",
  "INCLUDE",
  "LIB",
  "LIBPATH",
  "VSCMD_ARG_TGT_ARCH",
  "VCINSTALLDIR",
  "WindowsSdkDir",
  "WindowsSdkVersion",
  "UniversalCRTSdkDir",
  "UCRTVersion",
];

/** 준비가 됐음을 배치가 알리는 표식. 이게 없으면 출력이 잘린 것으로 본다. */
export const READY_MARKER = "TOMVERSE_MSVC_OK";

/**
 * @param {string} platform
 * @returns {boolean}
 */
export function isWindows(platform) {
  return platform === "win32";
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function msvcEnvScriptPath(repoRoot) {
  return path.join(repoRoot, "scripts", "msvc-env.bat");
}

/**
 * 배치를 돌릴 셸의 **절대 경로**.
 *
 * `"cmd.exe"`라는 이름으로 spawn하면 PATH에 System32가 있어야 한다. 보통은 있지만 PATH를
 * 좁혀 놓은 환경에서는 `spawnSync cmd.exe ENOENT`가 나고, 그 증상은 "MSVC 준비 실패"로
 * 보고되어 **원인에서 멀다.** cmd.exe 위치는 Windows가 `%ComSpec%`로 알려주는 값이므로
 * 굳이 PATH에 의존할 이유가 없다.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function shellExecutablePath(env = process.env) {
  const comspec = env.ComSpec ?? env.COMSPEC ?? env.comspec;
  if (comspec !== undefined && comspec.trim().length > 0) return comspec;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.systemroot;
  if (systemRoot !== undefined && systemRoot.trim().length > 0) {
    return `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\cmd.exe`;
  }
  // 둘 다 없으면 이름으로 시도한다 — 여기까지 오면 환경이 이미 비정상이다.
  return "cmd.exe";
}

/**
 * 실제 실행기. 테스트는 자체 runner를 주입한다 — Linux에서도 Windows 분기를 검증할 수 있어야 한다.
 * @type {(program: string, args: readonly string[]) => { status: number | null, stdout: string, stderr: string }}
 */
export const defaultRunner = (program, args) => {
  const result = spawnSync(program, [...args], {
    encoding: "utf8",
    // 셸을 거치지 않는다: argv 계약을 깨면 인자가 셸에 해석될 수 있다.
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? `${result.stderr ?? ""}\n${result.error.message}` : (result.stderr ?? ""),
  };
};

/**
 * `KEY=VALUE` 줄을 allowlist로 걸러 파싱한다.
 *
 * 값에 `=`가 들어갈 수 있으므로(경로에는 없지만 방어적으로) **첫 `=`에서만** 자른다.
 * allowlist 밖 이름은 통째로 버린다 — 배치가 실수로 더 출력해도 여기서 막힌다.
 *
 * @param {string} stdout
 * @returns {{ ready: boolean, env: Record<string, string> }}
 */
export function parseMsvcEnv(stdout) {
  /** @type {Record<string, string>} */
  const env = {};
  let ready = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === READY_MARKER) {
      ready = value === "1";
      continue;
    }
    // 이름은 Windows에서 대소문자를 구별하지 않으므로 allowlist 비교도 그렇게 한다.
    const canonical = MSVC_ENV_ALLOWLIST.find((a) => a.toLowerCase() === key.toLowerCase());
    if (canonical === undefined) continue;
    // 비어 있는 값은 병합하지 않는다 — 기존 값을 빈 문자열로 덮어쓰면 오히려 망가진다.
    if (value.length > 0) env[canonical] = value;
  }
  return { ready, env };
}

/**
 * 실행 결과 해석. **`_env.bat`의 종료 코드를 보존한다.**
 *
 * MSVC가 없을 때 `_env.bat`은 안내 문구를 출력하고 1로 끝난다. 그 코드와 문구를 그대로
 * 전달해야 사용자가 "무엇을 설치해야 하는지"에 도달한다 — 여기서 뭉개면 나중에
 * `LNK1104: cannot open file 'msvcrt.lib'`라는 훨씬 먼 증상으로만 드러난다.
 *
 * @param {{ status: number | null, stdout: string, stderr: string }} outcome
 * @param {string} scriptPath
 * @returns {import("./exec.d.mts").MsvcResult}
 */
export function interpretMsvcOutcome(outcome, scriptPath) {
  if (outcome.status === null) {
    return {
      kind: "unavailable",
      exitCode: -1,
      message: [
        `MSVC 환경 준비 스크립트를 실행하지 못했습니다: ${scriptPath}`,
        outcome.stderr.trim(),
        "cmd.exe를 찾을 수 없거나 스크립트가 없습니다.",
      ]
        .filter((l) => l.length > 0)
        .join("\n"),
    };
  }

  if (outcome.status !== 0) {
    return {
      kind: "unavailable",
      exitCode: outcome.status,
      message: [
        `MSVC 빌드 도구를 준비하지 못했습니다 (종료 코드 ${outcome.status}).`,
        `스크립트: ${scriptPath}`,
        outcome.stdout.trim(),
        outcome.stderr.trim(),
        "",
        "Rust를 빌드하려면 Visual Studio Build Tools 2022 +",
        '"C++를 사용한 데스크톱 개발" 워크로드가 필요합니다.',
      ]
        .filter((l) => l.length > 0)
        .join("\n"),
    };
  }

  const parsed = parseMsvcEnv(outcome.stdout);
  if (!parsed.ready) {
    return {
      kind: "unavailable",
      exitCode: 0,
      message: [
        `MSVC 환경 준비 스크립트가 0으로 끝났지만 준비 표식이 없습니다: ${scriptPath}`,
        "출력이 잘렸거나 스크립트가 예상과 다르게 동작했습니다.",
      ].join("\n"),
    };
  }
  if (parsed.env.INCLUDE === undefined || parsed.env.LIB === undefined) {
    return {
      kind: "unavailable",
      exitCode: 0,
      message: [
        "MSVC 환경이 준비됐다고 보고했지만 INCLUDE/LIB가 비어 있습니다.",
        "이 상태로 진행하면 컴파일은 되고 링크에서 LNK1104(msvcrt.lib)로 실패합니다.",
        `스크립트: ${scriptPath}`,
      ].join("\n"),
    };
  }
  return { kind: "ready", env: parsed.env };
}

/** @type {{ key: string, result: import("./exec.d.mts").MsvcResult } | undefined} */
let cached;

/**
 * MSVC 환경을 준비한다. **결과는 캐시된다** — 배치 실행은 수 초가 걸리고,
 * fixture마다 반복하면 검증 시간이 몇 배가 된다.
 *
 * @param {string} repoRoot
 * @param {string} platform
 * @param {(program: string, args: readonly string[]) => { status: number | null, stdout: string, stderr: string }} [runner]
 * @param {{ useCache?: boolean }} [options]
 * @returns {import("./exec.d.mts").MsvcResult}
 */
export function prepareMsvcEnv(repoRoot, platform, runner = defaultRunner, options = {}) {
  if (!isWindows(platform)) return { kind: "not_needed" };

  const useCache = options.useCache ?? true;
  const key = repoRoot;
  if (useCache && cached?.key === key) return cached.result;

  const script = msvcEnvScriptPath(repoRoot);
  // `<cmd.exe> /d /c <script>` — /d는 AutoRun 레지스트리 스크립트를 건너뛴다(재현성).
  // 프로그램·플래그·스크립트 경로 셋 다 우리가 만든 값이며 사용자 입력이 섞이지 않는다.
  // 셸 경로는 PATH가 아니라 %ComSpec%에서 얻는다 — 이유는 shellExecutablePath 참조.
  const outcome = runner(shellExecutablePath(), ["/d", "/c", script]);
  const result = interpretMsvcOutcome(outcome, script);

  if (useCache) cached = { key, result };
  return result;
}

/** 테스트가 캐시를 비울 수 있게 한다 — 캐시 때문에 다른 케이스가 섞이면 안 된다. */
export function clearMsvcCache() {
  cached = undefined;
}

/**
 * 자식 프로세스 환경에 MSVC 변수를 병합한다.
 *
 * 준비되지 않았거나 불필요하면 **원본을 그대로 돌려준다** — 조용히 절반만 적용하지 않는다.
 *
 * # 왜 단순 스프레드가 아닌가
 *
 * Windows 환경변수는 **대소문자를 구별하지 않는다.** `process.env`를 평범한 객체로 펼치면
 * 키가 Windows가 준 철자 그대로(보통 `Path`) 들어오는데, 여기에 `PATH`를 대입하면
 * **두 키가 모두** 자식에게 전달된다. 어느 쪽이 이길지는 정해져 있지 않고, 지면 방금 준비한
 * MSVC 경로가 통째로 무시되어 다시 링크 단계에서 실패한다.
 *
 * 그래서 대소문자만 다른 기존 키를 지우고 대입한다. Linux에서는 이 루프가 아무것도 하지 않는다
 * (거기서는 정말로 서로 다른 변수이므로 지우면 안 되고, 실제로 겹칠 일도 없다).
 *
 * @param {Record<string, string | undefined>} base
 * @param {import("./exec.d.mts").MsvcResult} result
 * @returns {Record<string, string | undefined>}
 */
export function withMsvcEnv(base, result) {
  if (result.kind !== "ready") return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(result.env)) {
    for (const existing of Object.keys(merged)) {
      if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * 이 명령이 네이티브 툴체인을 필요로 하는가.
 *
 * 지금은 cargo뿐이다. TypeScript fixture(`node`)는 MSVC가 없어도 돌아야 하고, 그래서
 * MSVC가 없는 환경에서도 24개 중 20개는 여전히 검증할 수 있다 — 전부 막아버리면
 * 툴체인이 없는 사람은 아무것도 확인하지 못한다.
 *
 * @param {string} program
 * @returns {boolean}
 */
export function needsNativeToolchain(program) {
  const base = programStem(program);
  return base === "cargo" || base === "rustc";
}

// ---------------------------------------------------------------------------
// 실행 파일 해석
// ---------------------------------------------------------------------------

/** Windows에서 확장자 없이 부른 이름에 붙여볼 확장자 기본값. */
export const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * 경로에서 확장자를 뗀 소문자 basename.
 *
 * `path.basename`을 쓰지 않는다 — 실행 중인 OS의 구분자만 알기 때문에 Linux에서
 * `C:\Users\me\npm.cmd`를 판정할 수 없다. 이 함수는 "지금 어느 OS인가"와 무관해야
 * 테스트가 성립한다.
 *
 * @param {string} program
 * @returns {string}
 */
export function programStem(program) {
  const base = program.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.toLowerCase();
}

/** @param {string} program */
function programExtension(program) {
  const base = program.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * **대상 플랫폼의** 경로 API. `path`를 그대로 쓰면 실행 중인 OS의 구분자를 쓰므로,
 * Linux에서 Windows 경로를 조립하면 `C:\nodejs/node.exe` 같은 혼합이 나온다.
 * 실제 Windows에서는 우연히 맞지만, 그러면 **Windows 분기를 Linux에서 검증할 수 없다** —
 * `.exe` 결함이 살아남은 것과 같은 종류의 구멍이다.
 *
 * @param {string} platform
 */
function pathFor(platform) {
  return isWindows(platform) ? path.win32 : path.posix;
}

/** @param {string} p */
function defaultIsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * PATH와 PATHEXT로 실제 실행 파일을 찾는다.
 *
 * 순수 함수로 두는 이유는 `hostBinary.ts`와 같다 — 이 저장소의 개발 환경은 Linux이고
 * 제품 대상은 Windows다. 플랫폼·PATH·파일 존재 판정을 전부 인자로 받아야 Windows 분기를
 * Linux에서 검증할 수 있다.
 *
 * @param {string} program
 * @param {{ platform: string, pathValue?: string, pathext?: string, isFile?: (p: string) => boolean }} env
 * @returns {string | undefined} 찾은 절대/상대 경로. 못 찾으면 undefined.
 */
export function findExecutable(program, env) {
  const isFile = env.isFile ?? defaultIsFile;
  const windows = isWindows(env.platform);
  const p = pathFor(env.platform);
  const separator = windows ? ";" : ":";
  const extensions = windows
    ? (env.pathext ?? DEFAULT_PATHEXT.join(";"))
        .split(";")
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
        .map((e) => (e.startsWith(".") ? e : `.${e}`))
    : [];

  /** @param {string} candidate */
  const probe = (candidate) => {
    if (isFile(candidate)) return candidate;
    if (!windows) return undefined;
    // 확장자를 이미 갖고 있으면 덧붙이지 않는다 — `npm.cmd.exe`를 찾으려 들면 안 된다.
    if (programExtension(program).length > 0) return undefined;
    for (const ext of extensions) {
      // PATHEXT는 대문자로 오는 것이 보통이지만 파일은 소문자다. 둘 다 시도한다 —
      // 대소문자 비구분 파일 시스템에서는 첫 시도가 맞고, 아니면 두 번째가 맞는다.
      for (const cased of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
        if (isFile(candidate + cased)) return candidate + cased;
      }
    }
    return undefined;
  };

  // 경로 구분자가 들어 있으면 PATH를 뒤지지 않는다 — 지정된 위치만 본다.
  if (/[\\/]/.test(program)) return probe(program);

  for (const dir of (env.pathValue ?? "").split(separator)) {
    if (dir.trim().length === 0) continue;
    const found = probe(p.join(dir, program));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Windows에서 `npm`/`npx`를 **셸 없이** 실행할 수 있는 argv로 바꾼다.
 *
 * Windows의 npm은 `npm.exe`가 아니라 `npm.cmd`(배치 shim)이므로 `shell: false`로는 실행되지
 * 않는다. `cmd.exe /c`로 감싸면 실행은 되지만 인자가 셸에 재해석되어 argv 계약이 깨진다.
 * 그래서 shim이 실제로 부르는 것 — Node + `npm-cli.js` — 를 우리가 직접 조립한다.
 *
 * **구조를 확인할 수 없으면 추측하지 않고 실패한다.** 잘못 추측한 경로로 실행하는 것보다
 * "무엇을 못 찾았는지" 말하고 멈추는 편이 낫다.
 *
 * 이건 **테스트 하네스와 개발 스크립트용**이다. 제품의 명령 실행은 Rust Tool Runtime의
 * 해석 계층(`tools/program.rs`)이 담당하며, 그쪽이 Policy Gate 뒤에 있다.
 *
 * @param {string} program
 * @param {readonly string[]} args
 * @param {{ platform: string, pathValue?: string, pathext?: string, isFile?: (p: string) => boolean, execPath?: string }} env
 * @returns {{ ok: true, executable: string, args: string[], kind: "passthrough" | "node-cli" } | { ok: false, message: string }}
 */
export function resolveNodeCli(program, args, env) {
  const isFile = env.isFile ?? defaultIsFile;

  if (!isWindows(env.platform)) {
    return { ok: true, executable: program, args: [...args], kind: "passthrough" };
  }

  const found = findExecutable(program, env);
  if (found === undefined) {
    return { ok: false, message: `PATH에서 ${program}을(를) 찾지 못했습니다.` };
  }

  const extension = programExtension(found);
  if (extension !== ".cmd" && extension !== ".bat") {
    // .exe는 그대로 실행하면 된다.
    return { ok: true, executable: found, args: [...args], kind: "passthrough" };
  }

  const stem = programStem(found);
  const cliName = stem === "npm" ? "npm-cli.js" : stem === "npx" ? "npx-cli.js" : undefined;
  if (cliName === undefined) {
    return {
      ok: false,
      message: `${found}는 알려지지 않은 배치 shim입니다 — 셸로 실행하지 않습니다.`,
    };
  }

  const p = pathFor(env.platform);
  const shimDir = p.dirname(found);
  const nodeExe = p.join(shimDir, "node.exe");
  const cliScript = p.join(shimDir, "node_modules", "npm", "bin", cliName);
  const missing = [
    isFile(nodeExe) ? undefined : nodeExe,
    isFile(cliScript) ? undefined : cliScript,
  ].filter((m) => m !== undefined);

  if (missing.length > 0) {
    // execPath로 대체할 수는 있지만, 그러면 shim이 가리키는 npm과 다른 npm을 부를 수 있다.
    return {
      ok: false,
      message: [
        `${found}의 Node 설치 구조를 확인하지 못했습니다.`,
        ...missing.map((m) => `  없음: ${m}`),
      ].join("\n"),
    };
  }

  return { ok: true, executable: nodeExe, args: [cliScript, ...args], kind: "node-cli" };
}
