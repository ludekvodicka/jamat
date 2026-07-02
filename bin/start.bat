@echo off
rem Generic Jamat launcher (compiled app).  Usage:  start.bat [config-dir]
rem   [config-dir]  -> JAMAT_CONFIG_DIR: the portable dir holding config + app-state + caches + ideas.
rem                    Omit to use the app default (~/.jamat). Point it at an SVN-synced dir to sync
rem                    settings across machines, or at an empty dir to run the first-run setup wizard.
rem   (also honors a pre-set %JAMAT_CONFIG_DIR% in the environment, e.g. from the relaunch helper.)
for %%I in ("%~dp0..") do set "JAMAT_ROOT=%%~fI"
cd /d "%JAMAT_ROOT%\app-electron"
if not "%~1"=="" set "JAMAT_CONFIG_DIR=%~1"

set "EXE=dist\win-unpacked\Jamat.exe"
set "VERFILE=dist\.built-version"

rem Ensure deps in root + app-electron before compiling/launching (reacts to a fresh checkout / pull).
call :ENSURE_DEPS ".."
if errorlevel 1 exit /b 1
call :ENSURE_DEPS "."
if errorlevel 1 exit /b 1

rem Recompile whenever the app version changed (root package.json, bumped via `npm run bump`) or the exe is missing.
for /f "delims=" %%V in ('node -p "require('../package.json').version" 2^>nul') do set "CUR_VER=%%V"
set "BUILT_VER="
if exist "%VERFILE%" set /p BUILT_VER=<"%VERFILE%"

set "NEED_BUILD="
if not exist "%EXE%" set "NEED_BUILD=1"
if not "%CUR_VER%"=="%BUILT_VER%" set "NEED_BUILD=1"

if defined NEED_BUILD (
    echo App changed [built=%BUILT_VER% current=%CUR_VER%]. Compiling...
    taskkill /f /im "Jamat.exe" >nul 2>&1
    timeout /t 2 /nobreak >nul 2>&1
    call npm run compile
    if errorlevel 1 (
        echo Build failed. Falling back to dev mode.
        npm run dev
        exit /b
    )
    >"%VERFILE%" echo %CUR_VER%
)

start "" "%EXE%"
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
