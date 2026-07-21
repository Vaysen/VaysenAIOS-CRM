$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$runtime = Resolve-Path (Join-Path $root '..\.runtime\windows-runtime')
$redisRuntime = Resolve-Path (Join-Path $root '..\.runtime\redis-memory-server')
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Ensure-SubstRuntime {
  $existing = cmd /c subst
  if ($existing -match '^T:\\:') {
    cmd /c 'subst T: /D' | Out-Null
  }
  cmd /c "subst T: `"$runtime`"" | Out-Null
}

function Test-Port($port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

Ensure-SubstRuntime

$env:PGPASSWORD = 'vaysen-crm_password'
if (-not (Test-Path 'T:\pgdata\PG_VERSION')) {
  Set-Content -LiteralPath 'T:\pgpass.txt' -Value 'vaysen-crm_password' -NoNewline -Encoding ASCII
  & 'T:\pgsql\bin\initdb.exe' -D 'T:\pgdata' -U vaysen-crm --pwfile='T:\pgpass.txt' -A scram-sha-256 --encoding=UTF8 --locale=C
}

if (-not (Test-Port 15432)) {
  & 'T:\pgsql\bin\pg_ctl.exe' -D 'T:\pgdata' -l 'T:\postgres.log' -o '-p 15432 -h 127.0.0.1' start
  Start-Sleep -Seconds 3
}

& 'T:\pgsql\bin\createdb.exe' -h 127.0.0.1 -p 15432 -U vaysen-crm vaysen-crm_pilot 2>$null

if (-not (Test-Port 16379)) {
  Start-Process -FilePath 'node' -ArgumentList 'start-redis-memory.js' -WorkingDirectory $redisRuntime -RedirectStandardOutput (Join-Path $redisRuntime 'redis-memory.log') -RedirectStandardError (Join-Path $redisRuntime 'redis-memory.err.log') -WindowStyle Hidden
  Start-Sleep -Seconds 8
}

Push-Location (Join-Path $root 'backend')
try {
  npx prisma migrate deploy
  npm run prisma:seed
} finally {
  Pop-Location
}

foreach ($port in 4000,4001) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Start-Process -FilePath 'node' -ArgumentList 'dist/src/main' -WorkingDirectory (Join-Path $root 'backend') -RedirectStandardOutput (Join-Path $logDir 'backend-node.log') -RedirectStandardError (Join-Path $logDir 'backend-node.err.log') -WindowStyle Hidden
Start-Sleep -Seconds 10
Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',"Set-Location '$root\frontend'; `$env:NODE_ENV='production'; npm run start -- -H 0.0.0.0 -p 4001 *> '$logDir\frontend-runtime.log'" -WindowStyle Hidden

Start-Sleep -Seconds 5
Get-NetTCPConnection -LocalPort 15432,16379,4000,4001 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess

Write-Host ''
Write-Host 'Frontend: http://localhost:4001/login' -ForegroundColor Green
Write-Host 'API docs: http://localhost:4000/api/docs' -ForegroundColor Green
