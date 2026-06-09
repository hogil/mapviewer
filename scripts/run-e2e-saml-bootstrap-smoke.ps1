param(
    [int]$Iterations = 10,
    [int]$PreferredPort = 18443,
    [switch]$AutoLogin,
    [switch]$Headless
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path (Join-Path $repoRoot ".codex-tmp"))) {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot ".codex-tmp") | Out-Null
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    if ($ProcessId -le 0 -or -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
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

function Get-E2EServerInfo {
    param(
        [string]$ReadyJsonPath,
        [int]$Port
    )

    if (Test-Path $ReadyJsonPath) {
        try {
            $info = Get-Content -Path $ReadyJsonPath -Raw | ConvertFrom-Json
            if ($info -and $info.pid) {
                return $info
            }
        } catch {
        }
    }

    try {
        $listenerLine = netstat -ano | Select-String -Pattern (":{0}\s+.*LISTENING\s+(\d+)" -f $Port) | Select-Object -First 1
        if ($listenerLine -and $listenerLine.Matches.Count -gt 0) {
            return [pscustomobject]@{
                pid = [int]$listenerLine.Matches[0].Groups[1].Value
                port = [int]$Port
            }
        }
    } catch {
    }

    return $null
}

$readyPath = Join-Path $repoRoot ".codex-tmp/e2e-server.last-ready.txt"
$readyJsonPath = Join-Path $repoRoot ".codex-tmp/e2e-server.last-ready.json"
$results = New-Object System.Collections.ArrayList
$failures = 0
$nextPreferredPort = $PreferredPort

$oldBootstrapDelay = $env:BOOTSTRAP_FULL_APP_DELAY_SECONDS
$oldHeadless = $env:E2E_HEADLESS
$oldLoginMax = $env:E2E_SAML_LOGIN_MAX_MS
$oldLoginTimeout = $env:E2E_SAML_LOGIN_TIMEOUT_MS
$oldAutoLogin = $env:E2E_AUTO_LOGIN
$oldExpectAutoLoginRedirect = $env:E2E_EXPECT_AUTO_LOGIN_REDIRECT

try {
    $env:BOOTSTRAP_FULL_APP_DELAY_SECONDS = "30"
    $env:E2E_HEADLESS = if ($Headless) { "1" } else { "0" }
    $env:E2E_SAML_LOGIN_MAX_MS = "5000"
    $env:E2E_SAML_LOGIN_TIMEOUT_MS = "8000"
    $env:E2E_AUTO_LOGIN = if ($AutoLogin) { "1" } else { "0" }
    $env:E2E_EXPECT_AUTO_LOGIN_REDIRECT = if ($AutoLogin) { "1" } else { "0" }

    for ($i = 1; $i -le $Iterations; $i++) {
        $serverInfo = $null
        $serverPid = 0
        $baseUrl = $null
        $sessionId = "{0}-saml-{1:00}-{2}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $i, ([guid]::NewGuid().ToString("N").Substring(0, 8))
        $outputDir = Join-Path $repoRoot (Join-Path ".codex-tmp/e2e-sessions" $sessionId)
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

        try {
            Remove-Item $readyPath, $readyJsonPath -Force -ErrorAction SilentlyContinue
            Write-Host ("SAML_BOOTSTRAP iteration={0}/{1} start-server preferred={2}" -f $i, $Iterations, $nextPreferredPort)
            $ready = & (Join-Path $PSScriptRoot "start-e2e-server.ps1") -PreferredPort $nextPreferredPort -OwnerPid $PID
            if ([string]::IsNullOrWhiteSpace($ready) -and (Test-Path $readyPath)) {
                $ready = (Get-Content -Path $readyPath -Raw -ErrorAction SilentlyContinue).Trim()
            }
            if ($ready -notmatch '^READY:(\d+)$') {
                throw "E2E server bootstrap failed: $ready"
            }

            $port = [int]$Matches[1]
            $nextPreferredPort = $port + 1
            $serverInfo = Get-E2EServerInfo -ReadyJsonPath $readyJsonPath -Port $port
            $serverPid = if ($serverInfo -and $serverInfo.pid) { [int]$serverInfo.pid } else { 0 }
            $baseUrl = "https://127.0.0.1:$port"

            $env:E2E_BASE_URL = $baseUrl
            $env:E2E_SESSION_ID = $sessionId
            $env:E2E_OUTPUT_DIR = $outputDir

            Write-Host ("SAML_BOOTSTRAP iteration={0}/{1} run-browser base={2} pid={3}" -f $i, $Iterations, $baseUrl, $serverPid)
            & node scripts/e2e_saml_bootstrap_smoke.js
            $exitCode = $LASTEXITCODE
            $status = if ($exitCode -eq 0) { "PASS" } else { "FAIL" }
            if ($exitCode -ne 0) {
                $failures += 1
            }

            [void]$results.Add([pscustomobject]@{
                iteration = $i
                status = $status
                exitCode = $exitCode
                baseUrl = $baseUrl
                serverPid = $serverPid
                sessionId = $sessionId
                outputDir = $outputDir
            })
            Write-Host ("SAML_BOOTSTRAP iteration={0}/{1} status={2}" -f $i, $Iterations, $status)
        } catch {
            $failures += 1
            [void]$results.Add([pscustomobject]@{
                iteration = $i
                status = "FAIL"
                exitCode = 2
                baseUrl = $baseUrl
                serverPid = $serverPid
                sessionId = $sessionId
                outputDir = $outputDir
                error = $_.Exception.Message
            })
            Write-Host ("SAML_BOOTSTRAP iteration={0}/{1} status=FAIL error={2}" -f $i, $Iterations, $_.Exception.Message)
        } finally {
            if ($serverPid -gt 0) {
                Stop-ProcessTree -ProcessId $serverPid
            }
        }
    }
} finally {
    $env:BOOTSTRAP_FULL_APP_DELAY_SECONDS = $oldBootstrapDelay
    $env:E2E_HEADLESS = $oldHeadless
    $env:E2E_SAML_LOGIN_MAX_MS = $oldLoginMax
    $env:E2E_SAML_LOGIN_TIMEOUT_MS = $oldLoginTimeout
    $env:E2E_AUTO_LOGIN = $oldAutoLogin
    $env:E2E_EXPECT_AUTO_LOGIN_REDIRECT = $oldExpectAutoLoginRedirect
}

$summary = [pscustomobject]@{
    status = if ($failures -eq 0) { "PASS" } else { "FAIL" }
    iterations = $Iterations
    failures = $failures
    results = $results
}

$summaryPath = Join-Path $repoRoot (".codex-tmp/e2e-saml-bootstrap-summary-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding utf8
Write-Host ("SAML_BOOTSTRAP_SUMMARY {0}" -f ($summary | ConvertTo-Json -Compress -Depth 6))
Write-Host ("SAML_BOOTSTRAP_SUMMARY_PATH {0}" -f $summaryPath)

if ($failures -gt 0) {
    exit 2
}
exit 0
