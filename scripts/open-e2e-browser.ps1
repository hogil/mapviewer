param(
    [int]$PreferredPort = 8443
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

trap {
    $message = if ($_.Exception) { $_.Exception.Message } else { [string]$_ }
    $errorPath = Join-Path $repoRoot ".codex-tmp/e2e-open.last-error.txt"
    try {
        Set-Content -Path $errorPath -Value $message -Encoding utf8
    } catch {
    }
    Write-Error $message
    exit 1
}

if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
    Write-Error "npx.cmd not found. Install Node.js/npm before opening Playwright."
    exit 1
}

if (-not (Test-Path (Join-Path $repoRoot ".codex-tmp"))) {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot ".codex-tmp") | Out-Null
}

$readyJsonPath = Join-Path $repoRoot ".codex-tmp/e2e-server.last-ready.json"
$ready = & (Join-Path $PSScriptRoot "start-e2e-server.ps1") $PreferredPort
if ($ready -notmatch '^READY:(\d+)$') {
    Write-Error "E2E server bootstrap failed: $ready"
    exit 1
}

$port = [int]$Matches[1]
$baseUrl = "https://127.0.0.1:$port"
$serverInfo = $null
if (Test-Path $readyJsonPath) {
    try {
        $serverInfo = Get-Content -Path $readyJsonPath -Raw | ConvertFrom-Json
    } catch {
        $serverInfo = $null
    }
}

$health = & curl.exe -s -k --max-time 5 "$baseUrl/api/config"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($health)) {
    Write-Warning "Server is listening but /api/config did not answer quickly: $baseUrl"
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class E2EWin32Window {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Maximize-PlaywrightWindow {
    param(
        [datetime]$StartedAfter,
        [int]$TimeoutSeconds = 25
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $windowCandidates = @()
        foreach ($proc in @(Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
            try {
                if ($proc.MainWindowHandle -eq 0) {
                    continue
                }
                if ($proc.StartTime -lt $StartedAfter.AddSeconds(-3)) {
                    continue
                }
                if ($proc.MainWindowTitle -notmatch "Wafer Map Viewer|Chrome for Testing|Chromium") {
                    continue
                }
                $windowCandidates += $proc
            } catch {
            }
        }

        if ($windowCandidates.Count -gt 0) {
            $target = $windowCandidates | Sort-Object StartTime -Descending | Select-Object -First 1
            $handle = [IntPtr]$target.MainWindowHandle
            if ($handle -eq [IntPtr]::Zero) {
                Start-Sleep -Milliseconds 500
                continue
            }
            [void][E2EWin32Window]::ShowWindowAsync($handle, 3)
            [void][E2EWin32Window]::SetForegroundWindow($handle)
            return $target.Id
        }

        Start-Sleep -Milliseconds 500
    }

    return $null
}

$openUrl = "$baseUrl/?playwright-open=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$userDataDir = Join-Path $repoRoot (".codex-tmp/playwright-open-{0}-{1}" -f $port, ([guid]::NewGuid().ToString("N").Substring(0, 8)))
$startedAt = Get-Date
$args = @(
    "playwright",
    "open",
    "--browser=chromium",
    "--ignore-https-errors",
    "--lang=ko-KR",
    "--timeout=60000",
    "--viewport-size=1920,1080",
    "--user-data-dir=$userDataDir",
    $openUrl
)

$playwrightProcess = Start-Process `
    -FilePath "npx.cmd" `
    -ArgumentList $args `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru

$chromeWindowPid = Maximize-PlaywrightWindow -StartedAfter $startedAt

$state = [ordered]@{
    status = "OPEN"
    baseUrl = $baseUrl
    openUrl = $openUrl
    port = $port
    serverPid = if ($serverInfo -and $serverInfo.pid) { [int]$serverInfo.pid } else { $null }
    playwrightOpenPid = $playwrightProcess.Id
    chromeWindowPid = $chromeWindowPid
    viewport = "1920,1080"
    maximized = [bool]$chromeWindowPid
    userDataDir = $userDataDir
    startedAt = (Get-Date).ToString("o")
}

$statePath = Join-Path $repoRoot ".codex-tmp/e2e-open.last.json"
$state | ConvertTo-Json -Compress | Set-Content -Path $statePath -Encoding utf8

Write-Host ("READY:{0}" -f $port)
Write-Host "BASE_URL:$baseUrl"
if ($serverInfo -and $serverInfo.pid) {
    Write-Host ("SERVER_PID:{0}" -f $serverInfo.pid)
}
Write-Host ("PLAYWRIGHT_OPEN_PID:{0}" -f $playwrightProcess.Id)
if ($chromeWindowPid) {
    Write-Host ("CHROME_WINDOW_PID:{0}" -f $chromeWindowPid)
    Write-Host "WINDOW_MAXIMIZED:1"
} else {
    Write-Host "WINDOW_MAXIMIZED:0"
}
Write-Host "STATE:$statePath"
exit 0
