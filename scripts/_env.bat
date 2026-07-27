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
rem ---------------------------------------------------------------------------

if defined VSCMD_ARG_TGT_ARCH goto :cargo_path

set "VCVARS="
for %%P in (
  "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
  "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
) do if not defined VCVARS if exist %%P set "VCVARS=%%~P"

if not defined VCVARS (
  echo [tomverse] MSVC 빌드 도구를 찾지 못했습니다.
  echo [tomverse] Visual Studio Build Tools 2022 + "C++를 사용한 데스크톱 개발"을 설치하세요.
  exit /b 1
)
call "%VCVARS%" x64 >nul 2>nul

:cargo_path
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%PATH%;%USERPROFILE%\.cargo\bin"
exit /b 0
