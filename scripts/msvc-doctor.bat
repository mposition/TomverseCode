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
rem ---------------------------------------------------------------------------

setlocal
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

if defined VSWHERE (
  echo [vswhere가 보고한 설치]
  "%VSWHERE%" -all -prerelease -products * -property installationPath 2>nul
  echo.
  echo [C++ 빌드 도구를 갖춘 설치]
  "%VSWHERE%" -all -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>nul
  echo.
) else (
  echo [vswhere를 찾지 못했습니다 — 아래 검색 결과를 보세요]
  echo.
)

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
endlocal
exit /b 0

:probe
if exist "%~1" (echo   있음: "%~1") else (echo   없음: "%~1")
exit /b 0

:find
if "%~1"=="" exit /b 0
if not exist "%~1\Microsoft Visual Studio" (
  echo   "%~1\Microsoft Visual Studio" 디렉터리가 없습니다
  exit /b 0
)
dir /b /s "%~1\Microsoft Visual Studio\vcvarsall.bat" 2>nul
exit /b 0
