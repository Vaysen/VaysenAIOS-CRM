$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$logDir = Join-Path $root 'logs'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$workers = @(
  @{ Name = 'email-compose'; Script = 'start:worker:email-compose' },
  @{ Name = 'email-validate'; Script = 'start:worker:email-validate' },
  @{ Name = 'email-send'; Script = 'start:worker:email-send' },
  @{ Name = 'prospect-search'; Script = 'start:worker:prospect-search' },
  @{ Name = 'deep-research'; Script = 'start:worker:deep-research' },
  @{ Name = 'maintenance'; Script = 'start:worker:maintenance' }
)

foreach ($worker in $workers) {
  $out = Join-Path $logDir ("worker-" + $worker.Name + ".out.log")
  $err = Join-Path $logDir ("worker-" + $worker.Name + ".err.log")
  Start-Process -FilePath 'npm.cmd' `
    -ArgumentList @('run', $worker.Script) `
    -WorkingDirectory $backend `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err | Out-Null
}

Write-Host "Started $($workers.Count) Vaysen AI CRM workers."
