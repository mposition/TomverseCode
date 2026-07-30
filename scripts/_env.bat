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
rem **탐지는 vswhere가 먼저다. 설치 경로를 추측하지 않는다.**
rem 예전에는 후보 경로 4개를 하드코딩했는데(C: 드라이브 / "2022" / BuildTools·Community),
rem 실제 사용자 머신은 D:\Program Files\Microsoft Visual Studio\18\Enterprise 였다 —
rem 드라이브도 버전 디렉터리도 에디션도 전부 달라 넷 다 빗나갔다. 설치 위치는 사용자가
rem 고르는 값이므로 목록을 늘리는 방식으로는 영원히 못 쫓아간다.
rem
rem 그런데 vswhere도 만능이 아니다. Visual Studio가 설치되어 있는데도 Installer 디렉터리를
rem 못 찾는 경우가 실제로 있었다(오프라인 레이아웃 설치, Installer 이전/제거 등). 그래서
rem 탐지를 **네 겹**으로 두고, 전부 실패하면 **무엇을 어디까지 확인했는지** 전부 출력한다 —
rem "설치되지 않은 것으로 보입니다"라고만 말하면 설치되어 있는 사용자가 무엇을 해야 할지 모른다.
rem
rem   1) TOMVERSE_VCVARSALL — 사용자가 직접 지정하는 탈출구. 탐지가 실패하는 머신의 최종 답이다.
rem   2) vswhere.exe — 고정 위치 두 곳 + PATH. **-latest를 쓰지 않는다**(아래 참조).
rem   3) VSINSTALLDIR — 이미 VS 셸 안에서 실행된 경우
rem   4) Program Files 아래 "Microsoft Visual Studio" 서브트리 **검색** (목록이 아니라 검색이다)
rem
rem **왜 -latest가 아니라 -all인가.** 실측 머신에 설치가 둘 있었다. 최신은 VS 18 Enterprise인데
rem C++ 빌드 도구가 없고, 도구가 있는 것은 더 오래된 2022 BuildTools였다. -latest는 "가장 새
rem 설치 하나"만 주므로 그 하나가 쓸 수 없으면 나머지를 보지 않고 실패한다. 우리가 필요한 것은
rem "가장 새 것"이 아니라 **vcvarsall.bat이 실제로 있는 것**이므로 전부 받아서 첫 항목을 쓴다.
rem ---------------------------------------------------------------------------

if defined VSCMD_ARG_TGT_ARCH goto :cargo_path

rem 괄호가 든 변수 이름(%ProgramFiles(x86)%)을 괄호 블록 안에서 쓰면 cmd 파서가 블록을
rem 일찍 닫는다. 여기서 평범한 이름으로 옮겨 그 함정을 없앤다.
set "PF_X86=%ProgramFiles(x86)%"
set "PF_64=%ProgramFiles%"
if defined ProgramW6432 set "PF_W6432=%ProgramW6432%"

set "VCVARS="
set "VSWHERE="
set "MSVC_HOW="

rem ---- 1) 명시적 override ----
if defined TOMVERSE_VCVARSALL if exist "%TOMVERSE_VCVARSALL%" (
  set "VCVARS=%TOMVERSE_VCVARSALL%"
  set "MSVC_HOW=TOMVERSE_VCVARSALL"
)

rem ---- 2) vswhere ----
if not defined VCVARS (
  if exist "%PF_X86%\Microsoft Visual Studio\Installer\vswhere.exe" set "VSWHERE=%PF_X86%\Microsoft Visual Studio\Installer\vswhere.exe"
  if not defined VSWHERE if exist "%PF_64%\Microsoft Visual Studio\Installer\vswhere.exe" set "VSWHERE=%PF_64%\Microsoft Visual Studio\Installer\vswhere.exe"
  if not defined VSWHERE if defined PF_W6432 if exist "%PF_W6432%\Microsoft Visual Studio\Installer\vswhere.exe" set "VSWHERE=%PF_W6432%\Microsoft Visual Studio\Installer\vswhere.exe"
  rem PATH에 단독 설치된 vswhere도 정당한 조회 도구다.
  if not defined VSWHERE for /f "usebackq delims=" %%W in (`where vswhere.exe 2^>nul`) do if not defined VSWHERE set "VSWHERE=%%W"
)

