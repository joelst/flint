@echo off
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%..

set CANDIDATES[0]=%PROJECT_ROOT%\src-tauri\target\release\Flint.exe
set CANDIDATES[1]=%PROJECT_ROOT%\src-tauri\target\release\tauri-app.exe
set CANDIDATES[2]=%PROJECT_ROOT%\src-tauri\target\debug\Flint.exe

set EXE=
for /L %%i in (0,1,2) do (
    if exist "!CANDIDATES[%%i]!" (
        set EXE=!CANDIDATES[%%i]!
        goto :found
    )
)

echo Could not find a built Flint.exe.
echo Run "npm run tauri:build" first (or "tauri build --debug").
exit /b 1

:found
echo Launching built Flint from: %EXE%
start "" "%EXE%"
endlocal
