param(
    [switch]$AllPython,
    [switch]$AllChrome,
    [switch]$AllApiMain,
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
    Get-ChildItem -Path $tmpRoot -Filter "e2e-server-*.pid" -File -ErrorAction SilentlyContinue | ForEach-Object {
        $pidText = (Get-Content -Path $_.FullName -Raw -ErrorAction SilentlyContinue).Trim()
        $pidValue = 0
        if ([int]::TryParse($pidText, [ref]$pidValue)) {
            Stop-ProcessTreeSafe -ProcessId $pidValue -Reason "stale e2e server"
        }
        Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
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

if (Test-Path $tmpRoot) {
    Remove-Item -Path (Join-Path $tmpRoot "e2e-server.last-ready.txt") -Force -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $tmpRoot "e2e-server.last-ready.json") -Force -ErrorAction SilentlyContinue
}
