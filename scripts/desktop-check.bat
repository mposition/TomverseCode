@echo off
rem Tauri 껍데기 크레이트. tauri가 GUI 시스템 라이브러리를 요구하므로 MSVC 환경이 꼭 필요하다.
call "%~dp0_env.bat" || exit /b 1
cargo check --manifest-path "%~dp0..\apps\desktop\src-tauri\Cargo.toml" %*
