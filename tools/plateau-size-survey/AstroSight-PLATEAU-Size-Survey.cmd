@echo off
setlocal
chcp 65001 >nul
rem PLATEAU data size survey. Lists file sizes only; downloads no data.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js and run this again.
  pause
  exit /b 1
)
set "PLATEAU_SURVEY_OUTPUT_DIR=%~dp0..\.."
node "%~dp0plateau-size-survey.mjs"
echo.
pause
