$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$ElectronDir = Join-Path $Root "electron"
$ElectronExe = Join-Path $ElectronDir "node_modules\electron\dist\electron.exe"

$logDir = Join-Path $env:TEMP "vaysen-ai-crm-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-Port {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  return $null -ne $connection
}

function Test-HttpOk {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Start-NodeService {
  param(
    [string]$WorkingDirectory,
    [string]$Command,
    [string]$LogName
  )
  $outLog = Join-Path $logDir "$LogName-out.log"
  $errLog = Join-Path $logDir "$LogName-err.log"
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", $Command `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden
}

function Stop-ProjectFrontend {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -match [regex]::Escape($Root) -and
      ($_.CommandLine -match "next" -or $_.CommandLine -match "start-server")
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Port 4000)) {
  Start-NodeService `
    -WorkingDirectory $BackendDir `
    -Command "npm run start:dev" `
    -LogName "backend-shortcut"
}

for ($i = 0; $i -lt 45; $i++) {
  if (Test-Port 4000) { break }
  Start-Sleep -Seconds 1
}

$frontendHealthy = (Test-Port 3000) -and (Test-HttpOk "http://localhost:3000/login")
if (-not $frontendHealthy) {
  Stop-ProjectFrontend
  Start-Sleep -Seconds 2
  Start-NodeService `
    -WorkingDirectory $FrontendDir `
    -Command "npm run dev -- --port 3000" `
    -LogName "frontend-shortcut"
}

for ($i = 0; $i -lt 60; $i++) {
  if ((Test-Port 3000) -and (Test-HttpOk "http://localhost:3000/login")) { break }
  Start-Sleep -Seconds 1
}

if (-not (Test-Path -LiteralPath $ElectronExe)) {
  throw "Electron executable not found: $ElectronExe"
}

$env:NODE_ENV = "development"
$env:FRONTEND_URL = "http://localhost:3000"
$env:API_BASE_URL = "http://localhost:4000/api"

Start-Process -FilePath $ElectronExe `
  -ArgumentList "." `
  -WorkingDirectory $ElectronDir `
  -WindowStyle Normal
