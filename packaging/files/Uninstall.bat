@echo off
rem Removes Voice Review: its shortcuts, its entry in Settings > Apps and this folder.
rem The models, settings and unfinished recordings in %LOCALAPPDATA%\VoiceReview are kept; reviewed PDFs are never touched.
cd /d "%TEMP%"
"%~dp0python\python.exe" "%~dp0installer.py" --uninstall & exit /b
