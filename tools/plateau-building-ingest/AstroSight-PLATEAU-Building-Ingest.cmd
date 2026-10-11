@echo off
setlocal
chcp 65001 >nul
rem PLATEAU building ingest. Fetches building files only and stores shapes and heights.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js and run this again.
  pause
  exit /b 1
)
node "%~dp0plateau-building-ingest.mjs" %*
echo.
pause
