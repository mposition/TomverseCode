/**
 * Windows 네이티브 툴체인(MSVC) 준비 — **타입을 붙인 재수출이다.**
 *
 * # 문제
 *
 * 일반 PowerShell에서 `cargo build`를 돌리면 컴파일은 되지만 **링크에서** 실패한다:
 *
 * ```text
 * LINK : fatal error LNK1104: cannot open file 'msvcrt.lib'
 * ```
 *
 * `vcvarsall.bat`이 설정하는 `INCLUDE`/`LIB`가 없기 때문이다.
 *
 * # 왜 구현이 여기 없는가
 *
 * `npm run core:build`(=Rust 빌드)가 이 준비 로직을 필요로 한다. 로직이 TypeScript에 있으면
 * **Rust를 빌드하려면 TypeScript를 먼저 빌드해야 하는 순환**이 생기고, clean clone에서는
 * 그 순환이 막다른 길이다. 그래서 구현은 컴파일이 필요 없는 `js/exec.mjs`에 있고,
 * `scripts/cargo.mjs` 런처와 이 모듈이 **같은 함수**를 쓴다.
 *
 * 이 파일은 그 구현에 타입만 붙인다. 새 동작을 여기에 추가하지 말 것 — 추가하면 런처와
 * 갈라지고, 그게 정확히 이 구조가 막으려는 실패다.
 */

export {
  clearMsvcCache,
  defaultRunner,
  interpretMsvcOutcome,
  isWindows as isWindowsPlatform,
  MSVC_ENV_ALLOWLIST,
  msvcEnvScriptPath,
  needsNativeToolchain,
  parseMsvcEnv,
  prepareMsvcEnv,
  READY_MARKER,
  withMsvcEnv,
} from "@tomverse/toolchain/exec";

export type { MsvcResult, ScriptRunner } from "@tomverse/toolchain/exec";
