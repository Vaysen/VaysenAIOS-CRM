@echo off
echo [DEPRECATED] 此旧恢复入口已停用。请在 Linux 服务器使用 scripts/restore-db.sh 和已校验备份。
exit /b 1
chcp 65001 >nul
cd /d "%~dp0.."
echo ============================================================
echo   镜雅外贸系统 - 数据库恢复脚本
echo ============================================================
echo.
echo This will RESTORE the database from the dump file.
echo All existing data will be REPLACED.
echo.
pause

echo [1/3] Dropping old database...
docker exec vaysen-ai-crm-postgres-local psql -U vaysen-crm -c "DROP DATABASE IF EXISTS vaysen-crm_pilot;" 2>nul
docker exec vaysen-ai-crm-postgres-local psql -U vaysen-crm -c "CREATE DATABASE vaysen-crm_pilot OWNER vaysen-crm;" 2>nul

echo [2/3] Restoring database from dump...
docker exec -i vaysen-ai-crm-postgres-local pg_restore -U vaysen-crm -d vaysen-crm_pilot --no-owner --no-acl < "vaysen-ai-crm-full.dump"

echo [3/3] Running Prisma migrations...
cd backend
npx prisma db push --accept-data-loss --skip-generate
npx prisma generate

echo.
echo ============================================================
echo   Database restored! Now build and start:
echo   cd backend ^&^& npm run build
echo   cd ..\frontend ^&^& npm run build
echo   start-all.bat
echo ============================================================
pause
