@echo off
echo [DEPRECATED] 此旧新机脚本不属于当前发布。请使用 Vaysen NSIS 安装包和 docs/LINUX_DEPLOYMENT.md。
exit /b 1
setlocal EnableDelayedExpansion
title Jingye Setup
cd /d "%~dp0.."

echo ============================================================
echo   Jingye Trade System - New PC Setup
echo   VS Code + Claude Code + DeepSeek API
echo ============================================================
echo.

:: Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] Installing Node.js...
    curl.exe -L -o "%TEMP%\node.msi" "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    msiexec /i "%TEMP%\node.msi" /quiet /norestart
    echo   Node.js installed. Refreshing PATH...
    call :refreshPath
    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo   WARNING: Node.js not found in PATH after install.
        echo   Please restart your computer, then run this script again.
        pause
        exit /b
    )
)
echo [1/4] Node.js: OK
goto :skipRefresh

:refreshPath
    for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\Node.js" /v InstallPath 2^>nul') do set "NODEPATH=%%b"
    if defined NODEPATH set "PATH=%NODEPATH%;%PATH%"
    for /f "tokens=2*" %%a in ('reg query "HKCU\SOFTWARE\Node.js" /v InstallPath 2^>nul') do set "NODEPATH=%%b"
    if defined NODEPATH set "PATH=%NODEPATH%;%PATH%"
    :: Also try common locations
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
    if exist "C:\Program Files (x86)\nodejs\node.exe" set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    set "PATH=%APPDATA%\npm;%PATH%"
goto :eof

:skipRefresh

:: VS Code
where code >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/4] Installing VS Code...
    curl.exe -L -o "%TEMP%\vscode.exe" "https://update.code.visualstudio.com/latest/win32-x64-user/stable"
    "%TEMP%\vscode.exe" /verysilent /suppressmsgboxes
    echo   Done.
)
echo [2/4] VS Code: OK

:: Claude Code CLI
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo [3/4] Installing Claude Code CLI...
    call npm install -g @anthropic-ai/claude-code
    echo   Done.
)
echo [3/4] Claude Code CLI: OK

:: DeepSeek Config
echo [4/4] Configuring DeepSeek API...
if not exist "%USERPROFILE%\.claude" mkdir "%USERPROFILE%\.claude"
copy /Y "%~dp0config\claude-settings.json" "%USERPROFILE%\.claude\settings.json" >nul
echo [4/4] DeepSeek API: Configured

echo.
echo ============================================================
echo   Setup Complete!
echo.
echo   VS Code:     type 'code' in terminal
echo   Claude Code:  type 'claude' in terminal
echo   DeepSeek API: ready
echo ============================================================
echo.
echo Next - build the project:
echo   1. cd backend
echo   2. npm install --legacy-peer-deps
echo   3. npx prisma db push --accept-data-loss
echo   4. npx prisma generate
echo   5. npm run build
echo   6. cd ..\frontend
echo   7. npm install --legacy-peer-deps
echo   8. npm run build
echo   9. cd .. ^& start-all.bat
echo.
pause
