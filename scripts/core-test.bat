@echo off
rem 신뢰 경계 크레이트 테스트. GUI 라이브러리를 요구하지 않으므로 가장 자주 도는 검증이다.
call "%~dp0_env.bat" || exit /b 1
cargo test --manifest-path "%~dp0..\apps\desktop\src-tauri\core\Cargo.toml" %*
