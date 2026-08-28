@echo off
rem Windows Tauri 번들 빌드 — 배포 산출물(.msi/.exe)까지 만든다.
rem
rem 이것만 별도 스크립트인 이유: core/desktop 크레이트 확인과 달리 프런트엔드 번들
rem (npm run build)이 먼저 있어야 하고, 시간이 훨씬 오래 걸린다. 매번 도는 검증에 섞으면
rem 개발 루프가 느려진다.
setlocal
call "%~dp0_env.bat" || exit /b 1
pushd "%~dp0.."

rem Tauri가 dist/를 번들에 넣으므로 프런트엔드가 먼저 빌드되어 있어야 한다.
call npm run build || goto :fail

rem 동봉 sidecar 스테이징. **tauri build보다 먼저다** — tauri.conf.json의 bundle.resources가
rem 가리키는 디렉터리를 이 단계가 만들기 때문이다. 없으면 tauri가 리소스를 못 찾아 실패한다.
rem 별도 명령인 이유(스테이징만 따로 검증할 수 있어야 한다)는 process-architecture.md 10.6절.
call npm run sidecar:stage || goto :fail

call npx tauri build %* || goto :fail

echo [tomverse] Tauri 번들 빌드 완료
popd & endlocal & exit /b 0

:fail
echo [tomverse] Tauri 빌드 실패 (위 출력 확인)
popd & endlocal & exit /b 1
