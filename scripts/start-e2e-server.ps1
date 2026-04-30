param(
    [int]$PreferredPort = 8443
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Stop-ApiMainProcesses {
    $targets = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "python.exe" -and ($_.CommandLine -match "api.main")
    }
    foreach ($target in $targets) {
        try {
            Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Warning ("Failed to stop api.main pid={0}: {1}" -f $target.ProcessId, $_.Exception.Message)
        }
    }
}

function Test-PortFree {
    param([int]$Port)

    $any = $null
    try {
        $any = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
        $any.Start()
        $any.Stop()
        return $true
    } catch {
        try { $any.Stop() } catch {}
        return $false
    }
}

function Get-FreePort {
    param([int]$FirstChoice)

    if ($FirstChoice -gt 0 -and (Test-PortFree -Port $FirstChoice)) {
        return $FirstChoice
    }

    for ($candidate = $FirstChoice + 1; $candidate -le $FirstChoice + 32; $candidate++) {
        if (Test-PortFree -Port $candidate) {
            return $candidate
        }
    }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ($listener.LocalEndpoint).Port
    $listener.Stop()
    return $port
}

function Wait-ForListen {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 3
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(500)) {
                $client.EndConnect($iar)
                $client.Dispose()
                return $true
            }
            $client.Dispose()
        } catch {
        }
    }
    return $false
}

# 기존 서버를 절대 종료하지 않는다 — 항상 빈 포트를 찾아 새 서버를 시작한다
# Stop-ApiMainProcesses 는 제거됨: 사용자 서버(8443 등)를 건드리지 않음

$httpsPort = Get-FreePort -FirstChoice $PreferredPort
$logDir = Join-Path $repoRoot ".codex-tmp"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}
$readyPath = Join-Path $logDir "e2e-server.last-ready.txt"

$stdoutPath = Join-Path $logDir ("e2e-server-{0}.out.log" -f $httpsPort)
$stderrPath = Join-Path $logDir ("e2e-server-{0}.err.log" -f $httpsPort)
Remove-Item $stdoutPath, $stderrPath, $readyPath -Force -ErrorAction SilentlyContinue

$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
$env:UVICORN_LIFESPAN = "on"
$env:UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN = "15"
$env:AUTO_LOGIN = "0"
$env:HOST = "0.0.0.0"
$env:PORT = "5354"
$env:RELOAD = "0"
$env:UVICORN_WORKERS = "1"
$env:WORKERS = "1"
$env:SSL_ENABLED = "1"
$env:HTTPS_PORT = [string]$httpsPort
$env:SSL_CERTFILE = "cert/fullchain.pem"
$env:SSL_KEYFILE = "cert/server.key"
$env:IMAGES_ROOT = "D:/project/data/wm-811k"
$env:POSITIONS_ROOT = "D:/project/data/positions"
$env:ACCESS_LOG_ENABLED = "0"
$env:STARTUP_THUMB_WARM_FOLDERS = ""
$env:STARTUP_THUMB_WARM_COUNT = "0"
$env:STARTUP_WARM_COMPOSITE_MODULES = "0"
$env:USE_COMPOSITE_IMAGE_CACHE = "1"
$env:COMPOSITE_USE_NUMBA = "1"
$env:COMPOSITE_NUMBA_CACHE = "1"

$proc = Start-Process python `
    -ArgumentList "-m", "api.main" `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

if (Wait-ForListen -Port $httpsPort) {
    $readyLine = "READY:{0}" -f $httpsPort
    Set-Content -Path $readyPath -Value $readyLine -Encoding ascii
    Write-Output $readyLine
    exit 0
}

try {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
} catch {
}

Set-Content -Path $readyPath -Value "FAIL" -Encoding ascii
Write-Output "FAIL"
exit 1
