$ErrorActionPreference = 'Continue'

$ports = 4000,4001,16379
foreach ($port in $ports) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

if (Test-Path 'T:\pgsql\bin\pg_ctl.exe') {
  & 'T:\pgsql\bin\pg_ctl.exe' -D 'T:\pgdata' stop -m fast
}

cmd /c 'subst T: /D' 2>$null | Out-Null
Write-Host 'Windows local runtime stopped.' -ForegroundColor Green
