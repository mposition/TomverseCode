@echo off
rem 전체 검증 — Node 빌드/타입/테스트 + Rust 테스트 + 실제 구성요소 e2e.
rem 어느 하나라도 실패하면 즉시 멈춘다. 부분 성공을 "통과"로 보고하지 않기 위해서다.
rem
rem 순서가 중요하다:
rem   1) build가 typecheck보다 먼저 — sidecar는 protocol의 빌드 산출물(dist)에 대해 타입 검사한다.
rem      clean clone처럼 dist가 없거나 낡은 상태에서 typecheck를 먼저 돌리면 잘못된 타입을 읽는다.
rem   2) core:build가 test보다 먼저 — `npm test`에 포함된 가설 게이트 통합 테스트가
rem      실제 tomverse-host 바이너리를 요구한다. 로컬에 남은 예전 바이너리 덕분에 통과하는
rem      상태를 허용하지 않는다.
rem   3) core:build가 test:e2e보다 먼저 — e2e도 같은 바이너리를 요구한다.
rem
rem 이 순서는 루트 package.json의 `verify`와 **의미상 동일해야 한다.** 한쪽만 고치지 말 것 —
rem packages/toolchain/test/verifyOrder.test.ts가 두 진입점의 순서를 비교해 지킨다.
rem
rem **여기서 _env.bat을 call하지 않는다.** 예전에는 call했고, 그래서 이 스크립트는 통과하는데
rem 루트 `npm run verify`는 일반 PowerShell에서 core:build 단계에 INCLUDE/LIB 없이 들어가
rem 죽었다 — 단계 순서는 같은데 **환경 준비 의미가 달랐다.** 이제 MSVC 준비는 cargo 런처
rem (scripts/cargo.mjs)가 하며, 두 진입점이 같은 경로를 지난다. 여기서 미리 준비해 버리면
rem 그 차이가 다시 감춰진다.
rem
rem `npm install` / `npm ci`는 사용자가 사전에 수행한다 — 이 스크립트는 의존성을 건드리지 않는다.
setlocal
pushd "%~dp0.."

call npm run build      || goto :fail
call npm run typecheck  || goto :fail
call npm run core:build || goto :fail
call npm test           || goto :fail
call npm run core:test  || goto :fail
call npm run desktop:check || goto :fail
call npm run test:e2e   || goto :fail

echo [tomverse] 전체 검증 통과
popd & endlocal & exit /b 0

:fail
echo [tomverse] 검증 실패 (위 출력 확인)
popd & endlocal & exit /b 1
