$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'backend-start.transcript.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $backend

$env:NODE_ENV = 'production'

Start-Transcript -Path $logFile -Append | Out-Null
try {
  npm.cmd run start:prod
}
finally {
  Stop-Transcript | Out-Null
}
