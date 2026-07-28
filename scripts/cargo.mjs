#!/usr/bin/env node
// @ts-check
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable, prepareMsvcEnv, withMsvcEnv } from "@tomverse/toolchain/exec";

/**
 * cargo 실행 런처 — **Windows에서 MSVC 환경을 먼저 준비한다.**
 *
 * # 왜 있는가
 *
 * 일반 PowerShell에서 `npm run verify`가 `core:build` 단계에서 죽었다:
 *
 * ```text
 * stdarg.h: No such file or directory     (INCLUDE=None, LIB=None, VCINSTALLDIR=None)
 * ```
 *
 * `scripts\verify.bat`은 `_env.bat`을 먼저 call하므로 통과했다. 즉 **두 진입점이 단계
 * 순서는 같은데 환경 준비 의미가 달랐다.** 루트 `package.json`의 cargo 호출이 준비 없이
 * 맨몸으로 나갔기 때문이다.
 *
 * 이 런처가 그 차이를 없앤다. 루트 스크립트도, `.bat` 래퍼도 전부 여기를 지난다.
 *
 * # 왜 일반 JavaScript인가
 *
 * TypeScript로 쓰면 "Rust를 빌드하려면 TypeScript를 먼저 빌드해야 한다"는 순환이 생긴다.
 * 이 파일과 `@tomverse/toolchain/exec`는 둘 다 컴파일이 필요 없다 — `npm ci` 직후
 * 아무것도 빌드하지 않은 상태에서 바로 돈다.
 *
 * # 하지 않는 것
 *
 * - 셸 문자열을 만들지 않는다. `cmd.exe /c "... && ..."` 같은 조합이 없다.
 * - 환경을 출력하지 않는다. 준비 실패 메시지는 `_env.bat`이 낸 안내문뿐이다.
 * - Visual Studio 경로를 알지 못한다 — 탐지는 `_env.bat` 한 곳에만 있다.
 * - 종료 코드를 뭉개지 않는다. cargo가 낸 코드를 그대로 돌려준다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargoArgs = process.argv.slice(2);

if (cargoArgs.length === 0) {
  process.stderr.write("사용법: node scripts/cargo.mjs <cargo 하위 명령> [인자...]\n");
  process.exit(2);
}

const msvc = prepareMsvcEnv(repoRoot, process.platform);
if (msvc.kind === "unavailable") {
  process.stderr.write(`${msvc.message}\n`);
  // `_env.bat`이 낸 코드를 보존한다. 0으로 끝났는데 준비가 안 된 경우(표식 없음 등)에는
  // 0으로 끝낼 수 없으므로 1로 올린다 — "실패인데 성공 코드"가 가장 나쁘다.
  process.exit(msvc.exitCode === 0 ? 1 : Math.abs(msvc.exitCode) || 1);
}

const env = withMsvcEnv({ ...process.env }, msvc);

// cargo를 **절대 경로로** 찾아 spawn한다.
//
// 왜 `spawnSync("cargo", ...)`로 충분하지 않은가: POSIX에서 Node의 spawn은 자식에게 넘긴
// env가 아니라 **부모 프로세스의** PATH로 실행 파일을 찾는다. 방금 병합한 PATH에만 cargo가
// 있는 상황(예: `_env.bat`이 `%USERPROFILE%\.cargo\bin`을 붙인 경우)에서 조용히 못 찾는다.
const executable = findExecutable("cargo", {
  platform: process.platform,
  pathValue: env.PATH ?? env.Path ?? "",
  pathext: env.PATHEXT,
});

if (executable === undefined) {
  process.stderr.write(
    [
      "cargo를 찾지 못했습니다.",
      "  Rust 툴체인이 설치되어 있는지, PATH에 있는지 확인하세요 (https://rustup.rs).",
      "  Windows에서 winget으로 방금 설치했다면 새 셸을 열어야 PATH에 반영됩니다.",
      "",
    ].join("\n")
  );
  process.exit(127);
}

const result = spawnSync(executable, cargoArgs, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
  // 셸을 거치지 않는다 — 인자의 공백이나 메타문자가 재해석되지 않아야 한다.
  shell: false,
});

if (result.error) {
  process.stderr.write(`cargo를 실행할 수 없습니다: ${result.error.message}\n`);
  process.exit(126);
}
if (result.signal) {
  // 시그널로 죽은 것을 성공으로 보고하지 않는다.
  process.stderr.write(`cargo가 시그널 ${result.signal}로 종료되었습니다.\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
