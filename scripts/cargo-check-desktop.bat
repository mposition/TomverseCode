@echo off
rem Tauri 껍데기 크레이트. tauri가 GUI 시스템 라이브러리를 요구하므로 MSVC 환경이 꼭 필요하다.
rem 환경 준비는 런처가 한다 — 여기서 _env.bat을 직접 call하면 준비 방식이 둘로 갈라진다.
node "%~dp0cargo.mjs" check --manifest-path "%~dp0..\apps\desktop\src-tauri\Cargo.toml" %*
