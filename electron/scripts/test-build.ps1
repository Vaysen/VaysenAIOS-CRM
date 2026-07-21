<#
.SYNOPSIS
    Electron 打包测试脚本

.DESCRIPTION
    编译 TypeScript，检查 dist/ 输出文件完整性，
    检查 package.json 和 electron-builder.yml 配置，
    输出测试报告。

.NOTES
    用法：powershell -ExecutionPolicy Bypass -File scripts\test-build.ps1
#>

param(
    [switch]$SkipBuild,
    [switch]$Verbose
)

# ── 初始化 ────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = Split-Path -Parent $scriptRoot
$reportFile = Join-Path $projectRoot "build-test-report.txt"

$testResults = [System.Collections.ArrayList]::new()
$passCount = 0
$failCount = 0
$warnCount = 0

function Write-TestResult {
    param(
        [string]$Category,
        [string]$TestName,
        [string]$Status,  # PASS, FAIL, WARN
        [string]$Detail = ""
    )
    $icon = switch ($Status) {
        "PASS" { "[PASS]" }
        "FAIL" { "[FAIL]" }
        "WARN" { "[WARN]" }
        default { "[????]" }
    }
    $line = "$icon $Category > $TestName"
    if ($Detail) { $line += " :: $Detail" }

    $script:testResults.Add($line) | Out-Null

    switch ($Status) {
        "PASS" { $script:passCount++; if ($Verbose) { Write-Host $line -ForegroundColor Green } }
        "FAIL" { $script:failCount++; Write-Host $line -ForegroundColor Red }
        "WARN" { $script:warnCount++; if ($Verbose) { Write-Host $line -ForegroundColor Yellow } }
    }
}

function Test-FileExists {
    param([string]$Path, [string]$Category, [string]$TestName)
    if (Test-Path $Path) {
        Write-TestResult $Category $TestName "PASS"
        return $true
    } else {
        Write-TestResult $Category $TestName "FAIL" "文件不存在: $Path"
        return $false
    }
}

function Test-NotNullOrEmpty {
    param($Value, [string]$Category, [string]$TestName)
    if ($null -ne $Value -and $Value -ne "") {
        Write-TestResult $Category $TestName "PASS"
        return $true
    } else {
        Write-TestResult $Category $TestName "FAIL" "值为空"
        return $false
    }
}

# ── 开始报告 ──────────────────────────────────────────────────

$startTime = Get-Date
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Electron 打包测试" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  项目路径: $projectRoot" -ForegroundColor Gray
Write-Host "  时间: $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Gray
Write-Host ""

# ════════════════════════════════════════════════════════════
# 1. 编译 TypeScript
# ════════════════════════════════════════════════════════════

Write-Host "[1/5] 编译 TypeScript..." -ForegroundColor Cyan

if ($SkipBuild) {
    Write-TestResult "TypeScript编译" "跳过编译" "WARN" "使用了 -SkipBuild 参数"
} else {
    # 检查 tsc 是否可用
    $tscPath = Join-Path $projectRoot "node_modules\.bin\tsc.cmd"
    if (Test-Path $tscPath) {
        Write-TestResult "TypeScript编译" "tsc 可用性" "PASS"

        # 执行编译
        $buildOutput = & $tscPath --project $projectRoot 2>&1
        $buildExitCode = $LASTEXITCODE

        if ($buildExitCode -eq 0) {
            Write-TestResult "TypeScript编译" "编译成功" "PASS"
        } else {
            Write-TestResult "TypeScript编译" "编译成功" "FAIL" "tsc 退出码: $buildExitCode"
            Write-Host "  编译错误输出:" -ForegroundColor Red
            $buildOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        }
    } else {
        Write-TestResult "TypeScript编译" "tsc 可用性" "FAIL" "找不到 tsc: $tscPath"
    }
}

Write-Host ""

# ════════════════════════════════════════════════════════════
# 2. 检查 dist/ 输出文件完整性
# ════════════════════════════════════════════════════════════

Write-Host "[2/5] 检查 dist/ 输出文件..." -ForegroundColor Cyan

$distRoot = Join-Path $projectRoot "dist"

# 检查 dist 目录存在
Test-FileExists $distRoot "dist目录" "dist 目录存在"

# 主进程文件
$mainFiles = @(
    "main\app.js",
    "main\ipc-handlers.js",
    "main\window-manager.js",
    "main\local-server.js",
    "main\ai-communications.js",
    "main\tray.js",
    "main\auto-updater.js"
)

foreach ($file in $mainFiles) {
    $filePath = Join-Path $distRoot $file
    Test-FileExists $filePath "主进程输出" $file
}

# Preload 文件
$preloadFiles = @(
    "preload\app-preload.js",
    "preload\wa-preload.js"
)

