$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

Write-Host "== Vaysen AI CRM local install ==" -ForegroundColor Cyan

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found. $Hint"
  }
}

Require-Command "node" "Install Node.js 20+ or 24 LTS first."
Require-Command "npm" "Install Node.js first."
Require-Command "docker" "Install Docker Desktop first and start it."

Write-Host "[1/6] Installing npm dependencies..." -ForegroundColor Yellow
npm install

Write-Host "[2/6] Downloading Playwright Chromium..." -ForegroundColor Yellow
npx playwright install chromium

Write-Host "[3/6] Starting Postgres, Redis, and n8n..." -ForegroundColor Yellow
docker compose -f docker-compose.infra.local.yml up -d postgres redis n8n

Write-Host "[4/6] Waiting for Postgres..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  docker exec vaysen-ai-crm-postgres-local pg_isready -U vaysen-crm -d vaysen-crm_pilot *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { throw "Postgres is not ready." }

Write-Host "[5/6] Applying database migrations..." -ForegroundColor Yellow
Push-Location backend
npx prisma generate
npx prisma migrate deploy
Pop-Location

Write-Host "[6/6] Building backend and frontend..." -ForegroundColor Yellow
npm run build

Write-Host ""
Write-Host "Install complete. Run scripts\start-local.ps1 next." -ForegroundColor Green
