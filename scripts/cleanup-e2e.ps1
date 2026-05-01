param(
    [switch]$AllPython,
    [switch]$AllChrome,
    [switch]$AllApiMain,
    [switch]$SkipServers,
    [switch]$McpChromium,
    [switch]$AllMcp,
    [switch]$Quiet
)

$ErrorActionPreference = "Continue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$tmpRoot = Join-Path $repoRoot ".codex-tmp"

function Write-CleanupLog {
    param([string]$Message)
    if (-not $Quiet) {
        Write-Host $Message
    }
}

function Stop-ProcessTreeSafe {
    param(
        [int]$ProcessId,
        [string]$Reason
    )

    if ($ProcessId -le 0) {
        return
    }

    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) {
        return
    }

    Write-CleanupLog ("CLEAN {0} pid={1}" -f $Reason, $ProcessId)
    try {
        & taskkill.exe /PID $ProcessId /T /F 1>$null 2>$null
    } catch {
    }

    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
        try {
            Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        } catch {
            Write-CleanupLog ("WARN failed to stop pid={0}: {1}" -f $ProcessId, $_.Exception.Message)
        }
    }
}

if (Test-Path $tmpRoot) {
    $pidFilters = @("e2e-node-*.pid", "e2e-browser-*.pid")
    if (-not $SkipServers) {
        $pidFilters = @("e2e-server-*.pid") + $pidFilters
    }

    foreach ($pidFilter in $pidFilters) {
        Get-ChildItem -Path $tmpRoot -Filter $pidFilter -File -ErrorAction SilentlyContinue | ForEach-Object {
            $pidText = (Get-Content -Path $_.FullName -Raw -ErrorAction SilentlyContinue).Trim()
            $pidValue = 0
            if ([int]::TryParse($pidText, [ref]$pidValue)) {
                Stop-ProcessTreeSafe -ProcessId $pidValue -Reason ("stale {0}" -f $_.BaseName)
            }
            Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

$e2eNodePattern = 'scripts[\\/](e2e_chunk[123]|e2e_fresh_boot_smoke|e2e_visible_smoke)\.js'
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -match $e2eNodePattern
} | ForEach-Object {
    Stop-ProcessTreeSafe -ProcessId ([int]$_.ProcessId) -Reason "orphan e2e node"
}

Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "chrome-headless-shell.exe" -and $_.CommandLine -match "playwright_chromiumdev_profile"
} | ForEach-Object {
    Stop-ProcessTreeSafe -ProcessId ([int]$_.ProcessId) -Reason "orphan e2e chromium"
}

Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match "playwright_chromiumdev_profile" -and
    $_.Name -in @(
        "chrome.exe",
        "chromium.exe",
        "chrome-headless-shell.exe",
        "chromium-headless-shell.exe"
    )
} | ForEach-Object {
    Stop-ProcessTreeSafe -ProcessId ([int]$_.ProcessId) -Reason "orphan e2e chromium"
}

$mcpPattern = '(@playwright[\\/]mcp|@playwright/mcp|playwright-mcp)'

if ($McpChromium) {
    Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -match $mcpPattern -and
        $_.CommandLine -match "mcp-chromium-"
    } | ForEach-Object {
        Stop-ProcessTreeSafe -ProcessId ([int]$_.ProcessId) -Reason "stale playwright mcp chromium"
    }
}

if ($AllMcp) {
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @("cmd.exe", "node.exe") -and $_.CommandLine -match $mcpPattern
    } | Sort-Object ParentProcessId, ProcessId | ForEach-Object {
        Stop-ProcessTreeSafe -ProcessId ([int]$_.ProcessId) -Reason "playwright mcp"
    }
}

if ($AllApiMain) {
    $repoPattern = [regex]::Escape($repoRoot)
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "python.exe" -and
        $_.CommandLine -match "api\.main" -and
        $_.CommandLine -match $repoPattern
    } | ForEach-Object {
        Stop-ProcessTreeSafe -ProcessId ([int]$_.ProcessId) -Reason "api.main"
    }
}

if ($AllPython) {
    Get-Process python -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-ProcessTreeSafe -ProcessId ([int]$_.Id) -Reason "python"
    }
}

if ($AllChrome) {
    Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-ProcessTreeSafe -ProcessId ([int]$_.Id) -Reason "chrome"
    }
}

if ((Test-Path $tmpRoot) -and -not $SkipServers) {
    Remove-Item -Path (Join-Path $tmpRoot "e2e-server.last-ready.txt") -Force -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $tmpRoot "e2e-server.last-ready.json") -Force -ErrorAction SilentlyContinue
}
