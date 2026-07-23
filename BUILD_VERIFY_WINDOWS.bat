@echo off
setlocal
cd /d "%~dp0"
echo [1/3] Installing exact dependencies...
call npm ci
if errorlevel 1 goto :error
echo [2/3] Running TypeScript and Vite build...
call npm run build
if errorlevel 1 goto :error
echo [3/3] Build completed successfully.
echo Output: dist\
pause
exit /b 0
:error
echo.
echo BUILD FAILED. Review the error messages above.
pause
exit /b 1
