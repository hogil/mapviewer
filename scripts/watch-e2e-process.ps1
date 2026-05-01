param(
    [int]$OwnerPid,
    [int]$TargetPid,
    [string]$PidFile = "",
    [string]$Reason = "e2e-process",
    [string]$LogPath = ""
)

$ErrorActionPreference = "Continue"

function Write-WatchLog {
    param([string]$Message)
    if ([string]::IsNullOrWhiteSpace($LogPath)) {
        return
    }
    try {
        Add-Content -Path $LogPath -Encoding UTF8 -Value ("{0} {1}" -f (Get-Date).ToString("o"), $Message)
    } catch {
    }
}

function Remove-MatchingPidFile {
    if ([string]::IsNullOrWhiteSpace($PidFile) -or -not (Test-Path $PidFile)) {
        return
    }

    try {
        $pidText = (Get-Content -Path $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
        $pidValue = 0
        if ([int]::TryParse($pidText, [ref]$pidValue) -and $pidValue -eq $TargetPid) {
            Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
        }
    } catch {
    }
}

function Stop-ProcessTreeSafe {
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

if ($OwnerPid -le 0 -or $TargetPid -le 0) {
    exit 0
}

Write-WatchLog ("WATCH start owner={0} target={1} reason={2}" -f $OwnerPid, $TargetPid, $Reason)

while ($true) {
    $target = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $target) {
        Write-WatchLog ("WATCH target-exited target={0} reason={1}" -f $TargetPid, $Reason)
        Remove-MatchingPidFile
        exit 0
    }

    $owner = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
    if (-not $owner) {
        Write-WatchLog ("WATCH owner-exited owner={0} stopping target={1} reason={2}" -f $OwnerPid, $TargetPid, $Reason)
        Stop-ProcessTreeSafe -ProcessId $TargetPid
        Remove-MatchingPidFile
        exit 0
    }

    Start-Sleep -Seconds 1
}
