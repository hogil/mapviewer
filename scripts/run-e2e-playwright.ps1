param(
    [ValidateSet("all", "1", "2", "3")]
    [string]$Chunk = "all",
    [switch]$Headless
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "BOOTSTRAP scripts/start-e2e-server.ps1"
if (-not (Test-Path (Join-Path $repoRoot ".codex-tmp"))) {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot ".codex-tmp") | Out-Null
}
$readyPath = Join-Path $repoRoot ".codex-tmp/e2e-server.last-ready.txt"
Remove-Item $readyPath -Force -ErrorAction SilentlyContinue
$ready = & (Join-Path $PSScriptRoot "start-e2e-server.ps1") 8443
if ([string]::IsNullOrWhiteSpace($ready) -and (Test-Path $readyPath)) {
    $ready = (Get-Content -Path $readyPath -Raw -ErrorAction SilentlyContinue).Trim()
}
if ($ready -notmatch '^READY:(\d+)$') {
    Write-Error "E2E server bootstrap failed: $ready"
    exit 1
}

$port = $Matches[1]
$baseUrl = "https://127.0.0.1:$port"
$sessionId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$outputDir = Join-Path $repoRoot (Join-Path ".codex-tmp/e2e-sessions" $sessionId)
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$scripts = switch ($Chunk) {
    "1" { @("scripts/e2e_chunk1.js") }
    "2" { @("scripts/e2e_chunk2.js") }
    "3" { @("scripts/e2e_chunk3.js") }
    default { @("scripts/e2e_chunk1.js", "scripts/e2e_chunk2.js", "scripts/e2e_chunk3.js") }
}

$env:E2E_BASE_URL = $baseUrl
$env:E2E_SESSION_ID = $sessionId
$env:E2E_OUTPUT_DIR = $outputDir
$env:E2E_HEADLESS = if ($Headless) { "1" } else { "0" }

function Stop-ProcessTree {
    param([int]$Pid)

    try {
        & taskkill.exe /PID $Pid /T /F | Out-Null
    } catch {
        try {
            Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

function Get-NewTailLines {
    param(
        [string]$Path,
        [int]$Skip
    )

    if (-not (Test-Path $Path)) {
        return @{ Lines = @(); Count = $Skip }
    }

    $lines = @(Get-Content -Path $Path)
    $count = $lines.Count
    if ($count -le $Skip) {
        return @{ Lines = @(); Count = $count }
    }

    return @{
        Lines = @($lines[$Skip..($count - 1)])
        Count = $count
    }
}

function Wait-ForSearchReady {
    param(
        [string]$BaseUrl,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $statusRaw = & curl.exe -s -k --max-time 10 "$BaseUrl/api/search-ready"
            $status = if (-not [string]::IsNullOrWhiteSpace($statusRaw)) {
                $statusRaw | ConvertFrom-Json
            } else {
                $null
            }
            if ($status.ready) {
                $raw = & curl.exe -s -k --max-time 10 "$BaseUrl/api/search?q=abc123&limit=1"
                $response = if (-not [string]::IsNullOrWhiteSpace($raw)) {
                    $raw | ConvertFrom-Json
                } else {
                    $null
                }
                if ($response.success -and $response.total -ge 1) {
                    Write-Host "SEARCH_READY backend=$($status.backend) total=$($response.total)"
                    return $true
                }
            }
        } catch {
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

$overallExit = 0
$maxChunkSeconds = 420
foreach ($script in $scripts) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($script)
    $stdoutPath = Join-Path $outputDir "$name.out.log"
    $stderrPath = Join-Path $outputDir "$name.err.log"
    $progressPath = Join-Path $outputDir "$name.progress.log"
    Remove-Item $stdoutPath, $stderrPath, $progressPath -Force -ErrorAction SilentlyContinue

    if ($name -eq "e2e_chunk1") {
        Write-Host "WARMUP search cache"
        if (-not (Wait-ForSearchReady -BaseUrl $baseUrl)) {
            Write-Error "Search warmup failed for $baseUrl"
            exit 1
        }
    }

    Write-Host "RUN $script ($baseUrl, session=$sessionId, headless=$($env:E2E_HEADLESS))"
    $proc = Start-Process node `
        -ArgumentList $script `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $progressLineCount = 0
    $chunkStartedAt = Get-Date
    $doneSeen = $false
    $doneGraceDeadline = $null
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 2
        $progressUpdate = Get-NewTailLines -Path $progressPath -Skip $progressLineCount
        $progressLineCount = $progressUpdate.Count
        foreach ($line in $progressUpdate.Lines) {
            if ($line) {
                Write-Host "[$name] $line"
                if ($line -match '^\[DONE\]') {
                    $doneSeen = $true
                    if (-not $doneGraceDeadline) {
                        $doneGraceDeadline = (Get-Date).AddSeconds(8)
                    }
                }
            }
        }
        if ($doneSeen -and $doneGraceDeadline -and (Get-Date) -ge $doneGraceDeadline) {
            Write-Host "[$name] forcing process tree shutdown after DONE"
            Stop-ProcessTree -Pid $proc.Id
            break
        }
        if (((Get-Date) - $chunkStartedAt).TotalSeconds -ge $maxChunkSeconds) {
            Write-Host "[$name] chunk timeout ${maxChunkSeconds}s"
            Stop-ProcessTree -Pid $proc.Id
            break
        }
        $proc.Refresh()
    }

    $progressUpdate = Get-NewTailLines -Path $progressPath -Skip $progressLineCount
    foreach ($line in $progressUpdate.Lines) {
        if ($line) {
            Write-Host "[$name] $line"
            if ($line -match '^\[DONE\]') {
                $doneSeen = $true
            }
        }
    }

    $progressText = if (Test-Path $progressPath) { Get-Content -Path $progressPath -Raw -ErrorAction SilentlyContinue } else { "" }
    $stdoutText = if (Test-Path $stdoutPath) { Get-Content -Path $stdoutPath -Raw -ErrorAction SilentlyContinue } else { "" }

    $exitCode = if ($proc.HasExited) { $proc.ExitCode } else { 1 }
    if ($progressText -match '\[FAIL\]' -or $stdoutText -match '"status"\s*:\s*"FAIL"') {
        $exitCode = 2
    } elseif (-not $proc.HasExited -and $doneSeen) {
        $exitCode = 0
    }
    if ($exitCode -ne 0 -and (Test-Path $stderrPath)) {
        $stderrTail = Get-Content -Path $stderrPath -Tail 20 -ErrorAction SilentlyContinue
        foreach ($line in $stderrTail) {
            if ($line) {
                Write-Host "[$name][stderr] $line"
            }
        }
    }
    if ($exitCode -ne 0 -and $overallExit -eq 0) {
        $overallExit = $exitCode
    }
    Start-Sleep -Seconds 2
}

Write-Host "SESSION:$sessionId"
Write-Host "BASE_URL:$baseUrl"
Write-Host "OUTPUT_DIR:$outputDir"
exit $overallExit
