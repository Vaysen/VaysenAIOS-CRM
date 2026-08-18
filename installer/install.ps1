<#
.SYNOPSIS
    闀滈泤澶栬锤寮€鍙戠郴缁?鈥?涓€閿畬鏁村畨瑁呰剼鏈?.DESCRIPTION
    鍏ㄦ柊 Windows 鐢佃剳涓婄殑涓€閿儴缃茶剼鏈€?    鑷姩瀹夎鍜岄厤缃細Docker, PostgreSQL, Redis, 鍚庣, 鍓嶇, n8n, Claude Code.
.PARAMETER InstallDir
    瀹夎鐩綍 (榛樿: C:\Vaysen)
.PARAMETER ServerIP
    鏈満灞€鍩熺綉 IP (鑷姩妫€娴嬫垨鎵嬪姩鎸囧畾)
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -ServerIP 192.168.1.100
#>

param(
    [string]$InstallDir = "C:\Vaysen",
    [string]$ServerIP = ""
)

Write-Error '[DEPRECATED] 此旧安装器已停用。请使用 release 目录中的 Vaysen 外贸系统 NSIS 安装包。'
exit 1

$ErrorActionPreference = "Continue"
$WarningPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "闀滈泤澶栬锤寮€鍙戠郴缁?- 瀹夎绋嬪簭"

Write-Host ""
Write-Host "鈺斺晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晽" -ForegroundColor Cyan
Write-Host "鈺?    闀滈泤澶栬锤寮€鍙戠郴缁?鈥?涓€閿畬鏁村畨瑁?                鈺? -ForegroundColor Cyan
Write-Host "鈺?    Installer v1.0                                   鈺? -ForegroundColor Cyan
Write-Host "鈺氣晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨暆" -ForegroundColor Cyan
Write-Host ""

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageDir = Split-Path -Parent $RootDir

# ============================================================
# 0. 妫€娴嬬郴缁熺幆澧?+ 瀹夎蹇呰宸ュ叿
# ============================================================
Write-Host "[0/7] 妫€娴嬬郴缁熺幆澧?.." -ForegroundColor Yellow

$os = Get-CimInstance Win32_OperatingSystem
Write-Host "  绯荤粺: $($os.Caption) ($($os.OSArchitecture))"
Write-Host "  鍐呭瓨: $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB"
Write-Host "  纾佺洏: $((Get-PSDrive C).Free/1GB | ForEach-Object {[math]::Round($_,1)}) GB 鍙敤"

if ($os.TotalVisibleMemorySize -lt 8GB) {
    Write-Host "  鈿狅笍 鍐呭瓨涓嶈冻8GB, 寤鸿鍗囩骇" -ForegroundColor Red
}

# Node.js 妫€娴?$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Host "  Node.js 鏈畨瑁呫€傛鍦ㄤ笅杞?.."
    $nodeInstaller = "$env:TEMP\nodejs-installer.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi" -OutFile $nodeInstaller
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart" -Wait
    Write-Host "  鉁?Node.js 瀹夎瀹屾垚" -ForegroundColor Green
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "  鉁?Node.js: $(node --version)" -ForegroundColor Green
}

# Claude Code CLI 瀹夎
$claudeCmd = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claudeCmd) {
    Write-Host "  瀹夎 Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code 2>&1 | Out-Null
    Write-Host "  鉁?Claude Code CLI 瀹夎瀹屾垚" -ForegroundColor Green
} else {
    Write-Host "  鉁?Claude Code CLI 宸插畨瑁? -ForegroundColor Green
}

# VS Code 妫€娴?$vscodePath = (Get-Command code -ErrorAction SilentlyContinue).Source
if (-not $vscodePath) {
    Write-Host "  VS Code 鏈畨瑁呫€傛鍦ㄤ笅杞?.."
    $vsInstaller = "$env:TEMP\VSCodeSetup.exe"
    Invoke-WebRequest -Uri "https://update.code.visualstudio.com/latest/win32-x64-user/stable" -OutFile $vsInstaller
    Start-Process $vsInstaller -ArgumentList "/verysilent /suppressmsgboxes /mergetasks=!runcode" -Wait
    Write-Host "  鉁?VS Code 瀹夎瀹屾垚" -ForegroundColor Green
} else {
    Write-Host "  鉁?VS Code 宸插畨瑁? -ForegroundColor Green
}

# ============================================================
# 1. 鑾峰彇鏈満IP
# ============================================================
Write-Host ""
Write-Host "[1/7] 鑾峰彇缃戠粶閰嶇疆..." -ForegroundColor Yellow

