#!/bin/bash
# 镜雅外贸开发系统 — Linux 启动脚本
set -e

printf '%s\n' '[DEPRECATED] 此旧启动器已停用；请使用 docker-compose.prod.yml 与 deploy.sh。' >&2
exit 1


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "============================================================"
echo "  镜雅外贸开发系统 — 启动所有服务"
echo "============================================================"
echo ""

echo "[1/4] 启动 Docker 基础设施..."
cd "$PROJECT_DIR"
docker compose -f docker-compose.infra.local.yml up -d
echo ""

echo "[2/4] 等待数据库就绪..."
sleep 10

echo "[3/4] 启动后端 (端口 4000)..."
cd "$PROJECT_DIR/backend"
nohup node dist/src/main > /tmp/vaysen-crm-backend.log 2>&1 &
echo "  PID: $!"

echo "[4/4] 启动前端 (端口 4001)..."
cd "$PROJECT_DIR/frontend"
nohup npm run start > /tmp/vaysen-crm-frontend.log 2>&1 &
echo "  PID: $!"

echo ""
echo "============================================================"
echo "  服务启动中..."
echo "  前端:  http://localhost:4001"
echo "  后端:  http://localhost:4000/api"
echo "  n8n:   http://localhost:5678"
echo "============================================================"
echo ""
echo "查看日志:"
echo "  tail -f /tmp/vaysen-crm-backend.log"
echo "  tail -f /tmp/vaysen-crm-frontend.log"
echo ""
