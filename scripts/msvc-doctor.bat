@echo off
rem ---------------------------------------------------------------------------
rem MSVC 탐지 진단 — **읽기만 한다.** 무엇을 어디까지 확인했는지 그대로 보여준다.
rem
rem 왜 필요한가: "Visual Studio가 설치되어 있는데 못 찾는다"는 보고를 받았을 때, 추측으로
rem 후보 경로를 늘리는 대신 사실을 먼저 본다. 설치 위치는 사용자가 고르는 값이므로
rem 목록으로는 못 쫓아가고(CLAUDE.md), 답은 실제 상태를 확인하는 것이다.
rem
rem **전체 환경을 덤프하지 않는다.** `set`으로 전부 출력하면 API 키가 버퍼에 들어간다
rem (scripts\msvc-env.bat과 같은 이유).
rem
rem **설치마다 vcvarsall.bat 존재를 따로 출력한다.** 실측 머신에는 설치가 둘 있었고, 최신
rem 설치(VS 18 Enterprise)에는 C++ 빌드 도구가 없고 더 오래된 2022 BuildTools에만 있었다.
rem 설치 경로 목록만 나열하면 "둘 다 있는데 왜 실패하나"로 읽혀서 진단이 한 단계 멀어진다.
rem
rem **chcp 65001이 필요한 이유.** 이 스크립트의 출력은 npm/node의 UTF-8 파이프를 지나지 않고
rem 콘솔에 직접 간다. 파일은 UTF-8인데 콘솔 코드 페이지가 cp949/437이면 한글이 전부 깨진다
rem (실측). 코드 페이지는 setlocal로 스코프되지 않으므로 끝에서 직접 되돌린다 — 진단 명령이
rem 사용자의 셸 상태를 바꿔 놓고 끝나면 안 된다.
rem ---------------------------------------------------------------------------

setlocal
set "OLD_CP="
for /f "tokens=2 delims=:" %%c in ('chcp') do set "OLD_CP=%%c"
chcp 65001 >nul 2>nul

set "PF_X86=%ProgramFiles(x86)%"
set "PF_64=%ProgramFiles%"

echo === MSVC 탐지 진단 ===
echo.
echo [경로 변수]
echo   ProgramFiles       = "%PF_64%"
echo   ProgramFiles^(x86^) = "%PF_X86%"
echo   ProgramW6432       = "%ProgramW6432%"
echo   VSINSTALLDIR       = "%VSINSTALLDIR%"
echo   TOMVERSE_VCVARSALL = "%TOMVERSE_VCVARSALL%"
echo.

echo [vswhere.exe]
call :probe "%PF_X86%\Microsoft Visual Studio\Installer\vswhere.exe"
call :probe "%PF_64%\Microsoft Visual Studio\Installer\vswhere.exe"
if defined ProgramW6432 call :probe "%ProgramW6432%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%W in (`where vswhere.exe 2^>nul`) do echo   PATH에서 발견: "%%W"
echo.

set "VSWHERE="
if exist "%PF_X86%\Microsoft Visual Studio\Installer\vswhere.exe" set "VSWHERE=%PF_X86%\Microsoft Visual Studio\Installer\vswhere.exe"
if not defined VSWHERE if exist "%PF_64%\Microsoft Visual Studio\Installer\vswhere.exe" set "VSWHERE=%PF_64%\Microsoft Visual Studio\Installer\vswhere.exe"
if not defined VSWHERE for /f "usebackq delims=" %%W in (`where vswhere.exe 2^>nul`) do if not defined VSWHERE set "VSWHERE=%%W"

rem 아래를 `if defined VSWHERE ( ... )` 괄호 블록으로 묶지 않는다. 괄호 블록은 한 번에 파싱되어
rem 블록 안에서 갱신한 카운터를 같은 블록 안에서 읽으면 파싱 시점의 옛 값이 나온다.
if not defined VSWHERE goto :no_vswhere

echo [vswhere가 보고한 설치 — 설치별 vcvarsall.bat 상태]
set "N_SEEN=0"
set "N_USABLE=0"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -all -prerelease -products * -property installationPath 2^>nul`) do call :vcv "%%i"
echo   합계: 설치 %N_SEEN%개 중 vcvarsall.bat 있음 %N_USABLE%개
echo.

echo [C++ 빌드 도구를 갖춘 설치 ^(-requires VC.Tools.x86.x64^)]
set "N_SEEN=0"
set "N_USABLE=0"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -all -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do call :vcv "%%i"
echo   합계: 설치 %N_SEEN%개 중 vcvarsall.bat 있음 %N_USABLE%개
echo.
goto :after_vswhere

:no_vswhere
echo [vswhere를 찾지 못했습니다 — 아래 검색 결과를 보세요]
echo.

:after_vswhere
echo [Program Files 아래 vcvarsall.bat 검색]
call :find "%PF_64%"
call :find "%PF_X86%"
if defined ProgramW6432 call :find "%ProgramW6432%"
echo.

echo [cargo]
where cargo.exe 2>nul
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" echo   "%USERPROFILE%\.cargo\bin\cargo.exe"
echo.

echo [_env.bat 실제 실행 결과]
call "%~dp0_env.bat"
if errorlevel 1 (
  echo   → 실패 ^(종료 코드 1^). 위 출력이 원인입니다.
) else (
  echo   → 성공. INCLUDE 설정 여부:
  if defined INCLUDE (echo      INCLUDE 있음) else (echo      INCLUDE 없음)
)
if defined OLD_CP chcp %OLD_CP% >nul 2>nul
endlocal
exit /b 0

:probe
if exist "%~1" (echo   있음: "%~1") else (echo   없음: "%~1")
exit /b 0

rem ---------------------------------------------------------------------------
rem 설치 하나에 대해 vcvarsall.bat 존재를 출력하고 센다. **파일 존재가 최종 판정이다** —
rem 워크로드 선언(-requires)은 새 메이저 버전에서 컴포넌트 ID가 바뀌면 빗나갈 수 있다
rem (_env.bat 2c와 같은 근거).
rem ---------------------------------------------------------------------------
:vcv
if "%~1"=="" exit /b 0
set /a N_SEEN+=1
if exist "%~1\VC\Auxiliary\Build\vcvarsall.bat" (
  set /a N_USABLE+=1
  echo   쓸 수 있음      : "%~1"
) else (
  echo   vcvarsall.bat 없음: "%~1"
)
exit /b 0

:find
if "%~1"=="" exit /b 0
if not exist "%~1\Microsoft Visual Studio" (
  echo   "%~1\Microsoft Visual Studio" 디렉터리가 없습니다
  exit /b 0
)
dir /b /s "%~1\Microsoft Visual Studio\vcvarsall.bat" 2>nul
exit /b 0
