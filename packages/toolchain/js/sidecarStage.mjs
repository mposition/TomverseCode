/**
 * 동봉 번들의 **스테이징 계획** — 무엇을 어디로 옮기는가. IO는 여기 없다.
 *
 * # 왜 계획과 실행을 가르는가
 *
 * 실행에는 Windows·네트워크·수백 MiB가 필요하지만, **틀리는 자리는 계획이다** — 진입점이
 * 엉뚱한 곳에 놓이거나, grammar가 빠지거나, 워크스페이스 심볼릭 링크가 그대로 복사되는 것.
 * 계획이 순수 함수면 그 전부를 Linux에서 확인할 수 있다. 이 저장소는 같은 이유로
 * `launcher::config_from`을 코어에 두었다(process-architecture.md 10.3절).
 *
 * # 잘라내는 것과 잘라내지 않는 것
 *
 * TypeScript 소스와 소스맵은 런타임이 절대 열지 않으므로 잘라낸다(약 20 MiB). 그러나
 * **"안 열 것 같다"로 잘라낸 판단은 배포된 뒤에야 틀린 것이 드러나고, 증상이 조용하다.**
 * 그래서 스테이징의 마지막이 잘라낸 트리로 sidecar를 **실제로 띄워** ready 왕복을 받는다
 * (`stage-sidecar.mjs`의 smoke). 과감히 자르되 자른 결과를 태워 보는 쪽이,
 * 조심스레 남기고 확인하지 않는 쪽보다 낫다.
 */

import path from "node:path";
import {
  BUNDLE_DIR,
  ENTRY_FILE,
  MANIFEST_FILE,
  RUNTIME_LICENSE_FILE,
  runtimeFileName,
} from "./nodeRuntime.mjs";

/**
 * 런타임이 열지 않는 확장자. `.d.ts`는 `.ts`에 포함된다.
 *
 * `.js`/`.mjs`/`.cjs`/`.json`/`.wasm`/`.node`는 남긴다 — 마지막 둘이 특히 중요하다.
 * grammar가 `.wasm`이고, 네이티브 애드온이 언젠가 생기면 `.node`다.
 */
export const PRUNED_EXTENSIONS = [".map", ".ts", ".tsx", ".mts", ".cts"];

/** 우리 워크스페이스 패키지. 진입점이 번들 루트로 평탄화되므로 node_modules에 또 넣지 않는다. */
export const SELF_PACKAGE = "@tomverse/sidecar";