foreach ($file in $preloadFiles) {
    $filePath = Join-Path $distRoot $file
    Test-FileExists $filePath "Preload输出" $file
}

# 共享模块
$sharedFiles = @(
    "shared\ipc-channels.js"
)

foreach ($file in $sharedFiles) {
    $filePath = Join-Path $distRoot $file
    Test-FileExists $filePath "共享模块输出" $file
}

# Source Map 文件检查（可选）
$sourceMapFiles = @(
    "main\app.js.map",
    "preload\wa-preload.js.map",
    "shared\ipc-channels.js.map"
)

foreach ($file in $sourceMapFiles) {
    $filePath = Join-Path $distRoot $file
    if (Test-Path $filePath) {
        Write-TestResult "SourceMap" $file "PASS"
    } else {
        Write-TestResult "SourceMap" $file "WARN" "source map 未生成"
    }
}

Write-Host ""

# ════════════════════════════════════════════════════════════
# 3. 检查 package.json 配置
# ════════════════════════════════════════════════════════════

Write-Host "[3/5] 检查 package.json 配置..." -ForegroundColor Cyan

$packageJsonPath = Join-Path $projectRoot "package.json"
Test-FileExists $packageJsonPath "package.json" "文件存在"

if (Test-Path $packageJsonPath) {
    $pkg = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

    # 基本字段
    Test-NotNullOrEmpty $pkg.name "package.json" "name 字段"
    Test-NotNullOrEmpty $pkg.version "package.json" "version 字段"
    Test-NotNullOrEmpty $pkg.description "package.json" "description 字段"
    Test-NotNullOrEmpty $pkg.main "package.json" "main 字段"
    Test-NotNullOrEmpty $pkg.author "package.json" "author 字段"
    Test-NotNullOrEmpty $pkg.license "package.json" "license 字段"

    # main 应指向 dist/main/app.js
    if ($pkg.main -eq "dist/main/app.js") {
        Write-TestResult "package.json" "main 指向正确" "PASS"
    } else {
        Write-TestResult "package.json" "main 指向正确" "FAIL" "期望 dist/main/app.js，实际 $($pkg.main)"
    }

    # 必需的 scripts
    $requiredScripts = @("dev", "build", "dist", "pack")
    foreach ($scriptName in $requiredScripts) {
        $scriptValue = $pkg.scripts.$scriptName
        Test-NotNullOrEmpty $scriptValue "package.json/scripts" $scriptName
    }

    # 必需的 dependencies
    $requiredDeps = @("axios", "electron-store", "electron-updater", "express")
    foreach ($depName in $requiredDeps) {
        $depValue = $pkg.dependencies.$depName
        Test-NotNullOrEmpty $depValue "package.json/dependencies" $depName
    }

    # 必需的 devDependencies
    $requiredDevDeps = @("electron", "electron-builder", "typescript", "concurrently", "cross-env", "wait-on")
    foreach ($depName in $requiredDevDeps) {
        $depValue = $pkg.devDependencies.$depName
        Test-NotNullOrEmpty $depValue "package.json/devDependencies" $depName
    }

    # 版本号格式
    if ($pkg.version -match '^\d+\.\d+\.\d+') {
        Write-TestResult "package.json" "version 格式 (semver)" "PASS"
    } else {
        Write-TestResult "package.json" "version 格式 (semver)" "FAIL" "版本号不符合 semver: $($pkg.version)"
    }

    # postinstall 脚本
    if ($pkg.scripts.postinstall -and $pkg.scripts.postinstall -match 'electron-builder') {
        Write-TestResult "package.json" "postinstall 脚本" "PASS"
    } else {
        Write-TestResult "package.json" "postinstall 脚本" "WARN" "未找到 electron-builder install-app-deps"
    }
}

Write-Host ""

# ════════════════════════════════════════════════════════════
# 4. 检查 electron-builder.yml 配置
# ════════════════════════════════════════════════════════════

Write-Host "[4/5] 检查 electron-builder.yml 配置..." -ForegroundColor Cyan

$builderYmlPath = Join-Path $projectRoot "electron-builder.yml"
Test-FileExists $builderYmlPath "electron-builder.yml" "文件存在"

