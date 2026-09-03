@echo off
chcp 65001 >nul
REM ===== 《纵横四海》e2e 自动通关一键脚本 =====
REM 自动: 起隔离服务器(20180) -> 跑 mainline-e2e 全系列 -> 落盘日志
REM 用法: 双击运行(需 Node 22+)。Ctrl+C 可停(进度已落盘, 重跑断点续)
setlocal
cd /d "%~dp0"

set SERVER_PORT=20180
set ARTIFACT=artifacts\selfflow

echo [1/3] 准备隔离服务器数据(不污染 4173 主服)...
mkdir "%ARTIFACT%" 2>nul
copy /Y server\data\runtime.sqlite "%ARTIFACT%\runtime.sqlite" >nul 2>&1
copy /Y server\data\accounts.db "%ARTIFACT%\accounts.db" >nul 2>&1
del /Q "%ARTIFACT%\runtime.sqlite-wal" "%ARTIFACT%\runtime.sqlite-shm" 2>nul

echo [2/3] 启动隔离服务器(%SERVER_PORT%)...
set PORT=%SERVER_PORT%
set HOST=127.0.0.1
set ZHSH_RUNTIME_DB=%~dp0%ARTIFACT%\runtime.sqlite
set ZHSH_DB_DIR=%~dp0%ARTIFACT%
start "zhsh-test-server" node server\server.js
REM 等待服务器就绪
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:%SERVER_PORT%/' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){$ok=$true; break} }catch{}; Start-Sleep 1 }; if(-not $ok){ Write-Host '服务器未就绪, 中止'; exit 1 }"

echo [3/3] 跑 mainline-e2e 全系列通关(数小时, 日志落盘 selfflow-run.log)...
set ZHSH_API_BASE=http://127.0.0.1:%SERVER_PORT%
set ZHSH_MAINLINE_MAX_STEPS=30000
node scripts\mainline-e2e.js 2>&1 | tee artifacts\selfflow-run.log

echo.
echo 完成。结果见 artifacts\selfflow-run.log, 存档在 %ARTIFACT%\
pause