export function shouldPrune(fileName) {
  return PRUNED_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

/**
 * 상대 경로를 조각으로 나눈다.
 *
 * **`path.sep`을 쓰지 않는다 — 두 구분자를 모두 문자로 적는다.** `path.sep`은 *실행 중인*
 * OS의 구분자이므로, Linux에서 이 함수를 부르면 `\`가 구분자가 아니게 되어 Windows 경로가
 * 통째로 한 조각이 된다. 그러면 모든 의존성이 "node_modules 아래가 아니다"로 걸러져
 * **빈 번들**이 나오고, 그 결함은 Windows 빌드 머신에서는 보이지 않는다. CLAUDE.md가
 * 기록해 둔 함정("std::path와 Node의 path는 실행 중인 OS의 구분자만 안다")이 여기 그대로
 * 재현됐다 — 이 모듈은 **대상 플랫폼**을 인자로 받으므로 호스트를 보는 값이 섞이면 안 된다.
 *
 * (여기서 정규식 리터럴을 쓰지 않는 이유는 또 다른 사고 이력이다 — 문자 클래스의 `\\`가
 * 한 겹 벗겨져 `/[\/]/`가 되면 Windows 경로만 조용히 나뉘지 않고 같은 증상이 나온다.)
 */
export function splitPath(value) {
  return String(value)
    .split("\\")
    .flatMap((part) => part.split("/"))
    .filter((part) => part.length > 0);
}

/**
 * 경로 조작에 쓸 **대상 플랫폼**의 path 구현.
 *
 * 기본값을 두지 않는다. 호스트를 기본으로 삼으면 "적지 않는 것"이 가장 쉬운 길이 되고,
 * 그때 Windows 분기는 Windows에서만 검증된다 — 이 모듈이 순수 함수인 이유가 사라진다.
 */
function flavor(windows) {
  return windows ? path.win32 : path.posix;
}

/**
 * 의존성 경로 하나를 번들 안 자리로 옮긴다.
 *
 * **저장소 루트 기준 상대 경로를 그대로 보존한다.** 중첩 `node_modules`(버전이 충돌해
 * npm이 안쪽에 따로 설치한 경우)가 있으면 그 중첩까지 같이 따라간다 — 평탄화하면 두 버전이
 * 한 자리를 다투고, 어느 쪽이 이겼는지는 복사 순서가 정한다.
 */
export function bundleTargetFor(repoRoot, depPath, stageBundleDir, windows) {
  const p = flavor(windows);
  const rel = p.relative(repoRoot, depPath);
  if (rel.startsWith("..") || p.isAbsolute(rel)) {
    return { ok: false, reason: `저장소 밖의 의존성입니다: ${depPath}` };
  }
  const segments = splitPath(rel);
  if (segments[0] !== "node_modules") {
    return { ok: false, reason: `node_modules 아래가 아닙니다: ${rel}` };
  }
  // **자리를 만드는 것은 호스트 `path.join`이다.** 대상 플랫폼 flavor는 입력을 *읽는* 데만
  // 쓴다 — 실제 스테이징은 언제나 대상 플랫폼에서 돌므로 둘이 같고, 계획 테스트는 호스트
  // 경로로 기대값을 만든다. 여기서 flavor로 이어붙이면 Linux에서 `\`가 섞여 나온다.
  return { ok: true, target: path.join(stageBundleDir, ...segments) };
}

/** `node_modules/<...>` 상대 경로에서 패키지 이름을 읽는다(`@scope/name` 포함). */
export function packageNameFromPath(repoRoot, depPath, windows) {
  const segments = splitPath(flavor(windows).relative(repoRoot, depPath));
  const last = segments.lastIndexOf("node_modules");
  if (last < 0) return null;
  const rest = segments.slice(last + 1);
  if (rest.length === 0) return null;
  return rest[0].startsWith("@") ? rest.slice(0, 2).join("/") : rest[0];
}

/**
 * 스테이징 계획을 만든다. **아무것도 읽거나 쓰지 않는다.**
 *
 * @param repoRoot        저장소 루트(절대)
 * @param stageRoot       스테이징 디렉터리(절대). 이 아래에 `sidecar/`가 생긴다
 * @param windows         대상 플랫폼. `node.exe`인지 `node`인지를 정한다
 * @param sidecarDistDir  `packages/sidecar/dist/src` (절대)
 * @param depPaths        `npm ls --omit=dev --parseable`이 준 절대 경로들
 * @param grammarWasmFiles sidecar 자신이 선언한 grammar 파일 이름 목록
 */
export function planSidecarStage({ repoRoot, stageRoot, windows, sidecarDistDir, depPaths, grammarWasmFiles }) {
  if (!Array.isArray(grammarWasmFiles) || grammarWasmFiles.length === 0) {
    // 빈 목록으로 계획하면 grammar가 통째로 빠진 번들이 **조용히** 만들어진다. 그 증상은
    // 오류가 아니라 성능 저하(`grammar-unavailable`)이므로 여기서 멈춘다.
    throw new Error("grammar wasm 목록이 비어 있습니다 — sidecar에서 읽어 넘기세요");
  }
  const bundleDir = path.join(stageRoot, BUNDLE_DIR);

  /** 진입점은 **번들 루트**에 놓인다. `launcher.rs`가 `<exe dir>/sidecar/index.js`를 찾는다. */
  const copies = [
    {
      what: "sidecar",
      from: sidecarDistDir,
      to: bundleDir,
      prune: { extensions: PRUNED_EXTENSIONS, keepOnly: null },
    },
  ];
  const skipped = [];

  for (const depPath of depPaths) {
    const name = packageNameFromPath(repoRoot, depPath, windows);
    if (name === null) {
      // 루트 자신(`npm ls`가 첫 줄에 낸다)이나 워크스페이스 디렉터리다.
      skipped.push({ path: depPath, why: "node_modules 아래가 아닙니다" });
      continue;
    }
    if (name === SELF_PACKAGE) {
      skipped.push({ path: depPath, why: `${SELF_PACKAGE}는 번들 루트로 평탄화됩니다` });
      continue;
    }
    const target = bundleTargetFor(repoRoot, depPath, bundleDir, windows);
    if (!target.ok) {
      skipped.push({ path: depPath, why: target.reason });
      continue;
    }
    copies.push({
      what: name,
      from: depPath,
      to: target.target,
      prune: {
        extensions: PRUNED_EXTENSIONS,
        // **grammar만 골라 담는다.** 전부 담으면 44 MiB가 더 붙는데 우리가 여는 것은 5개다.
        // 목록은 sidecar가 선언한 것을 그대로 받는다 — 여기 또 적으면 언젠가 갈라지고,
        // 갈라진 결과가 "그 언어만 심볼이 없다"는 조용한 저하로 나온다.
        keepOnly: name === "tree-sitter-wasms" ? grammarWasmFiles.map((f) => path.posix.join("out", f)) : null,
      },
    });
  }

  return {
    bundleDir,
    copies,
    skipped,
    /** 스테이징이 끝난 뒤 **반드시 있어야 하는** 파일들. 없으면 빌드를 멈춘다. */
    required: [
      path.join(bundleDir, runtimeFileName(windows)),
      path.join(bundleDir, ENTRY_FILE),
      path.join(bundleDir, MANIFEST_FILE),
      path.join(bundleDir, RUNTIME_LICENSE_FILE),
      path.join(bundleDir, "package.json"),
      ...grammarWasmFiles.map((f) => path.join(bundleDir, "node_modules", "tree-sitter-wasms", "out", f)),
    ],
  };
}

/**
 * 번들 루트의 `package.json`.
 *
 * **없으면 안 된다.** sidecar의 dist는 ESM인데(`import`), `type` 선언이 없으면 Node가 `.js`를
 * CommonJS로 읽어 진입점 첫 줄에서 죽는다. 그리고 이 파일이 `node_modules` 해석의 닻이기도
 * 하다 — 없으면 Node가 상위 디렉터리로 계속 올라가 사용자 머신의 엉뚱한 패키지를 집을 수 있다.
 */
export function bundlePackageJson(version) {
  return {
    name: "@tomverse/sidecar-bundle",
    private: true,
    type: "module",
    version,
    main: `./${ENTRY_FILE}`,
  };
}
