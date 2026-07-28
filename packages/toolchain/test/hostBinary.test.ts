import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  checkArtifacts,
  describeArtifacts,
  hostBinaryName,
  hostBinaryPath,
  isWindows,
  sidecarEntryPath,
} from "../src/hostBinary.js";

/**
 * 회귀 테스트 1·2 — 호스트 바이너리 경로.
 *
 * **현재 OS에 종속되지 않는다.** 이 저장소의 개발/CI 환경은 Linux인데 제품의 대상은
 * Windows다. `process.platform`을 직접 읽는 코드는 Linux에서 Windows 분기를 영원히
 * 검증하지 못하고, 실제로 그래서 e2e 두 파일이 확장자 없는 이름을 찾은 채로 통과했다.
 */

const REPO = path.join(path.sep, "repo");

test("Windows 호스트 경로에 .exe가 포함된다", () => {
  assert.equal(hostBinaryName("win32"), "tomverse-host.exe");
  const resolved = hostBinaryPath(REPO, "win32");
  assert.ok(resolved.endsWith("tomverse-host.exe"), resolved);
});

test("비 Windows 호스트 경로에는 .exe가 없다", () => {
  for (const platform of ["linux", "darwin", "freebsd"] as const) {
    assert.equal(hostBinaryName(platform), "tomverse-host", `${platform}에 확장자가 붙었습니다`);
    const resolved = hostBinaryPath(REPO, platform);
    assert.ok(!resolved.includes(".exe"), `${platform}: ${resolved}`);
    assert.ok(resolved.endsWith("tomverse-host"), resolved);
  }
});

test("경로는 cargo debug 산출물 위치를 가리킨다", () => {
  // 이 순서가 틀리면 바이너리를 못 찾는다. 문자열 조립이 아니라 구조를 확인한다.
  const resolved = hostBinaryPath(REPO, "linux");
  const segments = resolved.split(path.sep).filter(Boolean);
  const tail = segments.slice(-7);
  assert.deepEqual(tail, [
    "apps",
    "desktop",
    "src-tauri",
    "core",
    "target",
    "debug",
    "tomverse-host",
  ]);
});

test("절대 경로가 만들어진다", () => {
  for (const platform of ["win32", "linux"] as const) {
    assert.ok(path.isAbsolute(hostBinaryPath(REPO, platform)), `${platform}에서 상대 경로가 나왔습니다`);
  }
  assert.ok(path.isAbsolute(sidecarEntryPath(REPO)));
});

test("sidecar 진입점은 플랫폼과 무관하다", () => {
  // Node 스크립트이므로 확장자가 바뀌지 않는다. 여기에 .exe가 붙으면 실행이 깨진다.
  assert.ok(sidecarEntryPath(REPO).endsWith(path.join("dist", "src", "index.js")));
});

test("isWindows는 win32만 참이다", () => {
  assert.equal(isWindows("win32"), true);
  assert.equal(isWindows("linux"), false);
  assert.equal(isWindows("darwin"), false);
});

test("산출물이 없다는 메시지에 검사한 전체 경로가 들어간다", () => {
  // "산출물이 없습니다"만 나오면 사용자는 어디를 봐야 할지 모른다.
  // 특히 Windows에서 .exe 여부가 원인일 때 경로가 없으면 원인에 도달할 방법이 없다.
  const hostBinary = hostBinaryPath(REPO, "win32");
  const sidecarEntry = sidecarEntryPath(REPO);
  const detail = describeArtifacts({
    hostBinary,
    hostBinaryPresent: false,
    sidecarEntry,
    sidecarEntryPresent: true,
  });
  assert.ok(detail.includes(hostBinary), `전체 경로가 없습니다:\n${detail}`);
  assert.ok(detail.includes(sidecarEntry), `sidecar 경로가 없습니다:\n${detail}`);
  assert.ok(detail.includes("없음"));
  assert.ok(detail.includes("있음"));
  // 무엇을 실행해야 하는지도 알려준다.
  assert.ok(detail.includes("npm run core:build"));
});

test("실제 저장소에서 산출물 상태를 조회할 수 있다", () => {
  // 존재 여부는 환경에 따라 다르므로 단정하지 않는다. 형태와 경로만 확인한다.
  const status = checkArtifacts(REPO, "linux");
  assert.equal(typeof status.ok, "boolean");
  assert.equal(status.hostBinary, hostBinaryPath(REPO, "linux"));
  assert.equal(status.sidecarEntry, sidecarEntryPath(REPO));
  assert.equal(status.ok, status.hostBinaryPresent && status.sidecarEntryPresent);
});
