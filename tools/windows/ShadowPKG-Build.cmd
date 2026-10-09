@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ShadowPKG-Build.ps1" %*
echo.
pause
