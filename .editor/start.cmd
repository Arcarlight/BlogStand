@echo off
chcp 65001 >nul
title Hoshi no Hoshi Nijisou - Local Editor
cd /d "%~dp0.."
node ".editor\server.mjs"
echo.
echo   Editor stopped.
pause