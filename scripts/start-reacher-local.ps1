# Reacher 本地运行脚本 (不依赖 Docker)
# 下载 Reacher 二进制文件并直接运行
#
# 用法: .\scripts\start-reacher-local.ps1
# 停止: Ctrl+C

$ErrorActionPreference = "Stop"

$REACHER_VERSION = "0.6.1"
$REACHER_PORT = 8080
$DOWNLOAD_DIR = "$PSScriptRoot\..\tools\reacher"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Reacher 邮箱验证服务 (本地运行)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 创建目录
if (!(Test-Path $DOWNLOAD_DIR)) {
    New-Item -ItemType Directory -Path $DOWNLOAD_DIR -Force | Out-Null
}

$BINARY_PATH = "$DOWNLOAD_DIR\reacher-backend.exe"

# 检查是否已下载
if (!(Test-Path $BINARY_PATH)) {
    Write-Host "[1/3] 下载 Reacher v$REACHER_VERSION ..." -ForegroundColor Yellow
    $DOWNLOAD_URL = "https://github.com/reacherhq/backend/releases/download/v${REACHER_VERSION}/reacher_backend_x86_64-pc-windows-msvc.exe.zip"
    $ZIP_PATH = "$DOWNLOAD_DIR\reacher.zip"

    try {
        Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $ZIP_PATH -UseBasicParsing
        Expand-Archive -Path $ZIP_PATH -DestinationPath $DOWNLOAD_DIR -Force
        Remove-Item $ZIP_PATH -Force -ErrorAction SilentlyContinue
        # 重命名
        $EXTRACTED = Get-ChildItem -Path $DOWNLOAD_DIR -Filter "*.exe" | Select-Object -First 1
        if ($EXTRACTED -and $EXTRACTED.Name -ne "reacher-backend.exe") {
            Rename-Item -Path $EXTRACTED.FullName -NewName "reacher-backend.exe"
        }
        Write-Host "  ✅ 下载完成" -ForegroundColor Green
    } catch {
        Write-Host "  ❌ 下载失败: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        Write-Host "  手动下载地址:" -ForegroundColor Yellow
        Write-Host "  https://github.com/reacherhq/backend/releases" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  下载后将文件重命名为 reacher-backend.exe 放到:" -ForegroundColor Yellow
        Write-Host "  $DOWNLOAD_DIR" -ForegroundColor Cyan
        exit 1
    }
} else {
    Write-Host "[1/3] Reacher 已存在" -ForegroundColor Green
}

# 检查端口占用
Write-Host "[2/3] 检查端口 $REACHER_PORT ..." -ForegroundColor Yellow
$PORT_CHECK = netstat -ano | Select-String ":$REACHER_PORT " | Select-String "LISTENING"
if ($PORT_CHECK) {
    Write-Host "  ⚠️  端口 $REACHER_PORT 已被占用" -ForegroundColor Yellow
    Write-Host "  占用进程: $PORT_CHECK" -ForegroundColor Yellow
    Write-Host ""
    $CONTINUE = Read-Host "  是否继续? (y/n)"
    if ($CONTINUE -ne "y") { exit 0 }
} else {
    Write-Host "  ✅ 端口可用" -ForegroundColor Green
}

# 启动 Reacher
Write-Host "[3/3] 启动 Reacher ..." -ForegroundColor Yellow
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Reacher 运行中" -ForegroundColor Green
Write-Host "  地址: http://localhost:$REACHER_PORT" -ForegroundColor Green
Write-Host "  停止: Ctrl+C" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 设置环境变量
$env:RUST_LOG = "info"
$env:PORT = $REACHER_PORT

# 运行
& $BINARY_PATH
