$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$PortBackend = 4000
$PortFrontend = 4001

function Get-LanIp {
  $preferred = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -like "192.168.*" -and
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*"
    } |
    Sort-Object InterfaceMetric |
    Select-Object -First 1 -ExpandProperty IPAddress
  if ($preferred) { return $preferred }

  $ip = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Sort-Object InterfaceMetric |
    Select-Object -First 1 -ExpandProperty IPAddress
  if (-not $ip) { $ip = "127.0.0.1" }
  return $ip
}

function Stop-Port($Port) {
  $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    if ($connection.OwningProcess -and $connection.OwningProcess -ne 0) {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-BackendWorkers {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -like "node.exe" -and
      (
        $_.CommandLine -like "*dist/src/main*" -or
        $_.CommandLine -like "*dist/src/worker*" -or
        $_.CommandLine -like "*start:prod*" -or
        $_.CommandLine -like "*start:worker*"
      )
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$LanIp = Get-LanIp
Write-Host "== Vaysen local start ==" -ForegroundColor Cyan
Write-Host "Detected LAN IP: $LanIp" -ForegroundColor Cyan

Write-Host "[1/5] Updating local env files..." -ForegroundColor Yellow
$backendEnvPath = Join-Path $Root "backend\.env"
$frontendEnvPath = Join-Path $Root "frontend\.env.local"

$backendEnv = Get-Content $backendEnvPath -Raw
$backendEnv = $backendEnv -replace "FRONTEND_URL=.*", "FRONTEND_URL=http://$LanIp`:$PortFrontend"
$backendEnv = $backendEnv -replace "API_BASE_URL=.*", "API_BASE_URL=http://$LanIp`:$PortBackend"
$backendEnv = $backendEnv -replace "CORS_ORIGIN=.*", "CORS_ORIGIN=http://localhost:$PortFrontend,http://127.0.0.1:$PortFrontend,http://$LanIp`:$PortFrontend"
Set-Content -LiteralPath $backendEnvPath -Value $backendEnv -Encoding UTF8

$frontendEnv = "NEXT_PUBLIC_API_URL=http://$LanIp`:$PortBackend/api`nNEXT_PUBLIC_APP_NAME=Vaysen 外贸系统`n"
Set-Content -LiteralPath $frontendEnvPath -Value $frontendEnv -Encoding UTF8

Write-Host "[2/5] Starting Docker infrastructure..." -ForegroundColor Yellow
docker compose -f docker-compose.infra.local.yml up -d postgres redis searxng
if (Get-NetTCPConnection -LocalPort 5678 -ErrorAction SilentlyContinue) {
  Write-Host "Port 5678 is already in use; keeping the existing n8n service." -ForegroundColor Yellow
} else {
  docker compose -f docker-compose.infra.local.yml up -d n8n
}

Write-Host "[3/5] Applying database migrations..." -ForegroundColor Yellow
Push-Location backend
$migrationOk = $true
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) {
  $migrationOk = $false
  Write-Host "Prisma migrate deploy failed; applying idempotent schema patch instead..." -ForegroundColor Yellow
  npx prisma db execute --schema prisma\schema.prisma --file prisma\migrations\20260605090000_email_quality_and_social_fields\migration.sql
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "Database migration failed"
  }
}
Pop-Location

Write-Host "[4/5] Restarting app ports..." -ForegroundColor Yellow
Stop-BackendWorkers
Stop-Port $PortBackend
Stop-Port $PortFrontend

Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\backend'; npm run start:prod" -WindowStyle Hidden
Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\backend'; npm run start:worker:email-compose" -WindowStyle Hidden
Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\backend'; npm run start:worker:email-validate" -WindowStyle Hidden
Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\backend'; npm run start:worker:email-send" -WindowStyle Hidden
Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\backend'; npm run start:worker:prospect-search" -WindowStyle Hidden
Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\backend'; npm run start:worker:deep-research" -WindowStyle Hidden
Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\backend'; npm run start:worker:maintenance" -WindowStyle Hidden
Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Root\frontend'; `$env:HOSTNAME='0.0.0.0'; `$env:PORT='$PortFrontend'; npm run start -- -H 0.0.0.0 -p $PortFrontend" -WindowStyle Hidden

Write-Host "[5/5] Health check..." -ForegroundColor Yellow
Start-Sleep -Seconds 10
& "$PSScriptRoot\health-check.ps1"

Write-Host ""
Write-Host "Open on this computer: http://localhost:$PortFrontend/login" -ForegroundColor Green
Write-Host "Open on LAN:           http://$LanIp`:$PortFrontend/login" -ForegroundColor Green
Write-Host "n8n:                   http://$LanIp`:5678" -ForegroundColor Green
