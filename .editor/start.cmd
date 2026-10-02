@echo off
chcp 65001 >nul
title Hoshi no Hoshi Nijisou - Local Editor
cd /d "%~dp0.."

rem NOTE: keep this file ASCII-only and CRLF.
rem cmd.exe reads .cmd using the OEM codepage (GBK on zh-CN), so UTF-8
rem Chinese comments get garbled and can break parsing (labels included).
rem The restart-needed marker is written by the editor's "restart" button;
rem this loop relaunches node when it is present, so a restart does not
rem leave the editor closed.

:loop
set "MARK=.editor\restart-needed"
if exist "%MARK%" del /q "%MARK%" >nul 2>&1
node ".editor\server.mjs"
if exist "%MARK%" (
  echo.
  echo   Editor updated - restarting...
  timeout /t 1 /nobreak >nul
  goto loop
)
echo.
echo   Editor stopped.
pause
