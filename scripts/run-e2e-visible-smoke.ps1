param(
    [int]$HoldSeconds = 10
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$ready = powershell -ExecutionPolicy Bypass -File scripts/start-e2e-server.ps1 8443
if ($ready -notmatch '^READY:(\d+)$') {
    Write-Error "E2E server bootstrap failed: $ready"
    exit 1
}

$port = $Matches[1]
$baseUrl = "https://127.0.0.1:$port"
$sessionId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$outputDir = Join-Path $repoRoot (Join-Path ".codex-tmp/e2e-sessions" $sessionId)
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$env:E2E_BASE_URL = $baseUrl
$env:E2E_SESSION_ID = $sessionId
$env:E2E_OUTPUT_DIR = $outputDir
$env:E2E_HEADLESS = "0"
$env:E2E_SMOKE_HOLD_MS = [string]($HoldSeconds * 1000)

Write-Host "RUN scripts/e2e_visible_smoke.js ($baseUrl, session=$sessionId, hold=${HoldSeconds}s)"
& node scripts/e2e_visible_smoke.js
$exitCode = $LASTEXITCODE

Write-Host "SESSION:$sessionId"
Write-Host "BASE_URL:$baseUrl"
Write-Host "OUTPUT_DIR:$outputDir"
exit $exitCode
