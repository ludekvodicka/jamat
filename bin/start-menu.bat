@echo off
rem Generic Jamat terminal-menu launcher (the app-cli TUI).  Usage:  start-menu.bat [config-dir]
rem   [config-dir]  -> JAMAT_CONFIG_DIR: the portable dir holding config + menu-prefs + usage-stats.
rem                    Omit to use the app default (~/.jamat). Point it at an SVN-synced dir to share
rem                    settings across machines, or at an empty dir to first-run-seed a starter config.
rem   (also honors a pre-set %JAMAT_CONFIG_DIR% in the environment.)
for %%I in ("%~dp0..") do set "JAMAT_ROOT=%%~fI"
cd /d "%JAMAT_ROOT%"
if not "%~1"=="" set "JAMAT_CONFIG_DIR=%~1"

node --import tsx app-cli/executor.ts
