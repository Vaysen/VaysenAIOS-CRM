$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackupDir = Join-Path $Root "backups\db"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $BackupDir "vaysen-crm-$stamp.dump"

Write-Host "Creating database backup: $backup" -ForegroundColor Cyan
$containerFile = "/tmp/vaysen-crm-$stamp.dump"
docker exec vaysen-ai-crm-postgres-local pg_dump -U vaysen-crm -d vaysen-crm_pilot -Fc -f $containerFile
docker cp "vaysen-ai-crm-postgres-local:$containerFile" $backup
docker exec vaysen-ai-crm-postgres-local rm -f $containerFile | Out-Null

Write-Host "Backup complete: $backup" -ForegroundColor Green
