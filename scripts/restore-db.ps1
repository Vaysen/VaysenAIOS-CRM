param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $BackupFile)) {
  throw "Backup file not found: $BackupFile"
}

$FullPath = Resolve-Path -LiteralPath $BackupFile
Write-Host "Restoring database from: $FullPath" -ForegroundColor Yellow
Write-Host "This will replace current database data." -ForegroundColor Yellow

$confirm = Read-Host "Type RESTORE to continue"
if ($confirm -ne "RESTORE") {
  Write-Host "Cancelled." -ForegroundColor Yellow
  exit 0
}

$containerFile = "/tmp/vaysen-crm-restore.dump"
docker cp $FullPath "vaysen-ai-crm-postgres-local:$containerFile"
docker exec vaysen-ai-crm-postgres-local pg_restore -U vaysen-crm -d vaysen-crm_pilot --clean --if-exists $containerFile
docker exec vaysen-ai-crm-postgres-local rm -f $containerFile | Out-Null

Write-Host "Restore complete." -ForegroundColor Green
