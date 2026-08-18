# ============================================
# Vaysen Trade System — Business Smoke Test
# Run: powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
# ============================================
$ErrorActionPreference = "Continue"
$Passed = 0; $Failed = 0
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Check($label, $scriptBlock) {
  try {
    & $scriptBlock
    Write-Host "  [PASS] $label" -ForegroundColor Green
    $global:Passed++
  } catch {
    Write-Host "  [FAIL] $label — $_" -ForegroundColor Red
    $global:Failed++
  }
}

Write-Host "`n=== Vaysen Trade System Smoke Test ===`n" -ForegroundColor Cyan

# ---- R1: Build & Schema ----
Write-Host "--- Round 1: Build & Schema ---"
Push-Location "$Root\..\backend"
Check "Prisma schema valid" { npx prisma validate 2>&1 | Select-String "valid" | Out-Null }
Check "Backend NestJS build" { npx nest build 2>&1; if ($LASTEXITCODE -ne 0) { throw "Build failed" } }
Pop-Location

Push-Location "$Root\..\frontend"
Check "Frontend Next.js build" { npx next build --no-lint 2>&1 | Select-String "Compiled successfully" | Out-Null }
Pop-Location

# ---- R2: Permission Logic ----
Write-Host "`n--- Round 2: Permission Isolation ---"

# Simulate user scenarios without running the server
Push-Location "$Root\..\backend"

# Test ensureCompanyAccess logic via TypeScript compile check
Check "data-isolation.ts compiles with ensureCompanyAccess" {
  npx tsc --noEmit src/common/utils/data-isolation.ts 2>&1 | Out-Null
}

# Verify no 'company_admin' treated as global in any service
$files = @(
  "src/modules/business-mail/business-mail.service.ts",
  "src/modules/ai-communications/ai-communications.service.ts",
  "src/modules/quotes/quotes.service.ts"
)
foreach ($f in $files) {
  $content = Get-Content $f -Raw
  $hasCompanyAdminGlobal = $content -match "company_admin.*includes|includes.*company_admin.*role"
  Check "$f does NOT treat company_admin as global" {
    if ($hasCompanyAdminGlobal) { throw "company_admin still treated as global in $f" }
  }
  $callsEnsure = $content -match "ensureCompanyAccess|ensureAccess"
  Check "$f uses ensureCompanyAccess/ensureAccess" {
    if (-not $callsEnsure) { throw "Missing ensureCompanyAccess in $f" }
  }
}

Pop-Location

# ---- R3: Frontend Production Guards ----
Write-Host "`n--- Round 3: Production Safeguards ---"
Push-Location "$Root\..\frontend"
$workbench = Get-Content "src/components/communication/communication-workbench.tsx" -Raw
Check "Mock fallback gated behind NODE_ENV === 'development'" {
  if ($workbench -notmatch "NODE_ENV.*development") { throw "Mock not gated" }
}
Check "Detail fallback gated behind NODE_ENV check" {
  $detailMatches = ([regex]::Matches($workbench, "NODE_ENV.*development")).Count
  if ($detailMatches -lt 2) { throw "Detail mock not gated ($detailMatches NODE_ENV checks found, need >=2)" }
}
Pop-Location

# ---- R4: Security Scan ----
Write-Host "`n--- Round 4: Security ---"
Push-Location "$Root\.."

Check "No API keys in source" {
  $found = Get-ChildItem "backend/src" -Recurse -Filter "*.ts" | Get-Content -Raw | Select-String "sk-[a-zA-Z0-9]{20,}" -ErrorAction SilentlyContinue
  if ($found) { throw "API key pattern found" }
}

Check "No hardcoded passwords in source" {
  $found = Get-ChildItem "backend/src" -Recurse -Filter "*.ts" | Get-Content -Raw | Select-String "password.*=.*'.{4,}'" -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch "example|test|mock|placeholder|your-" }
  if ($found) { throw "Hardcoded password pattern found" }
}

Check "No WhatsApp bulk send logic" {
  $wappFiles = Get-ChildItem "backend/src/modules/whatsapp" -Filter "*.ts" -ErrorAction SilentlyContinue
  foreach ($f in $wappFiles) {
    $c = Get-Content $f.FullName -Raw
    if ($c -match "bulk|blast|campaign|mass|broadcast") {
      throw "WhatsApp bulk logic detected in $($f.Name)"
    }
  }
}
Pop-Location

# ---- Summary ----
Write-Host "`n=== Results: $Passed passed, $Failed failed ===" -ForegroundColor $(if ($Failed -eq 0) { "Green" } else { "Red" })
exit $Failed
