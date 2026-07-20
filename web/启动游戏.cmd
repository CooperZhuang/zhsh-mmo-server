@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto node_missing

if "%ZHSH_NO_BROWSER%"=="1" (
  node "%~dp0game-server.js"
) else (
  node "%~dp0game-server.js" --open
)
set "ZHSH_EXIT_CODE=%ERRORLEVEL%"
if not "%ZHSH_EXIT_CODE%"=="0" goto failed
endlocal & exit /b 0

:node_missing
powershell.exe -NoProfile -Command "$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5pyq5om+5YiwIE5vZGUuanPvvIzml6Dms5XlkK/liqjmuLjmiI/jgILor7flhYjlronoo4UgTm9kZS5qcyAyMiDmiJbmm7Tpq5jniYjmnKzvvIznhLblkI7ph43mlrDlj4zlh7vmnKzmlofku7bjgII=')); Write-Host $m"
pause
endlocal & exit /b 1

:failed
powershell.exe -NoProfile -Command "$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5ri45oiP5ZCv5Yqo5aSx6LSl77yM6K+35p+l55yL5LiK5pa56ZSZ6K+v5L+h5oGv44CC')); Write-Host $m"
pause
endlocal & exit /b %ZHSH_EXIT_CODE%