if (-not $ServerIP) {
    try {
        $adapters = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
            $_.IPAddress -ne '127.0.0.1' -and $_.InterfaceAlias -notmatch 'Loopback|Hyper-V|vEthernet|WSL|VirtualBox|VMware|Bluetooth'
        } | Sort-Object { $_.IPAddress -match '^192\.168\.' }, { $_.IPAddress -match '^10\.' } -Descending
        if ($adapters) {
            $ServerIP = $adapters[0].IPAddress
        }
    } catch {}
    if (-not $ServerIP) {
        $ServerIP = Read-Host "  璇疯緭鍏ユ湰鏈哄眬鍩熺綉IP (濡?192.168.1.xxx)"
    }
}
Write-Host "  鏈嶅姟鍣↖P: $ServerIP" -ForegroundColor Green

# ============================================================
# 2. 瀹夎 Docker Desktop
# ============================================================
Write-Host ""
Write-Host "[2/7] 妫€娴?Docker Desktop..." -ForegroundColor Yellow

$dockerPath = @(
    "C:\Program Files\Docker\Docker\resources\bin\docker.exe",
    "${env:ProgramFiles}\Docker\Docker\resources\bin\docker.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $dockerPath) {
    Write-Host "  Docker Desktop 鏈畨瑁呫€傛鍦ㄤ笅杞?.."
    $dockerInstaller = "$env:TEMP\DockerDesktopInstaller.exe"
    Invoke-WebRequest -Uri "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe" -OutFile $dockerInstaller
    Write-Host "  璇锋墜鍔ㄥ畨瑁?Docker Desktop (瀹夎绋嬪簭宸蹭笅杞藉埌: $dockerInstaller)"
    Start-Process $dockerInstaller
    Write-Host "  瀹夎瀹屾垚鍚庨噸鍚數鑴戯紝鍐嶈繍琛屾湰鑴氭湰銆?
    Read-Host "  鎸?Enter 閫€鍑?
    exit 0
}

# Enable WSL2
Write-Host "  鍚敤 WSL2..."
try {
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart 2>$null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart 2>$null
    wsl --set-default-version 2 2>$null
} catch {}

# Start Docker
Write-Host "  鍚姩 Docker Desktop..."
try {
    & $dockerPath version 2>$null | Out-Null
    Write-Host "  鉁?Docker 杩愯涓? -ForegroundColor Green
} catch {
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -WindowStyle Hidden
    Write-Host "  绛夊緟 Docker 鍚姩 (鏈€澶?20绉?..."
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Seconds 5
        try { & $dockerPath version 2>$null | Out-Null; Write-Host "  鉁?Docker 宸插惎鍔?; break } catch {}
    }
}

# ============================================================
# 3. 鍚姩鍩虹璁炬柦 (PostgreSQL + Redis + n8n + SearXNG)
# ============================================================
Write-Host ""
Write-Host "[3/7] 鍚姩鍩虹璁炬柦..." -ForegroundColor Yellow

Set-Location $PackageDir

# Pull images and start infrstructure
$infraFile = Join-Path $PackageDir "docker-compose.infra.local.yml"
if (Test-Path $infraFile) {
    Write-Host "  鎷夊彇 Docker 闀滃儚..."
    & $dockerPath compose -f $infraFile pull 2>&1 | Out-Null
    Write-Host "  鍚姩 PostgreSQL, Redis, n8n, SearXNG..."
    & $dockerPath compose -f $infraFile up -d
    Write-Host "  鉁?鍩虹璁炬柦宸插惎鍔? -ForegroundColor Green
}

# ============================================================
# 4. 瀹夎鍚庣
# ============================================================
Write-Host ""
Write-Host "[4/7] 瀹夎鍚庣..." -ForegroundColor Yellow

$BackendDir = Join-Path $PackageDir "backend"
Set-Location $BackendDir

# Install dependencies
Write-Host "  瀹夎 Node.js 渚濊禆..."
npm install --legacy-peer-deps 2>&1 | Out-Null

# Setup .env
$envFile = Join-Path $BackendDir ".env"
@"
DATABASE_URL=postgresql://vaysen-crm:vaysen-crm_password@localhost:15432/vaysen-crm_pilot?schema=public
REDIS_HOST=localhost
REDIS_PORT=16379
JWT_SECRET=jingye-vaysen-crm-jwt-secret-2026
JWT_REFRESH_SECRET=jingye-vaysen-crm-jwt-refresh-secret-2026
EMAIL_ENCRYPTION_KEY=jingye-email-encryption-32chars!
DEEPSEEK_API_KEY=<DEEPSEEK_API_KEY>
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
REACHER_API_URL=http://localhost:18080
FRONTEND_URL=http://${ServerIP}:4001
PORT=4000
NODE_ENV=production
"@ | Out-File -FilePath $envFile -Encoding utf8

# Run migrations
Write-Host "  杩愯鏁版嵁搴撹縼绉?.."
npx prisma migrate deploy --schema=prisma/schema.prisma 2>&1 | Out-Null

