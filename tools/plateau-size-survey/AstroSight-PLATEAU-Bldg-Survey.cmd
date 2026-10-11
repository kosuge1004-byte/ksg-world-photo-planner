@echo off
setlocal
chcp 65001 >nul
rem PLATEAU building data survey. Reads zip directories only; downloads no data.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js and run this again.
  pause
  exit /b 1
)
set "PLATEAU_SURVEY_OUTPUT_DIR=%~dp0..\.."
node "%~dp0plateau-bldg-survey.mjs"
echo.
pause
