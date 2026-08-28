/**
 * 동봉 sidecar 번들의 **레이아웃과 런타임 핀** — 한 곳에서만 선언한다.
 *
 * # 왜 일반 JavaScript인가
 *
 * `exec.mjs`와 같은 이유다. 스테이징은 Rust 번들을 만들기 전에 돌고, 핀을 다시 잡는
 * 명령(`pin-node-runtime.mjs`)은 워크스페이스 빌드와 무관하게 돌아야 한다. TypeScript에 두면
 * "번들을 만들려면 TypeScript를 먼저 빌드해야 한다"는 순환이 생긴다.
 *
 * # 왜 레이아웃 상수가 여기 있는가
 *
 * 찾는 쪽은 Rust다(`launcher.rs`의 `BUNDLE_DIR`/`ENTRY_FILE`/`runtime_file_name`). 넣는 쪽은
 * 이 파일이다. **둘이 갈라지면 증상이 "설치본이 PATH의 node로 돈다"**인데, 그건 조용하다 —
 * 앱은 뜨고, 개발 머신에는 node가 있으므로 아무 일도 일어나지 않은 것처럼 보인다. 배포된
 * 머신에서만 다르게 죽는다.
 *
 * 그래서 목록을 두 벌 두지 않고, `packages/toolchain/test/sidecarBundle.test.ts`가
 * **launcher.rs를 직접 읽어** 아래 상수와 대조한다. 이 저장소가 `engines.node`와
 * `MIN_NODE_MAJOR`에 쓰는 방식과 같다.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `new URL(import.meta.url).pathname`은 Windows에서 드라이브 문자 앞에 슬래시를 붙인다.
// `fileURLToPath`만 플랫폼 규칙을 안다(CLAUDE.md 함정 기록).
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 동봉 런타임과 sidecar가 들어가는 디렉터리 이름. `launcher.rs`의 `BUNDLE_DIR`. */
export const BUNDLE_DIR = "sidecar";
/** sidecar 진입점 파일 이름. `launcher.rs`의 `ENTRY_FILE`. */
export const ENTRY_FILE = "index.js";
/** 번들이 자기 자신을 설명하는 파일. Rust의 착지 검사가 이걸 읽어 node.exe를 다시 해싱한다. */
export const MANIFEST_FILE = "manifest.json";
/** 동봉한 Node 런타임의 라이선스. 우리 JS의 라이선스와 헷갈리지 않게 이름을 붙인다. */
export const RUNTIME_LICENSE_FILE = "node.LICENSE";

/** 이 코드가 읽고 쓰는 manifest 형식. 의미가 바뀌면 올린다. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 스테이징 디렉터리의 기본 자리 — **저장소 루트 기준 POSIX 상대 경로**.
 *
 * `tauri.conf.json`의 `bundle.resources`가 가리키는 곳과 같아야 한다. 갈라지면 tauri가 빈
 * 경로를 집어 **sidecar 없는 설치본**이 나오는데, 빌드는 통과하고 앱도 뜬다(개발 머신에는
 * PATH에 node가 있다). 그래서 상수를 한 곳에 두고 `sidecarBundle.test.ts`가 두 파일을 대조한다.
 */
export const DEFAULT_STAGE_ROOT_REL = "apps/desktop/src-tauri/bundle";

/**
 * 동봉 런타임의 파일 이름. **대상 플랫폼**을 따른다 — 실행 중인 OS가 아니다.
 * `launcher.rs`의 `runtime_file_name(windows: bool)`과 같아야 한다.
 */
export function runtimeFileName(windows) {
  return windows ? "node.exe" : "node";
}

/** 핀 파일과 키 allowlist의 실제 경로. 읽는 쪽이 저마다 조립하지 않게 한다. */
export const PIN_FILE = path.join(HERE, "..", "node-runtime.json");
export const SIGNING_KEYS_FILE = path.join(HERE, "..", "node-signing-keys.json");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // 경로를 반드시 말한다. "JSON이 아닙니다"만 나오면 어느 파일인지 알 수 없다.
    throw new Error(`${file}을(를) 읽을 수 없습니다: ${error.message}`);
  }
}

