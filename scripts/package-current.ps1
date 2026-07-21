$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Parent = Split-Path $Root -Parent
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$PackageDir = Join-Path $Parent "vaysen-ai-crm-runtime-$Stamp"
$ZipPath = "$PackageDir.zip"

Write-Host "Creating runtime package: $PackageDir" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null
robocopy $Root $PackageDir /E /XD node_modules .git ".next" "dist" "db" /XF "*.log" | Out-Null

Write-Host "Adding database backup..." -ForegroundColor Yellow
& "$PSScriptRoot\backup-db.ps1"
$latestBackup = Get-ChildItem -LiteralPath (Join-Path $Root "backups\db") -Filter "*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestBackup) {
  New-Item -ItemType Directory -Force -Path (Join-Path $PackageDir "backups\db") | Out-Null
  Copy-Item -LiteralPath $latestBackup.FullName -Destination (Join-Path $PackageDir "backups\db")
}

Compress-Archive -LiteralPath $PackageDir -DestinationPath $ZipPath -Force

Write-Host "Package created: $ZipPath" -ForegroundColor Green
Write-Host "On another computer: unzip, run scripts\install-local.ps1, then scripts\start-local.ps1." -ForegroundColor Cyan
