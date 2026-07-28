/**
 * Node CLI shim 해석 — **테스트 하네스와 개발 스크립트 전용.**
 *
 * # 무엇과 구별해야 하는가
 *
 * 제품에서 명령을 실행하는 것은 Rust Tool Runtime이고, 그쪽에는 자체 해석 계층이 있다
 * (`apps/desktop/src-tauri/core/src/tools/program.rs`). 그게 Policy Gate 뒤에 있고,
 * 승인 화면에 표시된 argv와 실제 실행을 일치시킬 책임을 진다.
 *
 * 여기 있는 것은 **fixture 전제 검사**처럼 제품 경로 밖에서 npm을 돌려야 하는 Node 쪽
 * 코드가 쓰는 helper다. 둘을 섞으면 "e2e가 제품 경로를 검증한다"는 주장이 무너진다 —
 * e2e 본체는 반드시 논리 명령 `npm test`를 Rust에 요청해야 한다.
 *
 * 구현은 `js/exec.mjs`에 있다(빌드 순환 회피 — `msvc.ts` 상단 참조).
 */

export { findExecutable, programStem, resolveNodeCli, DEFAULT_PATHEXT } from "@tomverse/toolchain/exec";

export type { NodeCliResolution, ResolveEnv } from "@tomverse/toolchain/exec";
