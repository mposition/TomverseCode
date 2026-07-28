@echo off
rem ---------------------------------------------------------------------------
rem MSVC 툴체인 + cargo PATH 준비. 다른 래퍼들이 전부 이걸 call한다.
rem
rem 왜 필요한가 (CLAUDE.md "이 환경에서 이미 밟은 함정"):
rem   1. winget으로 설치한 cargo/rustc가 기존 셸 세션의 PATH에 없다.
rem   2. MSVC 링커 환경변수(INCLUDE/LIB)가 없으면 컴파일은 되는데 **링크에서** 실패한다.
rem   3. Git for Windows의 GNU link.exe가 MSVC link.exe를 가린다. vcvarsall.bat를 거치면
rem      MSVC 경로가 앞에 오므로 해결된다.
rem
rem 이 파일이 존재하는 이유는 이 세 가지를 매번 재발견하지 않기 위해서다.
rem
rem **탐지는 vswhere가 한다. 설치 경로를 추측하지 않는다.**
rem 예전에는 후보 경로 4개를 하드코딩했는데(C: 드라이브 / "2022" / BuildTools·Community),
rem 실제 사용자 머신은 D:\Program Files\Microsoft Visual Studio\18\Enterprise 였다 —
rem 드라이브도 버전 디렉터리도 에디션도 전부 달라 넷 다 빗나갔다. 설치 위치는 사용자가
rem 고르는 값이므로 목록을 늘리는 방식으로는 영원히 못 쫓아간다.
rem
rem vswhere.exe는 Visual Studio Installer가 **항상 같은 곳**에 두는 조회 도구다
rem (%ProgramFiles(x86)%\Microsoft Visual Studio\Installer). VS 자체가 어느 드라이브에
rem 있든 여기서 물어보면 알려준다. 이건 특정 머신의 경로를 하드코딩하는 것이 아니라
rem Microsoft가 보장하는 고정 진입점을 쓰는 것이다.
rem ---------------------------------------------------------------------------

if defined VSCMD_ARG_TGT_ARCH goto :cargo_path

set "VCVARS="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"

if exist "%VSWHERE%" (
  rem 1) C++ 빌드 도구를 갖춘 최신 설치.
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
    if not defined VCVARS if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvarsall.bat"
  )
  rem 2) 미리보기 채널도 본다 — 새 메이저 버전은 한동안 여기에만 있다.
  if not defined VCVARS for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
    if not defined VCVARS if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvarsall.bat"
  )
  rem 3) 워크로드 조건 없이 vcvarsall.bat이 있는 설치라면 받아들인다.
  if not defined VCVARS for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -prerelease -products * -property installationPath 2^>nul`) do (
    if not defined VCVARS if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvarsall.bat"
  )
)

rem vswhere가 없는 경우(구버전 Build Tools 단독 설치 등)에만 쓰는 최후 후보.
rem 이 목록으로 새 설치를 쫓아가려 하지 말 것 — vswhere가 정답이고 이건 안전망이다.
if not defined VCVARS for %%P in (
  "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
) do if not defined VCVARS if exist %%P set "VCVARS=%%~P"

if not defined VCVARS (
  echo [tomverse] MSVC 빌드 도구를 찾지 못했습니다.
  if exist "%VSWHERE%" (
    echo [tomverse] vswhere는 있으나 C++ 빌드 도구를 갖춘 설치를 찾지 못했습니다: "%VSWHERE%"
    echo [tomverse] Visual Studio Installer에서 "C++를 사용한 데스크톱 개발" 워크로드를 추가하세요.
  ) else (
    echo [tomverse] vswhere.exe가 없습니다 — Visual Studio가 설치되어 있지 않은 것으로 보입니다.
    echo [tomverse] Visual Studio Build Tools + "C++를 사용한 데스크톱 개발"을 설치하세요.
  )
  exit /b 1
)
call "%VCVARS%" x64 >nul 2>nul
if errorlevel 1 (
  echo [tomverse] vcvarsall.bat 실행에 실패했습니다: "%VCVARS%"
  exit /b 1
)

rem vcvarsall이 0으로 끝나도 변수가 안 잡히는 경우가 있다(설치 손상, 아키텍처 불일치).
rem 여기서 걸러야 나중에 LNK1104나 stdarg.h 같은 먼 증상으로만 드러나지 않는다.
if not defined INCLUDE (
  echo [tomverse] vcvarsall.bat을 실행했지만 INCLUDE가 설정되지 않았습니다: "%VCVARS%"
  echo [tomverse] 이 상태로 진행하면 stdarg.h 없음 / LNK1104로 실패합니다.
  exit /b 1
)

:cargo_path
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%PATH%;%USERPROFILE%\.cargo\bin"
exit /b 0
