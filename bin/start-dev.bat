@echo off
rem Generic Jamat DEV launcher (electron-vite dev).  Usage:  start-dev.bat [config-dir]
rem   [config-dir]  -> JAMAT_CONFIG_DIR (see start.bat). Dev uses the `-debug` leaf of the config-dir
rem                    for the Electron-owned state, so dev and prod don't share app-state / caches.
rem                    Omit to use the app default (~/.jamat-debug).
for %%I in ("%~dp0..") do set "JAMAT_ROOT=%%~fI"
cd /d "%JAMAT_ROOT%\app-electron"
if not "%~1"=="" set "JAMAT_CONFIG_DIR=%~1"

call :ENSURE_DEPS ".."
if errorlevel 1 exit /b 1
call :ENSURE_DEPS "."
if errorlevel 1 exit /b 1

npx electron-vite dev
goto :EOF

:ENSURE_DEPS
pushd "%~1"
node -e "const fs=require('fs');try{const a=fs.statSync('package-lock.json').mtimeMs;const b=fs.statSync('node_modules/.package-lock.json').mtimeMs;process.exit(a>b?1:0)}catch{process.exit(1)}"
if errorlevel 1 (
    echo Installing dependencies in %~1 ...
    call npm install
    if errorlevel 1 (
        echo npm install failed in %~1
        popd
        exit /b 1
    )
)
popd
goto :EOF
