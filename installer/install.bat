@echo off
echo [DEPRECATED] 此旧安装器已停用。请使用 release 目录中的 Vaysen 外贸系统 NSIS 安装包。
exit /b 1
chcp 65001 >nul
title 镜雅外贸开发系统 - 安装程序
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║     镜雅外贸开发系统 — 一键安装                     ║
echo ╚══════════════════════════════════════════════════════╝
echo.
echo 正在启动安装程序...
echo.

:: Auto-elevate to admin if not already admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限，正在请求提升...
    powershell -Command "Start-Process '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

:: Run the installer
cd /d "%~dp0.."
powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
echo 安装完成！双击 start-all.bat 启动系统。
pause