if (Test-Path $builderYmlPath) {
    $ymlContent = Get-Content $builderYmlPath -Raw

    # appId
    if ($ymlContent -match 'appId:\s*(.+)') {
        $appId = $matches[1].Trim()
        Test-NotNullOrEmpty $appId "electron-builder" "appId"
        if ($appId -eq 'com.example.vaysen-crm') {
            Write-TestResult "electron-builder" "appId 值正确" "PASS"
        } else {
            Write-TestResult "electron-builder" "appId 值正确" "WARN" "appId: $appId"
        }
    } else {
        Write-TestResult "electron-builder" "appId" "FAIL" "未找到 appId 配置"
    }

    # productName
    if ($ymlContent -match 'productName:\s*(.+)') {
        Write-TestResult "electron-builder" "productName" "PASS"
    } else {
        Write-TestResult "electron-builder" "productName" "FAIL" "未找到 productName"
    }

    # directories.output
    if ($ymlContent -match 'output:\s*\.\./release') {
        Write-TestResult "electron-builder" "output 目录" "PASS"
    } else {
        Write-TestResult "electron-builder" "output 目录" "WARN" "output 非默认 ../release"
    }

    # directories.buildResources
    if ($ymlContent -match 'buildResources:\s*build') {
        Write-TestResult "electron-builder" "buildResources 目录" "PASS"
    } else {
        Write-TestResult "electron-builder" "buildResources 目录" "WARN" "buildResources 非默认 build"
    }

    # files 配置
    if ($ymlContent -match 'dist/\*\*/\*') {
        Write-TestResult "electron-builder/files" "dist 打包" "PASS"
    } else {
        Write-TestResult "electron-builder/files" "dist 打包" "FAIL" "未找到 dist/**/* 打包规则"
    }

    if ($ymlContent -match 'node_modules/\*\*/\*') {
        Write-TestResult "electron-builder/files" "node_modules 打包" "PASS"
    } else {
        Write-TestResult "electron-builder/files" "node_modules 打包" "FAIL" "未找到 node_modules 打包规则"
    }

    if ($ymlContent -match '!\*\*/\*\.\{ts,map\}') {
        Write-TestResult "electron-builder/files" "排除 ts/map 文件" "PASS"
    } else {
        Write-TestResult "electron-builder/files" "排除 ts/map 文件" "WARN" "未找到排除 .ts/.map 规则"
    }

    # extraResources
    if ($ymlContent -match 'frontend-out') {
        Write-TestResult "electron-builder" "extraResources 前端文件" "PASS"
    } else {
        Write-TestResult "electron-builder" "extraResources 前端文件" "FAIL" "未找到 frontend-out 资源配置"
    }

    # win 配置
    if ($ymlContent -match 'win:') {
        Write-TestResult "electron-builder/win" "win 配置存在" "PASS"
    } else {
        Write-TestResult "electron-builder/win" "win 配置存在" "FAIL" "未找到 win 配置"
    }

    if ($ymlContent -match 'icon:\s*build/icon\.ico') {
        Write-TestResult "electron-builder/win" "icon.ico 路径" "PASS"
    } else {
        Write-TestResult "electron-builder/win" "icon.ico 路径" "FAIL" "未找到 icon.ico 配置"
    }

    if ($ymlContent -match 'target:\s*\n\s*-?\s*target:\s*nsis') {
        Write-TestResult "electron-builder/win" "NSIS target" "PASS"
    } else {
        Write-TestResult "electron-builder/win" "NSIS target" "FAIL" "未找到 NSIS target 配置"
    }

    if ($ymlContent -match 'arch:' -and $ymlContent -match 'x64') {
        Write-TestResult "electron-builder/win" "arch x64" "PASS"
    } else {
        Write-TestResult "electron-builder/win" "arch x64" "WARN" "未明确指定 x64 架构"
    }

    # NSIS 配置
    if ($ymlContent -match 'nsis:') {
        Write-TestResult "electron-builder/nsis" "NSIS 配置存在" "PASS"

        if ($ymlContent -match 'oneClick:\s*false') {
            Write-TestResult "electron-builder/nsis" "非一键安装" "PASS"
        } else {
            Write-TestResult "electron-builder/nsis" "非一键安装" "WARN" "oneClick 可能非 false"
        }

        if ($ymlContent -match 'allowToChangeInstallationDirectory:\s*true') {
            Write-TestResult "electron-builder/nsis" "允许自定义安装路径" "PASS"
        } else {
            Write-TestResult "electron-builder/nsis" "允许自定义安装路径" "WARN" "未明确允许"
        }

        if ($ymlContent -match 'createDesktopShortcut:\s*true') {
            Write-TestResult "electron-builder/nsis" "创建桌面快捷方式" "PASS"
        } else {
            Write-TestResult "electron-builder/nsis" "创建桌面快捷方式" "WARN" "未明确配置"
        }
    } else {
        Write-TestResult "electron-builder/nsis" "NSIS 配置存在" "FAIL" "未找到 nsis 配置块"
    }

    # publish 配置
    if ($ymlContent -match 'publish:') {
        Write-TestResult "electron-builder/publish" "publish 配置存在" "PASS"

        if ($ymlContent -match 'provider:\s*generic') {
            Write-TestResult "electron-builder/publish" "generic provider" "PASS"
        } else {
            Write-TestResult "electron-builder/publish" "generic provider" "WARN" "provider 非 generic"
        }

        if ($ymlContent -match 'url:\s*http') {
            Write-TestResult "electron-builder/publish" "publish URL" "PASS"
        } else {
            Write-TestResult "electron-builder/publish" "publish URL" "WARN" "未找到有效的 publish URL"
        }
    } else {
        Write-TestResult "electron-builder/publish" "publish 配置存在" "WARN" "未配置自动更新发布"
    }
}

