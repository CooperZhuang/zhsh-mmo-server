@echo off
setlocal
cd /d "%~dp0"
start "" wscript.exe "%~dp0启动游戏.vbs"
endlocal & exit /b 0
