param(
    [int]$HoldSeconds = 10
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path (Join-Path $repoRoot ".codex-tmp"))) {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot ".codex-tmp") | Out-Null
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        return
    }

    try {
        & taskkill.exe /PID $ProcessId /T /F 1>$null 2>$null
    } catch {
    }

    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
        try {
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

trap {
    if ($script:E2EServerPid) {
        Stop-ProcessTree -ProcessId ([int]$script:E2EServerPid)
        & (Join-Path $PSScriptRoot "cleanup-e2e.ps1") -Quiet
    }
    Write-Error $_
    exit 1
}

Get-ChildItem -Path (Join-Path $repoRoot ".codex-tmp") -Filter "e2e-server-*.pid" -File -ErrorAction SilentlyContinue | ForEach-Object {
    $pidText = (Get-Content -Path $_.FullName -Raw -ErrorAction SilentlyContinue).Trim()
    $pidValue = 0
    if ([int]::TryParse($pidText, [ref]$pidValue) -and $pidValue -gt 0) {
        $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "CLEAN stale E2E server pid=$pidValue"
            Stop-ProcessTree -ProcessId $pidValue
        }
    }
    Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
}

$readyJsonPath = Join-Path $repoRoot ".codex-tmp/e2e-server.last-ready.json"
$ready = powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-e2e-server.ps1 8443
if ($ready -notmatch '^READY:(\d+)$') {
    Write-Error "E2E server bootstrap failed: $ready"
    exit 1
}

$port = $Matches[1]
$serverInfo = $null
$script:E2EServerPid = $null
if (Test-Path $readyJsonPath) {
    try {
        $serverInfo = Get-Content -Path $readyJsonPath -Raw | ConvertFrom-Json
        if ($serverInfo -and $serverInfo.pid) {
            $script:E2EServerPid = [int]$serverInfo.pid
        }
    } catch {
        $serverInfo = $null
    }
}
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
if ($serverInfo -and $serverInfo.pid) {
    Stop-ProcessTree -ProcessId ([int]$serverInfo.pid)
}
exit $exitCode