# Seed data
Write-Host "  鍒濆鍖栫瀛愭暟鎹?.."
npx prisma db seed 2>&1 | Out-Null

# Build
Write-Host "  缂栬瘧鍚庣..."
npm run build 2>&1 | Out-Null

# Create startup script
$startBackend = Join-Path $PackageDir "start-backend.bat"
@"
@echo off
cd /d "$BackendDir"
echo 闀滈泤澶栬锤寮€鍙戠郴缁?- 鍚庣鍚姩涓?..
node dist/src/main
pause
"@ | Out-File -FilePath $startBackend -Encoding ASCII

Write-Host "  鉁?鍚庣瀹夎瀹屾垚" -ForegroundColor Green

# ============================================================
# 5. 瀹夎鍓嶇
# ============================================================
Write-Host ""
Write-Host "[5/7] 瀹夎鍓嶇..." -ForegroundColor Yellow

$FrontendDir = Join-Path $PackageDir "frontend"
Set-Location $FrontendDir

# Install dependencies
Write-Host "  瀹夎 Node.js 渚濊禆..."
npm install --legacy-peer-deps 2>&1 | Out-Null

# Setup .env
$frontendEnv = Join-Path $FrontendDir ".env"
@"
NEXT_PUBLIC_API_URL=http://${ServerIP}:4000/api
NEXT_PUBLIC_APP_NAME=闀滈泤澶栬锤寮€鍙戠郴缁?"@ | Out-File -FilePath $frontendEnv -Encoding utf8

# Build
Write-Host "  缂栬瘧鍓嶇..."
npm run build 2>&1 | Out-Null

# Create startup script
$startFrontend = Join-Path $PackageDir "start-frontend.bat"
@"
@echo off
cd /d "$FrontendDir"
echo 闀滈泤澶栬锤寮€鍙戠郴缁?- 鍓嶇鍚姩涓?..
npm run start
"@ | Out-File -FilePath $startFrontend -Encoding ASCII

Write-Host "  鉁?鍓嶇瀹夎瀹屾垚" -ForegroundColor Green

# ============================================================
# 6. 閰嶇疆 Claude Code + DeepSeek
# ============================================================
Write-Host ""
Write-Host "[6/7] 閰嶇疆 Claude Code + DeepSeek..." -ForegroundColor Yellow

$claudeDir = Join-Path $PackageDir ".claude"
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }

$claudeSettings = @"
{
  "model": "deepseek-v4-pro[1m]",
  "permissions": {
    "allow": [
      { "tool": "WebSearch", "description": "AI customer research" },
      { "tool": "WebFetch", "description": "Website data gathering" },
      { "tool": "Bash", "description": "Build and deployment" },
      { "tool": "Read", "description": "Read project files" },
      { "tool": "Write", "description": "Write code" },
      { "tool": "Edit", "description": "Edit code" },
      { "tool": "PowerShell", "description": "Windows commands" }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash"
  }
}
"@
$claudeSettings | Out-File -FilePath (Join-Path $claudeDir "settings.local.json") -Encoding utf8

# Global Claude config
$userClaudeDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path $userClaudeDir)) { New-Item -ItemType Directory -Path $userClaudeDir -Force | Out-Null }
$claudeSettings | Out-File -FilePath (Join-Path $userClaudeDir "settings.json") -Encoding utf8

Write-Host "  鉁?Claude Code 閰嶇疆瀹屾垚 (DeepSeek API)" -ForegroundColor Green

# ============================================================
# 7. 瀹屾垚
# ============================================================
Write-Host ""
Write-Host "鈺斺晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晽" -ForegroundColor Green
Write-Host "鈺?      馃帀 闀滈泤澶栬锤寮€鍙戠郴缁熷畨瑁呭畬鎴愶紒                  鈺? -ForegroundColor Green
Write-Host "鈺氣晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨暆" -ForegroundColor Green
Write-Host ""
Write-Host "  璁块棶鍦板潃:" -ForegroundColor Cyan
Write-Host "  鍓嶇:    http://${ServerIP}:4001" -ForegroundColor White
Write-Host "  鍚庣API: http://${ServerIP}:4000/api" -ForegroundColor White
Write-Host "  n8n:     http://${ServerIP}:5678" -ForegroundColor White
Write-Host ""
Write-Host "  蹇€熷惎鍔?" -ForegroundColor Cyan
Write-Host "  鍙屽嚮 start-backend.bat 鍚姩鍚庣" -ForegroundColor White
Write-Host "  鍙屽嚮 start-frontend.bat 鍚姩鍓嶇" -ForegroundColor White
Write-Host ""
Write-Host "  Claude Code: 鍦ㄧ粓绔緭鍏?claude 鍗冲彲浣跨敤" -ForegroundColor White
Write-Host ""
Read-Host "鎸?Enter 瀹屾垚"
