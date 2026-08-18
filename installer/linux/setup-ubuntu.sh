#!/bin/bash
# ================================================================
# 闀滈泤澶栬锤寮€鍙戠郴缁?鈥?Ubuntu 涓€閿幆澧冮厤缃剼鏈?# Ubuntu 22.04 / 24.04 LTS
# 鑷姩瀹夎锛歏S Code + Claude Code + 鍚戞棩钁?+ Docker + Node.js
# ================================================================
set -e

printf '%s\n' '[DEPRECATED] 此旧 Ubuntu 安装器已停用；请按 docs/LINUX_DEPLOYMENT.md 使用不可变 tag 部署。' >&2
exit 1

echo "============================================================"
echo "  闀滈泤澶栬锤寮€鍙戠郴缁?- Ubuntu 鐜閰嶇疆"
echo "============================================================"
echo ""

# 鈹€鈹€ 妫€鏌ユ槸鍚?root 鈹€鈹€
if [ "$EUID" -eq 0 ]; then
    echo "璇峰嬁浠?root 杩愯锛屼娇鐢ㄦ櫘閫氱敤鎴?sudo "
    exit 1
fi

# 鈹€鈹€ 0. 绯荤粺鏇存柊 鈹€鈹€
echo "[0/8] 鏇存柊绯荤粺杞欢婧?.."
sudo apt update -qq && sudo apt upgrade -y -qq
echo "  鉁?绯荤粺宸叉洿鏂?

# 鈹€鈹€ 1. 瀹夎蹇呰渚濊禆 鈹€鈹€
echo "[1/8] 瀹夎蹇呰渚濊禆..."
sudo apt install -y -qq curl wget git build-essential ca-certificates gnupg lsb-release || true
echo "  鉁?渚濊禆瀹夎瀹屾垚"

# 鈹€鈹€ 2. 瀹夎 Node.js 20 LTS 鈹€鈹€
echo "[2/8] 瀹夎 Node.js 20 LTS..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
    sudo apt install -y -qq nodejs
fi
echo "  鉁?Node.js: $(node --version)"
echo "  鉁?npm: $(npm --version)"

# 鈹€鈹€ 3. 瀹夎 VS Code 鈹€鈹€
echo "[3/8] 瀹夎 VS Code..."
if ! command -v code &> /dev/null; then
    wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | sudo tee /usr/share/keyrings/vscode.gpg >/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/vscode.gpg] https://packages.microsoft.com/repos/code stable main" | sudo tee /etc/apt/sources.list.d/vscode.list
    sudo apt update -qq && sudo apt install -y -qq code
fi
echo "  鉁?VS Code: $(code --version 2>/dev/null | head -1 || echo 'installed')"

# 鈹€鈹€ 4. 瀹夎 Docker 鈹€鈹€
echo "[4/8] 瀹夎 Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sudo bash 2>/dev/null
    sudo usermod -aG docker $USER
    newgrp docker || true
fi
echo "  鉁?Docker: $(docker --version 2>/dev/null || echo 'installed')"

# 鈹€鈹€ 5. 瀹夎 Claude Code CLI 鈹€鈹€
echo "[5/8] 瀹夎 Claude Code CLI..."
if ! command -v claude &> /dev/null; then
    npm install -g @anthropic-ai/claude-code 2>/dev/null
fi
# 閰嶇疆 DeepSeek API
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'CLAUDE_EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "<DEEPSEEK_API_KEY>",
    "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash"
  },
  "permissions": {
    "allow": [
      { "tool": "WebSearch", "description": "AI customer research" },
      { "tool": "WebFetch", "description": "Website data gathering" },
      { "tool": "Bash", "description": "Build and deployment" },
      { "tool": "Read", "description": "Read project files" },
      { "tool": "Write", "description": "Write code" },
      { "tool": "Edit", "description": "Edit code" }
    ]
  }
}
CLAUDE_EOF
echo "  鉁?Claude Code: $(claude --version 2>/dev/null || echo 'installed')"

# 鈹€鈹€ 6. 瀹夎 鍚戞棩钁?(Sunlogin) 鈹€鈹€
echo "[6/8] 瀹夎 鍚戞棩钁佃繙绋嬫帶鍒?.."
SUNLOGIN_DEB="/tmp/sunlogin.deb"
if [ ! -f "$SUNLOGIN_DEB" ]; then
    wget -q -O "$SUNLOGIN_DEB" "https://dl-cdn.oray.com/sunlogin/linux/sunloginclient_15.2.0.63064_amd64.deb" 2>/dev/null || \
    echo "  鈿狅笍 鍚戞棩钁佃鎵嬪姩涓嬭浇: https://sunlogin.oray.com/download"
