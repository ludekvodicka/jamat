@echo off
cd /d "%~dp0"
echo Building Jamat...
call npx electron-vite build
if %errorlevel% neq 0 goto :fail
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win --dir
if %errorlevel% neq 0 goto :fail
echo.
echo Build complete! Output in dist\win-unpacked\
echo Run with: ..\.private\app-electron\jamat-^<user^>.bat
goto :end
:fail
echo.
echo Build failed!
:end
pause
