@echo off
rem the app was called PDF voice review until 2026-10-22: remove both names
del "%APPDATA%\Microsoft\Windows\SendTo\Voice Review.lnk" 2>nul
del "%APPDATA%\Microsoft\Windows\SendTo\PDF voice review.lnk" 2>nul
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do (
  del "%%d\Voice Review.lnk" 2>nul
  del "%%d\PDF voice review.lnk" 2>nul
)
echo Shortcuts removed. To finish, delete this folder:
echo   %~dp0
echo Your reviewed PDFs are not touched. Unfinished recordings, if any, are in
echo   %LOCALAPPDATA%\VoiceReview
echo The speech and safe-mode models (3 to 4 GB) are kept there too, in the models folder,
echo so a reinstall does not download them again. Delete that folder to free the space.
pause
