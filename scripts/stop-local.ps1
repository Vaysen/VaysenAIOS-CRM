$ErrorActionPreference = "Continue"

foreach ($port in 4000, 4001) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object {
      if ($_.OwningProcess) {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
}

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

Write-Host "Stopped Vaysen backend/frontend processes." -ForegroundColor Green
Write-Host "Docker services are still running. To stop them too:" -ForegroundColor Yellow
Write-Host "docker compose -f docker-compose.infra.local.yml down" -ForegroundColor Cyan
