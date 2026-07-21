$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $root 'frontend'
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'frontend-start.transcript.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $frontend

$env:NODE_ENV = 'production'

Start-Transcript -Path $logFile -Append | Out-Null
try {
  npm.cmd run start
}
finally {
  Stop-Transcript | Out-Null
}
