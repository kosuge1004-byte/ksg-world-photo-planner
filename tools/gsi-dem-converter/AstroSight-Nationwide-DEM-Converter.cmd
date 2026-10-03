@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0AstroSight-Nationwide-DEM-Converter.ps1"
if errorlevel 1 pause

