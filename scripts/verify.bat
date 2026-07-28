@echo off
rem 전체 검증 — Node 빌드/타입/테스트 + Rust 테스트 + 실제 구성요소 e2e.
rem 어느 하나라도 실패하면 즉시 멈춘다. 부분 성공을 "통과"로 보고하지 않기 위해서다.
rem
rem 순서가 중요하다. **build가 typecheck보다 먼저**여야 한다:
rem sidecar는 protocol의 빌드 산출물(dist)에 대해 타입 검사하므로, clean clone이나 fetch 직후처럼
rem dist가 없거나 낡은 상태에서 typecheck를 먼저 돌리면 잘못된 protocol 타입을 읽는다.
rem core:build가 test:e2e 바로 앞인 이유는 e2e가 tomverse-host 바이너리를 요구하기 때문이다.
rem
rem `npm install` / `npm ci`는 사용자가 사전에 수행한다 — 이 스크립트는 의존성을 건드리지 않는다.
rem 이 순서는 루트 package.json의 `verify`와 **의미상 동일해야 한다.** 한쪽만 고치지 말 것.
setlocal
call "%~dp0_env.bat" || exit /b 1
pushd "%~dp0.."

call npm run build      || goto :fail
call npm run typecheck  || goto :fail
call npm test           || goto :fail
call npm run core:test  || goto :fail
call npm run core:build || goto :fail
call npm run test:e2e   || goto :fail

echo [tomverse] 전체 검증 통과
popd & endlocal & exit /b 0

:fail
echo [tomverse] 검증 실패 (위 출력 확인)
popd & endlocal & exit /b 1