Write-Host ""

# ════════════════════════════════════════════════════════════
# 5. 检查 build 目录和图标文件
# ════════════════════════════════════════════════════════════

Write-Host "[5/5] 检查 build 目录和图标..." -ForegroundColor Cyan

$buildDir = Join-Path $projectRoot "build"

if (Test-Path $buildDir) {
    Write-TestResult "build目录" "build 目录存在" "PASS"

    # 检查图标文件
    $iconPng = Join-Path $buildDir "icon.png"
    Test-FileExists $iconPng "图标" "icon.png"

    $trayIcon = Join-Path $buildDir "tray-icon.png"
    Test-FileExists $trayIcon "图标" "tray-icon.png"

    $iconIco = Join-Path $buildDir "icon.ico"
    Test-FileExists $iconIco "图标" "icon.ico"

    # 检查 icon.png 文件大小（应大于 1KB）
    if (Test-Path $iconPng) {
        $iconSize = (Get-Item $iconPng).Length
        if ($iconSize -gt 1024) {
            Write-TestResult "图标" "icon.png 文件大小" "PASS" "$iconSize bytes"
        } else {
            Write-TestResult "图标" "icon.png 文件大小" "WARN" "文件过小: $iconSize bytes"
        }
    }
} else {
    Write-TestResult "build目录" "build 目录存在" "FAIL" "build 目录不存在，请先运行 node scripts/generate-icons.js"
}

Write-Host ""

# ════════════════════════════════════════════════════════════
# 生成报告
# ════════════════════════════════════════════════════════════

$endTime = Get-Date
$duration = $endTime - $startTime

$report = @()
$report += "=============================================="
$report += "  Electron 打包测试报告"
$report += "=============================================="
$report += "  项目路径: $projectRoot"
$report += "  开始时间: $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))"
$report += "  结束时间: $($endTime.ToString('yyyy-MM-dd HH:mm:ss'))"
$report += "  耗时:     $([math]::Round($duration.TotalSeconds, 2)) 秒"
$report += ""
$report += "----------------------------------------------"
$report += "  测试结果汇总"
$report += "----------------------------------------------"
$report += "  通过 (PASS): $script:passCount"
$report += "  失败 (FAIL): $script:failCount"
$report += "  警告 (WARN): $script:warnCount"
$report += "  总计:        $($script:passCount + $script:failCount + $script:warnCount)"
$report += ""
$report += "----------------------------------------------"
$report += "  详细结果"
$report += "----------------------------------------------"
$report += $script:testResults
$report += ""
$report += "=============================================="

$reportText = $report -join "`r`n"

# 写入报告文件
$reportDir = Join-Path $projectRoot "build"
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$reportPath = Join-Path $reportDir "build-test-report.txt"
Set-Content -Path $reportPath -Value $reportText -Encoding UTF8

# 输出到控制台
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  测试结果汇总" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  通过 (PASS): $script:passCount" -ForegroundColor Green
Write-Host "  失败 (FAIL): $script:failCount" -ForegroundColor $(if ($script:failCount -gt 0) { "Red" } else { "Gray" })
Write-Host "  警告 (WARN): $script:warnCount" -ForegroundColor Yellow
Write-Host "  总计:        $($script:passCount + $script:failCount + $script:warnCount)" -ForegroundColor Gray
Write-Host "  耗时:        $([math]::Round($duration.TotalSeconds, 2)) 秒" -ForegroundColor Gray
Write-Host ""
Write-Host "  报告文件: $reportPath" -ForegroundColor Gray
Write-Host ""

# 显示失败项
if ($script:failCount -gt 0) {
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  失败项:" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    $script:testResults | Where-Object { $_ -match "^\[FAIL\]" } | ForEach-Object {
        Write-Host "  $_" -ForegroundColor Red
    }
    Write-Host ""
}

# 显示警告项
if ($script:warnCount -gt 0) {
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "  警告项:" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    $script:testResults | Where-Object { $_ -match "^\[WARN\]" } | ForEach-Object {
        Write-Host "  $_" -ForegroundColor Yellow
    }
    Write-Host ""
}

# 退出码
if ($script:failCount -gt 0) {
    Write-Host "测试未通过！请修复上述 FAIL 项。" -ForegroundColor Red
    exit 1
} else {
    Write-Host "测试通过！（$script:warnCount 个警告）" -ForegroundColor Green
    exit 0
}
