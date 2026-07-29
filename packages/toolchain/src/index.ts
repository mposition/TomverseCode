/**
 * `@tomverse/toolchain` — 빌드 산출물 위치와 네이티브 툴체인 준비.
 *
 * 이 패키지는 **제품 런타임이 아니라 개발·검증 경로**를 위한 것이다. 런타임 의존성이 없고,
 * sidecar에는 `devDependencies`로만 들어간다 — 배포되는 sidecar에 이 코드가 섞이지 않는다.
 *
 * 여기 있는 지식은 전부 "이 저장소가 어떻게 빌드되는가"에 대한 사실이며, 그 사실을 여러
 * 곳에 복사해 두었다가 **한 곳만 고쳐서 Windows e2e가 깨졌던 것**이 이 패키지가 생긴 이유다.
 */

export {
  checkArtifacts,
  describeArtifacts,
  hostBinaryName,
  hostBinaryPath,
  isWindows,
  sidecarEntryPath,
  type ArtifactStatus,
  type Platform,
} from "./hostBinary.js";

export {
  clearMsvcCache,
  defaultRunner,
  interpretMsvcOutcome,
  msvcEnvScriptPath,
  MSVC_ENV_ALLOWLIST,
  needsNativeToolchain,
  parseMsvcEnv,
  prepareMsvcEnv,
  READY_MARKER,
  shellExecutablePath,
  withMsvcEnv,
  type MsvcResult,
  type ScriptRunner,
} from "./msvc.js";

export {
  DEFAULT_PATHEXT,
  findExecutable,
  programStem,
  resolveNodeCli,
  type NodeCliResolution,
  type ResolveEnv,
} from "./nodeCli.js";

export { buildOrder, dependencyGraph, type WorkspaceManifest } from "./buildOrder.js";
