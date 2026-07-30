#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 이 워크스페이스가 **의존하는 워크스페이스의 빌드 산출물이 낡지 않았는지** 확인한다.
 *
 * # 무엇을 고쳤나
 *
 * 이 저장소의 워크스페이스들은 서로의 **`dist`** 에 대해 타입 검사한다(소스가 아니다 —
 * 그 이유는 CLAUDE.md "검증 순서" 절). 그래서 루트 `npm run build`는 의존성 순서로 돈다.
 *
 * 그런데 `npm run gate:g:test`나 `npm test --workspace=@tomverse/hypothesis-gate`처럼
 * **한 워크스페이스만 빌드하는 명령**은 그 순서를 지나지 않는다. `git pull`로 sidecar의
 * 공개 타입이 바뀐 직후 그런 명령을 돌리면, 게이트가 **예전 `.d.ts`** 에 대해 컴파일되고
 * 71개짜리 `TS2305 has no exported member` 목록이 나온다. 실측으로 그랬다.
 *
 * 증상이 고약한 이유는 오류가 원인을 가리키지 않는다는 점이다 — 방금 pull한 코드가
 * 잘못됐다고 읽히고, 실제 문제는 "빌드하지 않은 의존성"이다.
 *
 * # 왜 이름 목록이 아니라 mtime인가
 *
 * "게이트가 sidecar에서 쓰는 export 목록"을 여기 적으면 그 목록이 세 번째 진실의 원천이 되고,
 * import를 추가할 때마다 갱신해야 한다. 갱신을 잊으면 검사가 조용히 무력해진다.
 *
 * 대신 **산출물이 소스보다 낡았는가**만 본다. 의존성 목록은 각 `package.json`에서 유도하므로
 * 사람이 적는 목록이 없다. `git checkout`은 바뀐 파일의 mtime을 갱신하므로, pull 직후
 * "소스가 dist보다 새로움"이 정확히 감지된다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 이 저장소의 워크스페이스: 이름 → 디렉터리. 루트 package.json의 글롭에서 유도한다. */
function workspaceMap() {
  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const map = new Map();
  for (const pattern of rootManifest.workspaces ?? []) {
    const parent = pattern.replace(/\/\*$/, "");
    const parentDir = path.join(repoRoot, parent);
    let entries;
    try {
      entries = readdirSync(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parentDir, entry.name);
      try {
        const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
        map.set(manifest.name, dir);
      } catch {
        // package.json이 없는 디렉터리는 워크스페이스가 아니다.
      }
    }
  }
  return map;
}

/** 디렉터리 트리에서 가장 최근 mtime. 없으면 undefined. */
function newestMtime(dir) {
  let newest;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const mtime = statSync(full).mtimeMs;
      if (newest === undefined || mtime > newest) newest = mtime;
    }
  };
  walk(dir);
  return newest;
}

const targetDir = path.resolve(process.argv[2] ?? process.cwd());
const targetManifest = JSON.parse(readFileSync(path.join(targetDir, "package.json"), "utf8"));
const workspaces = workspaceMap();

// devDependencies도 본다 — 테스트 하네스가 import하는 산출물도 낡으면 같은 증상이 난다.
const declared = { ...(targetManifest.dependencies ?? {}), ...(targetManifest.devDependencies ?? {}) };
const stale = [];
const missing = [];

for (const name of Object.keys(declared)) {
  const depDir = workspaces.get(name);
  if (depDir === undefined) continue; // 외부 패키지.
  const distDir = path.join(depDir, "dist");
  const srcDir = path.join(depDir, "src");
  const distNewest = newestMtime(distDir);
  if (distNewest === undefined) {
    // `dist`를 만들지 않는 워크스페이스(예: 순수 JavaScript 재수출)는 검사 대상이 아니다.
    const hasBuildScript = Boolean(JSON.parse(readFileSync(path.join(depDir, "package.json"), "utf8")).scripts?.build);
    if (hasBuildScript) missing.push(name);
    continue;
  }
  const srcNewest = newestMtime(srcDir);
  if (srcNewest !== undefined && srcNewest > distNewest) stale.push(name);
}

if (missing.length === 0 && stale.length === 0) process.exit(0);

const lines = [];
lines.push(`${targetManifest.name}를 빌드할 수 없습니다 — 의존하는 워크스페이스의 산출물이 준비되지 않았습니다.`);
lines.push("");
if (missing.length > 0) lines.push(`빌드되지 않음: ${missing.join(", ")}`);
if (stale.length > 0) lines.push(`소스보다 낡음: ${stale.join(", ")}`);
lines.push("");
lines.push("이 저장소의 워크스페이스는 서로의 **dist**에 대해 타입 검사합니다. 낡은 .d.ts로");
lines.push("컴파일하면 `has no exported member` 같은 오류가 잔뜩 나오는데, 그건 방금 받은 코드의");
lines.push("문제가 아니라 빌드하지 않은 의존성의 문제입니다.");
lines.push("");
lines.push("루트에서 순서대로 빌드하세요:");
lines.push("  npm run build");
lines.push("");
lines.push("또는 전체 검증:");
lines.push("  npm run verify");
process.stderr.write(`${lines.join("\n")}\n`);
process.exit(1);
