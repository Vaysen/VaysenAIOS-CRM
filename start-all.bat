@echo off
chcp 65001 >nul
title Vaysen Local Server

cd /d "%~dp0"

echo.
echo ==========================================
echo   Vaysen - start all local services
echo ==========================================
echo.

echo [1/8] Start Docker infrastructure...
docker compose -f docker-compose.infra.local.yml up -d
echo.

echo [2/8] Wait for database and Redis...
timeout /t 10 /nobreak >nul

echo [3/8] Start backend API on port 4000...
start "Vaysen-API" cmd /c "cd /d backend && node dist/src/main"

echo [4/8] Start email compose worker...
start "Vaysen-EmailCompose" cmd /c "cd /d backend && node dist/src/worker-email-compose"

echo [5/8] Start email validate worker...
start "Vaysen-EmailValidate" cmd /c "cd /d backend && node dist/src/worker-email-validate"

echo [6/8] Start email send worker...
start "Vaysen-EmailSend" cmd /c "cd /d backend && node dist/src/worker-email-send"

echo [7/8] Start AI prospect and research workers...
start "Vaysen-ProspectSearch" cmd /c "cd /d backend && node dist/src/worker-prospect-search"
start "Vaysen-DeepResearch" cmd /c "cd /d backend && node dist/src/worker-deep-research"
start "Vaysen-Maintenance" cmd /c "cd /d backend && node dist/src/worker-maintenance"

echo [8/8] Start frontend UI on port 4001...
start "Vaysen-Frontend" cmd /c "cd /d frontend && npm run start"

echo.
echo ==========================================
echo   Vaysen is starting
echo ==========================================
echo   Local UI:   http://localhost:4001
echo   LAN UI:     http://192.168.1.233:4001
echo   Backend:    http://localhost:4000/api
echo   n8n:        http://localhost:5678
echo.
echo Keep the API and Worker windows open while using the system.
echo.

pause
