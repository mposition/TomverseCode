@echo off
rem M0.1 전체 검증 — Node 타입/빌드/테스트 + Rust 테스트 + 실제 구성요소 e2e.
rem 어느 하나라도 실패하면 즉시 멈춘다. 부분 성공을 "통과"로 보고하지 않기 위해서다.
setlocal
call "%~dp0_env.bat" || exit /b 1
pushd "%~dp0.."

call npm run typecheck  || goto :fail
call npm run build      || goto :fail
call npm test           || goto :fail
call npm run core:test  || goto :fail
call npm run core:build || goto :fail
call npm run test:e2e   || goto :fail

echo [tomverse] 전체 검증 통과
popd & endlocal & exit /b 0

:fail
echo [tomverse] 검증 실패 (위 출력 확인)
popd & endlocal & exit /b 1