/**
 * 우리가 아는 arch 이름 → 핀의 키.
 *
 * **모르는 arch를 조용히 x64로 떨어뜨리지 않는다.** 그렇게 하면 arm64 머신에서 x64
 * 바이너리가 든 설치본이 만들어지고, 증상은 설치 후 "앱이 뜨지 않는다"뿐이다.
 */
export function artifactKeyFor(platform, arch) {
  if (platform !== "win32") {
    return { ok: false, reason: `동봉 런타임은 Windows 대상만 핀되어 있습니다 (요청: ${platform})` };
  }
  if (arch === "x64") return { ok: true, key: "win-x64" };
  if (arch === "arm64") return { ok: true, key: "win-arm64" };
  return { ok: false, reason: `핀에 없는 아키텍처입니다: ${arch}` };
}

/** 핀을 읽고 모양을 검사한다. **고쳐주지 않는다** — 이상하면 멈춘다. */
export function readPin(file = PIN_FILE) {
  const pin = readJson(file);
  const problems = [];
  if (pin.schemaVersion !== 1) problems.push(`schemaVersion이 ${pin.schemaVersion}입니다 (1만 읽습니다)`);
  if (!/^v\d+\.\d+\.\d+$/.test(pin.version ?? "")) problems.push(`version이 vX.Y.Z 형식이 아닙니다: ${pin.version}`);
  for (const [key, artifact] of Object.entries(pin.artifacts ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(artifact?.sha256 ?? "")) {
      problems.push(`${key}.sha256이 64자리 소문자 hex가 아닙니다: ${artifact?.sha256}`);
    }
    // URL이 핀된 버전을 가리키는지 본다. 버전만 올리고 URL을 두면 **옛 바이너리의 해시로
    // 새 버전을 검증**하게 되고, 그러면 영원히 실패하거나(운이 좋으면) 옛것이 들어간다.
    if (!artifact?.url?.includes(`/${pin.version}/`)) {
      problems.push(`${key}.url이 ${pin.version}을 가리키지 않습니다: ${artifact?.url}`);
    }
  }
  if (Object.keys(pin.artifacts ?? {}).length === 0) problems.push("artifacts가 비어 있습니다");
  if (!/^[0-9A-F]{40}$/.test(pin.provenance?.signingKeyFingerprint ?? "")) {
    problems.push("provenance.signingKeyFingerprint가 40자리 대문자 hex가 아닙니다");
  }
  if (problems.length > 0) {
    throw new Error(`${file}의 모양이 잘못됐습니다:\n  - ${problems.join("\n  - ")}`);
  }
  return pin;
}

/** allowlist를 읽는다. fingerprint는 공백 없는 대문자 hex로 정규화한다. */
export function readSigningKeys(file = SIGNING_KEYS_FILE) {
  const doc = readJson(file);
  const keys = (doc.keys ?? []).map((k) => ({ ...k, fingerprint: normalizeFingerprint(k.fingerprint) }));
  if (keys.length === 0) throw new Error(`${file}에 키가 없습니다`);
  return { ...doc, keys };
}

/** gpg는 fingerprint를 공백으로 끊어 출력하기도 한다. 비교 전에 한 형태로 만든다. */
export function normalizeFingerprint(value) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

/** 핀에서 이 (platform, arch)에 해당하는 artifact를 꺼낸다. */
export function artifactFor(pin, platform, arch) {
  const resolved = artifactKeyFor(platform, arch);
  if (!resolved.ok) throw new Error(resolved.reason);
  const artifact = pin.artifacts[resolved.key];
  if (!artifact) throw new Error(`핀에 ${resolved.key} artifact가 없습니다`);
  return { key: resolved.key, ...artifact };
}

/** 배포 번들에서 **최소 조건**으로 반드시 있어야 하는 파일들. 착지 기준(10.4절)의 1번이다. */
export function requiredBundleFiles(windows) {
  return [runtimeFileName(windows), ENTRY_FILE, MANIFEST_FILE, RUNTIME_LICENSE_FILE];
}
