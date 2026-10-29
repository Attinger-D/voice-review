@echo off
rem Voice Review: open a PDF or a video to highlight and dictate comments.
rem Drop a PDF or a video on this file, use "Send to > Voice Review", or double-click to choose one.
start "" "%~dp0python\pythonw.exe" "%~dp0app\server.py" %*
