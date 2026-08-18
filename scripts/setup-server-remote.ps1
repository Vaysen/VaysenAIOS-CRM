param(
  [string]$ServerHost = "192.168.50.20",
  [string]$ServerUser = "git",
  [string]$RemoteName = "server",
  [string]$BareRepoPath = "/srv/git/vaysen-ai-crm.git"
)

$ErrorActionPreference = "Stop"

Write-Host "Adding git remote '$RemoteName' -> $ServerUser@$ServerHost:$BareRepoPath"

$existing = git remote get-url $RemoteName 2>$null
if ($LASTEXITCODE -eq 0 -and $existing) {
  git remote set-url $RemoteName "$ServerUser@$ServerHost:$BareRepoPath"
} else {
  git remote add $RemoteName "$ServerUser@$ServerHost:$BareRepoPath"
}

Write-Host "Remote configured. Test with:"
Write-Host "  git push $RemoteName HEAD:main"
Write-Host ""
Write-Host "Before pushing, create the bare repo and install scripts/server-post-receive-hook.sh on $ServerHost."
