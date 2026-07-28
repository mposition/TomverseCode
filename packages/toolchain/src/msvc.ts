import { spawnSync } from "node:child_process";
import path from "node:path";
import { isWindows, type Platform } from "./hostBinary.js";

/**
 * Windows 네이티브 툴체인(MSVC) 준비.
 *
 * # 문제
 *
 * 일반 PowerShell에서 `cargo test`를 돌리면 컴파일은 되지만 **링크에서** 실패한다:
 *
 * ```text
 * LINK : fatal error LNK1104: cannot open file 'msvcrt.lib'
 * ```
 *
 * `vcvarsall.bat`이 설정하는 `INCLUDE`/`LIB`가 없기 때문이다. 사용자가
 * `cmd.exe /d /c "call scripts\_env.bat && ..."`를 매번 기억해야 하는 상태였다.
 *
 * # 해법
 *
 * 고정된 내부 스크립트(`scripts/msvc-env.bat`)를 **구조화된 argv로** 한 번 실행해
 * 필요한 환경변수만 받아오고, cargo를 부르는 자식 프로세스에만 병합한다.
 *
 * 이 방식을 고른 이유:
 *  - 전체 CLI를 `cmd.exe`로 재실행하지 않는다 — 재실행은 인자 인용 문제를 다시 만든다
 *  - 셸 문자열을 조합하지 않는다. 프로그램과 인자가 모두 고정 상수다
 *  - `_env.bat`의 Visual Studio 탐지 로직을 복제하지 않는다. 그건 한 곳에만 있어야 한다
 *  - **자격증명이 버퍼에 들어오지 않는다.** 배치가 `set`으로 전체 환경을 덤프하지 않고
 *    필요한 변수만 출력하며, 이쪽에서도 allowlist로 한 번 더 거른다
 *
 * # 비 Windows
 *
 * 아무것도 하지 않는다. `prepareMsvcEnv`는 `{ kind: "not_needed" }`를 돌려주고
 * 호출자는 환경을 그대로 쓴다.
 */

/** 배치에서 받아 실제로 병합할 변수. 이 목록에 없는 것은 버린다. */
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
] as const;

/** 준비가 됐음을 배치가 알리는 표식. 이게 없으면 출력이 잘린 것으로 본다. */
const READY_MARKER = "TOMVERSE_MSVC_OK";

export type MsvcResult =
  | { kind: "not_needed" }
  | { kind: "ready"; env: Record<string, string> }
  | { kind: "unavailable"; exitCode: number; message: string };

export interface ScriptRunner {
  (program: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string };
}

/** 실제 실행기. 테스트는 자체 runner를 주입한다 — Linux에서도 Windows 분기를 검증할 수 있어야 한다. */
export const defaultRunner: ScriptRunner = (program, args) => {
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

export function msvcEnvScriptPath(repoRoot: string): string {
  return path.join(repoRoot, "scripts", "msvc-env.bat");
}

/**
 * `KEY=VALUE` 줄을 allowlist로 걸러 파싱한다.
 *
 * 값에 `=`가 들어갈 수 있으므로(경로에는 없지만 방어적으로) **첫 `=`에서만** 자른다.
 * allowlist 밖 이름은 통째로 버린다 — 배치가 실수로 더 출력해도 여기서 막힌다.
 */
export function parseMsvcEnv(stdout: string): { ready: boolean; env: Record<string, string> } {
  const allowed = new Set<string>(MSVC_ENV_ALLOWLIST);
  const env: Record<string, string> = {};
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
    const canonical = [...allowed].find((a) => a.toLowerCase() === key.toLowerCase());
    if (canonical === undefined) continue;
    // 비어 있는 값은 병합하지 않는다 — 기존 값을 빈 문자열로 덮어쓰면 오히려 망가진다.
    if (value.length > 0) env[canonical] = value;
  }
  return { ready, env };
}

/**
 * MSVC 환경을 준비한다. **결과는 캐시된다** — 배치 실행은 수 초가 걸리고,
 * fixture마다 반복하면 검증 시간이 몇 배가 된다.
 */
let cached: { key: string; result: MsvcResult } | undefined;

export function prepareMsvcEnv(
  repoRoot: string,
  platform: Platform,
  runner: ScriptRunner = defaultRunner,
  options: { useCache?: boolean } = {}
): MsvcResult {
  if (!isWindows(platform)) return { kind: "not_needed" };

  const useCache = options.useCache ?? true;
  const key = repoRoot;
  if (useCache && cached?.key === key) return cached.result;

  const script = msvcEnvScriptPath(repoRoot);
  // `cmd.exe /d /c <script>` — /d는 AutoRun 레지스트리 스크립트를 건너뛴다(재현성).
  // 프로그램·플래그·스크립트 경로 셋 다 우리가 만든 값이며 사용자 입력이 섞이지 않는다.
  const outcome = runner("cmd.exe", ["/d", "/c", script]);
  const result = interpretMsvcOutcome(outcome, script);

  if (useCache) cached = { key, result };
  return result;
}

/** 테스트가 캐시를 비울 수 있게 한다 — 캐시 때문에 다른 케이스가 섞이면 안 된다. */
export function clearMsvcCache(): void {
  cached = undefined;
}

/**
 * 실행 결과 해석. **`_env.bat`의 종료 코드를 보존한다.**
 *
 * MSVC가 없을 때 `_env.bat`은 안내 문구를 출력하고 1로 끝난다. 그 코드와 문구를 그대로
 * 전달해야 사용자가 "무엇을 설치해야 하는지"에 도달한다 — 여기서 뭉개면 나중에
 * `LNK1104: cannot open file 'msvcrt.lib'`라는 훨씬 먼 증상으로만 드러난다.
 */
export function interpretMsvcOutcome(
  outcome: { status: number | null; stdout: string; stderr: string },
  scriptPath: string
): MsvcResult {
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
        "Rust fixture를 빌드하려면 Visual Studio Build Tools 2022 +",
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

/**
 * 자식 프로세스 환경에 MSVC 변수를 병합한다.
 *
 * 준비되지 않았거나 불필요하면 **원본을 그대로 돌려준다** — 조용히 절반만 적용하지 않는다.
 */
export function withMsvcEnv(base: NodeJS.ProcessEnv, result: MsvcResult): NodeJS.ProcessEnv {
  if (result.kind !== "ready") return base;
  return { ...base, ...result.env };
}

/**
 * 이 명령이 네이티브 툴체인을 필요로 하는가.
 *
 * 지금은 cargo뿐이다. TypeScript fixture(`node`)는 MSVC가 없어도 돌아야 하고, 그래서
 * MSVC가 없는 환경에서도 24개 중 20개는 여전히 검증할 수 있다 — 전부 막아버리면
 * 툴체인이 없는 사람은 아무것도 확인하지 못한다.
 */
export function needsNativeToolchain(program: string): boolean {
  // `path.basename`은 실행 중인 OS의 구분자만 안다. Linux에서 Windows 경로
  // (`C:\\Users\\me\\.cargo\\bin\\cargo.exe`)를 판정해야 하므로 둘 다 직접 자른다 —
  // 이 함수는 "지금 어느 OS인가"와 무관하게 답할 수 있어야 테스트가 성립한다.
  const base = program.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base === "cargo" || base === "cargo.exe" || base === "rustc" || base === "rustc.exe";
}