if not defined VCVARS if defined VSWHERE (
  rem 2a) C++ 빌드 도구를 갖춘 설치 **전부**를 받아 vcvarsall.bat이 있는 첫 항목을 쓴다.
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -all -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
    if not defined VCVARS if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvarsall.bat"
  )
  rem 2b) 미리보기 채널도 본다 — 새 메이저 버전은 한동안 여기에만 있다.
  if not defined VCVARS for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -all -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
    if not defined VCVARS if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvarsall.bat"
  )
  rem 2c) 워크로드 선언과 무관하게 vcvarsall.bat이 있는 설치라면 받아들인다.
  rem     선언은 신뢰의 근거지만 **파일 존재가 최종 판정**이다 — VS 18처럼 새 버전이 컴포넌트
  rem     ID를 바꾸면 -requires가 빗나갈 수 있고, 그때도 실제로 쓸 수 있으면 쓴다.
  if not defined VCVARS for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -all -prerelease -products * -property installationPath 2^>nul`) do (
    if not defined VCVARS if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvarsall.bat"
  )
  if defined VCVARS set "MSVC_HOW=vswhere"
)

rem ---- 3) 이미 VS 셸 안인 경우 ----
if not defined VCVARS if defined VSINSTALLDIR if exist "%VSINSTALLDIR%VC\Auxiliary\Build\vcvarsall.bat" (
  set "VCVARS=%VSINSTALLDIR%VC\Auxiliary\Build\vcvarsall.bat"
  set "MSVC_HOW=VSINSTALLDIR"
)

rem ---- 4) Program Files 서브트리 검색 ----
rem 버전·에디션 목록을 적지 않는다. "Microsoft Visual Studio" 아래에서 vcvarsall.bat을 찾는
rem 검색이므로 새 버전이 나와도 따라간다. 다른 드라이브에 설치했으면 여기서도 못 찾으며,
rem 그 경우의 답은 위 1)의 TOMVERSE_VCVARSALL이다.
if not defined VCVARS call :find_vcvars "%PF_64%"
if not defined VCVARS call :find_vcvars "%PF_X86%"
if not defined VCVARS if defined PF_W6432 call :find_vcvars "%PF_W6432%"

if not defined VCVARS (
  echo [tomverse] MSVC 빌드 도구를 찾지 못했습니다. 확인한 것을 모두 적습니다.
  echo [tomverse]   TOMVERSE_VCVARSALL = "%TOMVERSE_VCVARSALL%"
  echo [tomverse]   ProgramFiles       = "%PF_64%"
  echo [tomverse]   ProgramFiles^(x86^) = "%PF_X86%"
  echo [tomverse]   VSINSTALLDIR       = "%VSINSTALLDIR%"
  if defined VSWHERE (
    echo [tomverse]   vswhere            = "%VSWHERE%"
    echo [tomverse] vswhere는 찾았지만 vcvarsall.bat이 있는 설치를 알려주지 않았습니다.
    echo [tomverse] Visual Studio Installer에서 "C++를 사용한 데스크톱 개발" 워크로드를 추가하세요.
  ) else (
    echo [tomverse]   vswhere            = 없음 ^(Installer 고정 위치 2곳과 PATH를 모두 확인^)
    echo [tomverse] Visual Studio가 설치되어 있는데 이 메시지가 보이면, 설치 위치를 직접 알려주세요:
    echo [tomverse]   set "TOMVERSE_VCVARSALL=^<VS 설치 경로^>\VC\Auxiliary\Build\vcvarsall.bat"
    echo [tomverse] 현재 상태를 그대로 보려면: npm run msvc:doctor
  )
  exit /b 1
)
call "%VCVARS%" x64 >nul 2>nul
if errorlevel 1 (
  echo [tomverse] vcvarsall.bat 실행에 실패했습니다: "%VCVARS%" ^(탐지 경로: %MSVC_HOW%^)
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

rem ---------------------------------------------------------------------------
rem %1 아래 "Microsoft Visual Studio" 서브트리에서 vcvarsall.bat을 찾는다.
rem 첫 결과를 쓴다 — 여러 설치가 있으면 vswhere가 이미 최신을 골랐을 것이고, 여기까지 온 것은
rem vswhere가 없는 경우이므로 하나라도 쓸 수 있으면 진행하는 편이 낫다.
rem ---------------------------------------------------------------------------
:find_vcvars
if "%~1"=="" exit /b 0
if not exist "%~1\Microsoft Visual Studio" exit /b 0
for /f "usebackq delims=" %%F in (`dir /b /s "%~1\Microsoft Visual Studio\vcvarsall.bat" 2^>nul`) do (
  if not defined VCVARS set "VCVARS=%%F"
)
if defined VCVARS set "MSVC_HOW=Program Files 검색"
exit /b 0
