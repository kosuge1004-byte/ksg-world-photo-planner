@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js and run this again.
  pause
  exit /b 1
)
node "%~dp0verify-plateau-buildings.mjs" %*
echo.
if errorlevel 1 (
  echo PLATEAU data verification failed. See verification.json in the data folder.
) else (
  echo PLATEAU data verification completed successfully.
)
pause
