$ErrorActionPreference = "Continue"

$checks = @(
  @{ Name = "Backend"; Url = "http://127.0.0.1:4000/api/docs" },
  @{ Name = "Frontend"; Url = "http://127.0.0.1:4001/login" },
  @{ Name = "n8n"; Url = "http://127.0.0.1:5678" },
  @{ Name = "Reacher"; Url = "http://127.0.0.1:18080" }
)

Write-Host "== Vaysen AI CRM health check ==" -ForegroundColor Cyan

foreach ($check in $checks) {
  try {
    $res = Invoke-WebRequest -Uri $check.Url -UseBasicParsing -TimeoutSec 8
    Write-Host ("{0,-10} OK     {1}" -f $check.Name, $check.Url) -ForegroundColor Green
  } catch {
    if ($check.Name -eq "Reacher") {
      Write-Host ("{0,-10} SKIP   {1} (optional email SMTP verifier is not running)" -f $check.Name, $check.Url) -ForegroundColor Yellow
    } else {
      Write-Host ("{0,-10} FAIL   {1} - {2}" -f $check.Name, $check.Url, $_.Exception.Message) -ForegroundColor Red
    }
  }
}

Write-Host ""
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}" |
  Select-String -Pattern "vaysen-ai-crm|n8n|reacher|postgres|redis"
