import { existsSync } from "node:fs";
import path from "node:path";

/**
 * `tomverse-host` 바이너리의 위치.
 *
 * # 왜 공용 모듈인가
 *
 * 이 지식("cargo가 어디에 무슨 이름으로 산출물을 놓는가")을 필요로 하는 곳이 셋이다:
 * `packages/sidecar/test/e2e.test.ts`, `e2e-persistence.test.ts`,
 * `evals/hypothesis-gate/src/host.ts`.
 *
 * 셋이 각자 경로를 조립하고 있었고, 그 결과 **e2e 두 곳만 Windows에서 틀렸다** — 확장자 없는
 * `tomverse-host`를 찾아 clean Windows 환경에서 "산출물이 없습니다"로 실패했다.
 * 같은 사실을 세 군데에 복사해 두면 한 군데만 고치는 일이 반드시 생긴다.
 *
 * # 순수 함수로 두는 이유
 *
 * 이 저장소의 CI/개발 환경은 Linux지만 **제품의 대상은 Windows다.** `process.platform`을
 * 직접 읽으면 Linux에서는 Windows 분기를 영원히 검증할 수 없다. 그래서 플랫폼을 인자로 받고,
 * 실제 플랫폼을 쓰는 것은 최상위 상수 한 곳뿐이다.
 */

/** `process.platform`이 주는 값 중 우리가 구별하는 것. */
export type Platform = NodeJS.Platform;

export function isWindows(platform: Platform): boolean {
  return platform === "win32";
}

/**
 * 플랫폼별 실행 파일 이름.
 *
 * Windows에서만 `.exe`가 붙는다. macOS/Linux는 확장자가 없다.
 */
export function hostBinaryName(platform: Platform): string {
  return isWindows(platform) ? "tomverse-host.exe" : "tomverse-host";
}

/** 저장소 루트 기준 `tomverse-host` 절대 경로. cargo의 debug 프로필 산출물 위치다. */
export function hostBinaryPath(repoRoot: string, platform: Platform): string {
  return path.join(
    repoRoot,
    "apps",
    "desktop",
    "src-tauri",
    "core",
    "target",
    "debug",
    hostBinaryName(platform)
  );
}

/** sidecar 진입점 (Node가 실행할 번들 결과). 플랫폼과 무관하다. */
export function sidecarEntryPath(repoRoot: string): string {
  return path.join(repoRoot, "packages", "sidecar", "dist", "src", "index.js");
}

export interface ArtifactStatus {
  ok: boolean;
  hostBinary: string;
  hostBinaryPresent: boolean;
  sidecarEntry: string;
  sidecarEntryPresent: boolean;
  /** 사람이 읽는 설명 — **검사한 전체 경로가 반드시 들어간다.** */
  detail: string;
}

/**
 * 실행에 필요한 산출물이 있는지.
 *
 * 없을 때 **검사한 전체 경로를 그대로 보여준다.** "산출물이 없습니다"만 출력하면 사용자는
 * 어디를 봐야 할지 모른다 — 특히 Windows에서 `.exe`가 붙는지 여부가 원인일 때
 * 경로가 없으면 원인에 도달할 방법이 없다.
 */
export function checkArtifacts(repoRoot: string, platform: Platform): ArtifactStatus {
  const hostBinary = hostBinaryPath(repoRoot, platform);
  const sidecarEntry = sidecarEntryPath(repoRoot);
  const hostBinaryPresent = existsSync(hostBinary);
  const sidecarEntryPresent = existsSync(sidecarEntry);

  return {
    ok: hostBinaryPresent && sidecarEntryPresent,
    hostBinary,
    hostBinaryPresent,
    sidecarEntry,
    sidecarEntryPresent,
    detail: describeArtifacts({
      hostBinary,
      hostBinaryPresent,
      sidecarEntry,
      sidecarEntryPresent,
    }),
  };
}

/** 존재 여부 판정과 분리해 둔 메시지 생성 — 파일 시스템 없이 테스트할 수 있다. */
export function describeArtifacts(input: {
  hostBinary: string;
  hostBinaryPresent: boolean;
  sidecarEntry: string;
  sidecarEntryPresent: boolean;
}): string {
  return [
    "e2e 실행에 필요한 산출물이 없습니다.",
    `  호스트 바이너리: ${input.hostBinary} (${input.hostBinaryPresent ? "있음" : "없음"})`,
    `  sidecar 진입점: ${input.sidecarEntry} (${input.sidecarEntryPresent ? "있음" : "없음"})`,
    "먼저 실행하세요:",
    "  npm run build",
    "  npm run core:build",
  ].join("\n");
}
