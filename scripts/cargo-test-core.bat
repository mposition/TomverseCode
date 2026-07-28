@echo off
rem 신뢰 경계 크레이트 테스트. GUI 라이브러리를 요구하지 않으므로 가장 자주 도는 검증이다.
rem 루트 `npm run core:test`와 같은 런처를 지난다.
node "%~dp0cargo.mjs" test --manifest-path "%~dp0..\apps\desktop\src-tauri\core\Cargo.toml" %*