fi
if [ -f "$SUNLOGIN_DEB" ]; then
    sudo dpkg -i "$SUNLOGIN_DEB" 2>/dev/null || sudo apt install -f -y -qq
    echo "  鉁?鍚戞棩钁靛凡瀹夎"
else
    echo "  鈿狅笍 鍚戞棩钁典笅杞藉け璐ワ紝璇峰埌 https://sunlogin.oray.com/download 鎵嬪姩瀹夎 Linux 鐗?
fi

# 鈹€鈹€ 7. 鍒涘缓椤圭洰鐩綍骞堕厤缃?systemd 鏈嶅姟 鈹€鈹€
echo "[7/8] 閰嶇疆椤圭洰鏈嶅姟..."
PROJECT_DIR="/opt/vaysen-crm"
sudo mkdir -p "$PROJECT_DIR"

# 鍒涘缓 systemd 鏈嶅姟锛堝紑鏈鸿嚜鍚級
sudo tee /etc/systemd/system/vaysen-crm-backend.service > /dev/null << 'SERVICE'
[Unit]
Description=Jingye Trade System Backend
After=network.target docker.service

[Service]
Type=simple
User=vaysen-crm
WorkingDirectory=/opt/vaysen-crm/backend
ExecStart=/usr/bin/node dist/src/main
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

sudo tee /etc/systemd/system/vaysen-crm-frontend.service > /dev/null << 'SERVICE'
[Unit]
Description=Jingye Trade System Frontend
After=network.target vaysen-crm-backend.service

[Service]
Type=simple
User=vaysen-crm
WorkingDirectory=/opt/vaysen-crm/frontend
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
echo "  鉁?绯荤粺鏈嶅姟宸查厤缃?

# 鈹€鈹€ 8. 鍒涘缓 VS Code workspace 鈹€鈹€
echo "[8/8] 閰嶇疆 VS Code workspace..."
mkdir -p ~/projects
cat > ~/projects/vaysen-crm.code-workspace << 'WORKSPACE'
{
  "folders": [
    { "path": "/opt/vaysen-crm", "name": "闀滈泤澶栬锤寮€鍙戠郴缁? }
  ],
  "settings": {
    "editor.fontSize": 14,
    "editor.tabSize": 2,
    "files.exclude": {
      "**/node_modules": true,
      "**/dist": true
    }
  }
}
WORKSPACE
echo "  鉁?VS Code workspace 閰嶇疆瀹屾垚"

echo ""
echo "============================================================"
echo "  馃帀 閰嶇疆瀹屾垚锛?
echo "============================================================"
echo ""
echo "  1. 灏嗛」鐩鍒跺埌 /opt/vaysen-crm"
echo "  2. 杩愯浠ヤ笅鍛戒护鏋勫缓骞跺惎鍔細"
echo ""
echo "    cd /opt/vaysen-crm/backend"
echo "    npm install --legacy-peer-deps"
echo "    npx prisma generate"
echo "    npm run build"
echo ""
echo "    cd /opt/vaysen-crm/frontend"
echo "    npm install --legacy-peer-deps"
echo "    npm run build"
echo ""
echo "  3. 鍚姩鏈嶅姟锛?
echo "    sudo systemctl enable vaysen-crm-backend"
echo "    sudo systemctl enable vaysen-crm-frontend"
echo "    sudo systemctl start vaysen-crm-backend"
echo "    sudo systemctl start vaysen-crm-frontend"
echo ""
echo "  4. 璁块棶: http://localhost:4001"
echo ""
echo "  5. VS Code: 鎵撳紑 ~/projects/vaysen-crm.code-workspace"
echo ""
echo "  鈿狅笍 闇€瑕侀噸鏂扮櫥褰曟墠鑳戒娇鐢?Docker锛坣ewgrp docker锛?
echo "  鈿狅笍 鍚戞棩钁靛悜鏃ヨ懙闇€鎵嬪姩婵€娲伙紙搴旂敤鑿滃崟鎵撳紑锛?
echo "============================================================"
