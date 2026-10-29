@echo off
cd /d "%~dp0"
echo Installing Voice Review in %~dp0
echo.
"%~dp0python\python.exe" "%~dp0installer.py" %*
echo.
pause
