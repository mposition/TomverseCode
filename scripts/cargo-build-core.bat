@echo off
rem tomverse-host 바이너리 빌드. e2e 테스트가 이 산출물을 요구한다.
rem
rem cargo를 직접 부르지 않고 런처를 지난다 — 루트 `npm run core:build`와 **같은 경로**여야
rem "bat으로는 되는데 npm으로는 안 되는" 상태가 다시 생기지 않는다. 런처가 MSVC 환경 준비와
rem cargo 실행 파일 탐색을 모두 담당한다(scripts/cargo.mjs).
node "%~dp0cargo.mjs" build --manifest-path "%~dp0..\apps\desktop\src-tauri\core\Cargo.toml" %*
