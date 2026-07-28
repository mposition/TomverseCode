@echo off
rem ---------------------------------------------------------------------------
rem MSVC 환경을 준비하고 **필요한 변수만** 출력한다.
rem
rem `set`으로 전체 환경을 덤프하지 않는 이유: 그 출력에는 OPENAI_API_KEY 같은 자격증명이
rem 그대로 들어간다. 호출자가 그걸 로그로 남기지 않는다고 해도, 애초에 버퍼에 담기지 않게
rem 하는 편이 안전하다. 아래 목록은 MSVC 링크에 실제로 필요한 것만이다.
rem
rem 탐지 로직은 `_env.bat`에 있고 여기서 중복하지 않는다 — Visual Studio 설치 경로를
rem 두 곳에서 관리하면 반드시 갈라진다.
rem ---------------------------------------------------------------------------
call "%~dp0_env.bat"
if errorlevel 1 exit /b %ERRORLEVEL%

echo TOMVERSE_MSVC_OK=1
echo PATH=%PATH%
echo INCLUDE=%INCLUDE%
echo LIB=%LIB%
echo LIBPATH=%LIBPATH%
echo VSCMD_ARG_TGT_ARCH=%VSCMD_ARG_TGT_ARCH%
echo VCINSTALLDIR=%VCINSTALLDIR%
echo WindowsSdkDir=%WindowsSdkDir%
echo WindowsSdkVersion=%WindowsSdkVersion%
echo UniversalCRTSdkDir=%UniversalCRTSdkDir%
echo UCRTVersion=%UCRTVersion%
exit /b 0
