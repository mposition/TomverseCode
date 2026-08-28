#!/usr/bin/env node
/**
 * `desktop:check`가 요구하는 **번들 자리**를 만든다.
 *
 * # 왜 필요한가
 *
 * `tauri.conf.json`의 `bundle.resources`가 `bundle/sidecar`를 가리키므로, `tauri_build`는
 * 그 디렉터리가 없으면 **타입 검사조차 시작하지 못하고** `resource path 'bundle/sidecar'
 * doesn't exist`로 멈춘다. 그런데 그 디렉터리를 만드는 것은 `sidecar:stage`이고, 그건
 * 릴리스 빌드 앞에서만 돈다(`scripts\tauri-build.bat`). 그래서 지금까지 clean clone에서
 * `npm run verify`는 `desktop:check` 단계에서 **반드시** 죽었고, 아는 사람만
 * "먼저 스테이징을 돌려라"를 기억해 우회했다. 검증이 사람의 기억에 기대는 자리는 그것 자체가
 * 결함이다 — 그 기억이 CI에는 없다.
 *
 * # 왜 비어 있어도 되는가
 *
 * 이 자리가 타입 검사에 주는 것은 **존재**뿐이다. 핀된 `node.exe`도 sidecar `dist`도
 * `cargo check`가 읽지 않는다. 그리고 이 빈 자리가 진짜 동봉을 가리지도 않는다 —
 * `scripts/stage-sidecar.mjs`는 시작할 때 이 트리를 **지우고 다시 만들며**, 끝나고
 * 그 트리로 sidecar를 실제로 띄워 ping 왕복을 확인한다. 즉 "비었는데 통과"는
 * 타입 검사에서만 성립하고, 번들 판정에서는 성립하지 않는다.
 *
 * 그래서 **이미 있는 것은 건드리지 않는다.** 스테이징 산출물을 지우는 순간 이 스크립트가
 * 릴리스 경로에 개입하게 된다.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `new URL(import.meta.url).pathname`은 Windows에서 `/C:/...`가 된다(CLAUDE.md 함정 기록).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLOT = path.resolve(__dirname, "..", "apps", "desktop", "src-tauri", "bundle", "sidecar");

if (existsSync(SLOT)) {
  process.exit(0);
}

mkdirSync(SLOT, { recursive: true });
console.log(`[tomverse] 번들 자리를 만들었다(비어 있음, 타입 검사용): ${SLOT}`);
