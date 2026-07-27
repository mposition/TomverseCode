@echo off
rem tomverse-host 바이너리 빌드. e2e 테스트가 이 산출물을 요구한다.
call "%~dp0_env.bat" || exit /b 1
cargo build --manifest-path "%~dp0..\apps\desktop\src-tauri\core\Cargo.toml" %*
