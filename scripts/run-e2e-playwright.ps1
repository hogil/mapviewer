param(
    [ValidateSet("all", "1", "2", "3")]
    [string]$Chunk = "all",
    [switch]$WithSmoke,
    [switch]$Headless,
    [switch]$KeepServer,
    [switch]$NoCleanBeforeRun,
    [switch]$ColdCache
)

$ErrorActionPreference = "Stop"

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path (Join-Path $repoRoot ".codex-tmp"))) {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot ".codex-tmp") | Out-Null
}
$tmpRoot = Join-Path $repoRoot ".codex-tmp"

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

$script:E2EServerPid = $null
$script:E2ECurrentNodePid = $null

function Start-E2EProcessWatchdog {
    param(
        [int]$TargetProcessId,
        [string]$PidFile,
        [string]$Reason,
        [string]$LogPath
    )

    if ($TargetProcessId -le 0) {
        return
    }

    $watchScript = Join-Path $PSScriptRoot "watch-e2e-process.ps1"
    if (-not (Test-Path $watchScript)) {
        return
    }

    $hostPath = $null
    try {
        $hostPath = (Get-Process -Id $PID -ErrorAction Stop).Path
    } catch {
        $hostPath = "powershell.exe"
    }
    if ([string]::IsNullOrWhiteSpace($hostPath)) {
        $hostPath = "powershell.exe"
    }

    if ([string]::IsNullOrWhiteSpace($LogPath)) {
        $LogPath = Join-Path $tmpRoot ("e2e-watch-{0}.log" -f $TargetProcessId)
    }

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy Bypass",
        ('-File "{0}"' -f $watchScript),
        ('-OwnerPid {0}' -f $PID),
        ('-TargetPid {0}' -f $TargetProcessId),
        ('-PidFile "{0}"' -f $PidFile),
        ('-Reason "{0}"' -f $Reason),
        ('-LogPath "{0}"' -f $LogPath)
    ) -join " "

    try {
        Start-Process -FilePath $hostPath -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
    } catch {
    }
}

trap {
    if (-not $KeepServer -and $script:E2ECurrentNodePid) {
        Stop-ProcessTree -ProcessId ([int]$script:E2ECurrentNodePid)
    }
    if (-not $KeepServer -and $script:E2EServerPid) {
        Stop-ProcessTree -ProcessId ([int]$script:E2EServerPid)
    }
    & (Join-Path $PSScriptRoot "cleanup-e2e.ps1") -Quiet
    Write-Error $_
    exit 1
}

function Stop-StaleE2EServers {
    $pidFiles = @(Get-ChildItem -Path (Join-Path $repoRoot ".codex-tmp") -Filter "e2e-server-*.pid" -File -ErrorAction SilentlyContinue)
    foreach ($pidFile in $pidFiles) {
        $pidText = (Get-Content -Path $pidFile.FullName -Raw -ErrorAction SilentlyContinue).Trim()
        $pidValue = 0
        if ([int]::TryParse($pidText, [ref]$pidValue) -and $pidValue -gt 0) {
            $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "CLEAN stale E2E server pid=$pidValue"
                Stop-ProcessTree -ProcessId $pidValue
            }
        }
        Remove-Item -Path $pidFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Clear-E2EColdCache {
    $imagesRoot = $env:IMAGES_ROOT
    if ([string]::IsNullOrWhiteSpace($imagesRoot)) {
        $imagesRoot = if ($IsWindows -or $env:OS -eq "Windows_NT") { "D:/project/data/wm-811k" } else { "/appdata/appuser/images" }
    }

    $root = (Resolve-Path -LiteralPath $imagesRoot -ErrorAction Stop).Path
    if ((Split-Path -Leaf $root).ToLowerInvariant() -ne "wm-811k") {
        throw "Refusing to clear E2E cold cache outside wm-811k root: $root"
    }

    $removed = New-Object System.Collections.Generic.List[string]
    $thumbnailDir = Join-Path $root "thumbnails"
    if (Test-Path -LiteralPath $thumbnailDir) {
        Remove-Item -LiteralPath $thumbnailDir -Recurse -Force -ErrorAction Stop
        $removed.Add($thumbnailDir)
    }

    $indexCache = Join-Path $root ".file_index_cache.txt"
    if (Test-Path -LiteralPath $indexCache) {
        Remove-Item -LiteralPath $indexCache -Force -ErrorAction Stop
        $removed.Add($indexCache)
    }

    Get-ChildItem -LiteralPath $root -Filter ".file_index_cache_*.lock" -File -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
        $removed.Add($_.FullName)
    }

    $compositeInputCache = Join-Path $root "composite_cache_v1"
    if (Test-Path -LiteralPath $compositeInputCache) {
        Remove-Item -LiteralPath $compositeInputCache -Recurse -Force -ErrorAction Stop
        $removed.Add($compositeInputCache)
    }

    Write-Host ("COLD_CACHE cleared root={0} removed={1}" -f $root, ($removed.Count))
    foreach ($item in $removed) {
        Write-Host ("COLD_CACHE removed {0}" -f $item)
    }
}

if (-not $NoCleanBeforeRun) {
    & (Join-Path $PSScriptRoot "cleanup-e2e.ps1") -Quiet
    Stop-StaleE2EServers
}

if ($ColdCache) {
    Clear-E2EColdCache
}

$readyPath = Join-Path $repoRoot ".codex-tmp/e2e-server.last-ready.txt"
$readyJsonPath = Join-Path $repoRoot ".codex-tmp/e2e-server.last-ready.json"

function Get-E2EServerInfo {
    param(
        [string]$ReadyJsonPath,
        [int]$Port
    )

    $info = $null
    if (Test-Path $ReadyJsonPath) {
        try {
            $info = Get-Content -Path $ReadyJsonPath -Raw | ConvertFrom-Json
        } catch {
            $info = $null
        }
    }
    if ($info -and $info.pid) {
        return $info
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

function Test-E2EServerAlive {
    param(
        [string]$BaseUrl,
        [int]$ProcessId,
        [int]$TimeoutSeconds = 5
    )

    if ($ProcessId -gt 0 -and -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        return $false
    }

    try {
        $raw = & curl.exe -s -k --max-time $TimeoutSeconds "$BaseUrl/api/config"
        return ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($raw))
    } catch {
        return $false
    }
}

function Invoke-ServerCompositeNumbaWarm {
    param([string]$BaseUrl)

    Write-Host "WARMUP composite numba"
    $raw = & curl.exe -s -k --max-time 10 `
        -H "X-L3-Startup-Warm: 1" `
        -X POST "$BaseUrl/api/internal/composite-numba-warmup"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        Write-Host "WARN Composite Numba warmup did not finish within 10s for $BaseUrl"
        return $false
    }
    Write-Host "COMPOSITE_NUMBA_WARM $raw"
    return $true
}

$port = $null
$serverInfo = $null
$baseUrl = $null
$preferredPort = 8443
$maxServerAttempts = 3
for ($serverAttempt = 1; $serverAttempt -le $maxServerAttempts; $serverAttempt++) {
    Write-Host "BOOTSTRAP scripts/start-e2e-server.ps1 (attempt=$serverAttempt preferred=$preferredPort)"
    Remove-Item $readyPath, $readyJsonPath -Force -ErrorAction SilentlyContinue
    $ready = & (Join-Path $PSScriptRoot "start-e2e-server.ps1") -PreferredPort $preferredPort -OwnerPid $PID
    if ([string]::IsNullOrWhiteSpace($ready) -and (Test-Path $readyPath)) {
        $ready = (Get-Content -Path $readyPath -Raw -ErrorAction SilentlyContinue).Trim()
    }
    if ($ready -notmatch '^READY:(\d+)$') {
        Write-Host "WARN E2E server bootstrap failed: $ready"
        $preferredPort += 1
        continue
    }

    $candidatePort = [int]$Matches[1]
    $candidateInfo = Get-E2EServerInfo -ReadyJsonPath $readyJsonPath -Port $candidatePort
    $candidatePid = if ($candidateInfo -and $candidateInfo.pid) { [int]$candidateInfo.pid } else { 0 }
    $candidateBaseUrl = "https://127.0.0.1:$candidatePort"

    if (-not (Test-E2EServerAlive -BaseUrl $candidateBaseUrl -ProcessId $candidatePid -TimeoutSeconds 5)) {
        Write-Host "WARN E2E server died or did not answer after READY: $candidateBaseUrl pid=$candidatePid"
        if (-not $KeepServer -and $candidatePid -gt 0) {
            Stop-ProcessTree -ProcessId $candidatePid
        }
        & (Join-Path $PSScriptRoot "cleanup-e2e.ps1") -Quiet
        $preferredPort = $candidatePort + 1
        continue
    }

    [void](Invoke-ServerCompositeNumbaWarm -BaseUrl $candidateBaseUrl)

    $port = $candidatePort
    $serverInfo = $candidateInfo
    $script:E2EServerPid = $candidatePid
    $baseUrl = $candidateBaseUrl
    break
}

if (-not $baseUrl) {
    Write-Error "E2E server bootstrap failed after $maxServerAttempts attempts"
    exit 1
}

$sessionId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$outputDir = Join-Path $repoRoot (Join-Path ".codex-tmp/e2e-sessions" $sessionId)
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$scripts = switch ($Chunk) {
    "1" { @("scripts/e2e_chunk1.js") }
    "2" { @("scripts/e2e_chunk2.js") }
    "3" { @("scripts/e2e_chunk3.js") }
    default { @("scripts/e2e_chunk1.js", "scripts/e2e_chunk2.js", "scripts/e2e_chunk3.js") }
}
if ($WithSmoke) {
    $scripts = @("scripts/e2e_fresh_boot_smoke.js") + $scripts
}

$env:E2E_BASE_URL = $baseUrl
$env:E2E_SESSION_ID = $sessionId
$env:E2E_OUTPUT_DIR = $outputDir
$env:E2E_HEADLESS = if ($Headless) { "1" } else { "0" }
$env:E2E_BROWSER_SESSION_ATTEMPTS = if ($Headless) { "1" } else { "3" }
if ($Headless) {
    Write-Host "BROWSER headless=1 (no visible browser window expected)"
} else {
    Write-Host "BROWSER headless=0 (visible browser expected, session attempts=$($env:E2E_BROWSER_SESSION_ATTEMPTS))"
}

function Get-NewTailLines {
    param(
        [string]$Path,
        [int]$Skip
    )

    if (-not (Test-Path $Path)) {
        return @{ Lines = @(); Count = $Skip }
    }

    $lines = @(Get-Content -Path $Path -Encoding UTF8)
    $count = $lines.Count
    if ($count -le $Skip) {
        return @{ Lines = @(); Count = $count }
    }

    return @{
        Lines = @($lines[$Skip..($count - 1)])
        Count = $count
    }
}

function Get-MedianNumber {
    param([double[]]$Values)

    $sorted = @($Values | Where-Object { $_ -ne $null -and -not [double]::IsNaN($_) } | Sort-Object)
    if ($sorted.Count -eq 0) {
        return $null
    }

    $middle = [int][Math]::Floor($sorted.Count / 2)
    if (($sorted.Count % 2) -eq 1) {
        return [Math]::Round([double]$sorted[$middle], 3)
    }
    return [Math]::Round((([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2.0), 3)
}

function Convert-ProgressDetail {
    param([string]$Text)

    try {
        return ($Text | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $Text
    }
}

function Get-ProgressRecords {
    param([string]$OutputDir)

    $records = @()
    $progressFiles = @(Get-ChildItem -Path $OutputDir -Filter "*.progress.log" -File -ErrorAction SilentlyContinue | Sort-Object Name)
    foreach ($progressFile in $progressFiles) {
        $lines = @(Get-Content -Path $progressFile.FullName -Encoding UTF8 -ErrorAction SilentlyContinue)
        foreach ($line in $lines) {
            if ($line -match '^\[(PASS|FAIL)\]\s+(\S+)\s+(.+?)\s+::\s+(.*)$') {
                $status = $Matches[1]
                $phase = $Matches[2]
                $name = $Matches[3]
                $detailText = $Matches[4]
                $records += [pscustomobject]@{
                    status = $status
                    phase = $phase
                    name = $name
                    detail = Convert-ProgressDetail -Text $detailText
                    log = $progressFile.Name
                }
            }
        }
    }
    return $records
}

function Add-E2EMetricIfPresent {
    param(
        [System.Collections.ArrayList]$Metrics,
        [object]$Object,
        [string]$Key,
        [string]$Label
    )

    if ($null -eq $Object -or $Object -is [string]) {
        return
    }
    if ([string]::IsNullOrWhiteSpace($Label)) {
        $Label = $Key
    }
    $prop = $Object.PSObject.Properties[$Key]
    if ($prop) {
        Add-E2EMetricValue -Metrics $Metrics -Label $Label -Value $prop.Value
    }
}

function Add-E2EMetricValue {
    param(
        [System.Collections.ArrayList]$Metrics,
        [string]$Label,
        [object]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Label) -or $null -eq $Value) {
        return
    }
    if ($Value -is [System.Array] -or ($Value -isnot [string] -and $null -ne $Value.PSObject.Properties -and $Value.PSObject.Properties.Count -gt 0 -and $Value.GetType().Name -eq "PSCustomObject")) {
        return
    }
    $text = ("{0}" -f $Value).Trim() -replace "\s+", " "
    if ([string]::IsNullOrWhiteSpace($text)) {
        return
    }
    if ($text.Length -gt 80) {
        $text = $text.Substring(0, 77) + "..."
    }
    $entry = ("{0}={1}" -f $Label, $text)
    if (-not $Metrics.Contains($entry)) {
        [void]$Metrics.Add($entry)
    }
}

function Add-E2ECountMetricIfPresent {
    param(
        [System.Collections.ArrayList]$Metrics,
        [object]$Object,
        [string]$Key,
        [string]$Label
    )

    if ($null -eq $Object -or $Object -is [string]) {
        return
    }
    if ([string]::IsNullOrWhiteSpace($Label)) {
        $Label = ("{0}Count" -f $Key)
    }
    $prop = $Object.PSObject.Properties[$Key]
    if ($prop) {
        $value = $prop.Value
        if ($null -ne $value -and $value -isnot [string] -and $null -ne $value.Count) {
            Add-E2EMetricValue -Metrics $Metrics -Label $Label -Value $value.Count
        }
    }
}

function Add-E2ENestedMetricsIfPresent {
    param(
        [System.Collections.ArrayList]$Metrics,
        [object]$Object,
        [string]$Key,
        [string]$Prefix,
        [string[]]$MetricKeys
    )

    if ($null -eq $Object -or $Object -is [string]) {
        return
    }
    $prop = $Object.PSObject.Properties[$Key]
    if (-not $prop) {
        return
    }
    $child = $prop.Value
    if ($null -eq $child -or $child -is [string]) {
        return
    }
    foreach ($metricKey in $MetricKeys) {
        Add-E2EMetricIfPresent -Metrics $Metrics -Object $child -Key $metricKey -Label ("{0}.{1}" -f $Prefix, $metricKey)
    }
}

function Get-E2EMetricSafeLabel {
    param([string]$Label)

    $safe = ($Label -replace "[\s,;()]+", "_" -replace "[^A-Za-z0-9_.-]", "_").Trim("_")
    if ($safe.Length -gt 72) {
        return $safe.Substring(0, 72)
    }
    return $safe
}

function Add-E2ESearchCollectionMetrics {
    param(
        [System.Collections.ArrayList]$Metrics,
        [object]$Collection,
        [string]$Prefix,
        [int]$Limit = 12
    )

    if ($null -eq $Collection -or $Collection -is [string]) {
        return
    }
    $idx = 0
    foreach ($prop in $Collection.PSObject.Properties) {
        if ($idx -ge $Limit) {
            break
        }
        $idx += 1
        $item = $prop.Value
        if ($null -eq $item -or $item -is [string]) {
            continue
        }
        $label = Get-E2EMetricSafeLabel -Label ("{0}.{1}" -f $Prefix, $prop.Name)
        foreach ($key in @("count", "total", "wraps", "inputCount", "parsedCount", "totalMs", "logicalEvalMs")) {
            Add-E2EMetricIfPresent -Metrics $Metrics -Object $item -Key $key -Label ("{0}.{1}" -f $label, $key)
        }
        foreach ($statProp in @("apiTotalMs", "logicalEvalMs", "wallMs")) {
            $stat = $item.PSObject.Properties[$statProp]
            if ($stat -and $stat.Value) {
                foreach ($key in @("n", "avg", "stddev", "spread", "min", "max")) {
                    Add-E2EMetricIfPresent -Metrics $Metrics -Object $stat.Value -Key $key -Label ("{0}.{1}.{2}" -f $label, $statProp, $key)
                }
            }
        }
        if ($item.PSObject.Properties.Name -contains "liveFallback" -and $item.liveFallback) {
            Add-E2EMetricIfPresent -Metrics $Metrics -Object $item.liveFallback -Key "invoked" -Label ("{0}.liveFallback.invoked" -f $label)
            Add-E2EMetricIfPresent -Metrics $Metrics -Object $item.liveFallback -Key "hits" -Label ("{0}.liveFallback.hits" -f $label)
            Add-E2ECountMetricIfPresent -Metrics $Metrics -Object $item.liveFallback -Key "missingLots" -Label ("{0}.liveFallback.missingLotsCount" -f $label)
            Add-E2ECountMetricIfPresent -Metrics $Metrics -Object $item.liveFallback -Key "foundLots" -Label ("{0}.liveFallback.foundLotsCount" -f $label)
            foreach ($statProp in @("scanMs", "filesScanned", "dirsScanned")) {
                $stat = $item.liveFallback.PSObject.Properties[$statProp]
                if ($stat -and $stat.Value) {
                    foreach ($key in @("n", "avg", "spread", "max")) {
                        Add-E2EMetricIfPresent -Metrics $Metrics -Object $stat.Value -Key $key -Label ("{0}.liveFallback.{1}.{2}" -f $label, $statProp, $key)
                    }
                }
            }
        }
    }
}

function Add-E2EArrayMetrics {
    param(
        [System.Collections.ArrayList]$Metrics,
        [object]$Object,
        [string]$Key,
        [string]$Prefix
    )

    if ($null -eq $Object -or $Object -is [string]) {
        return
    }
    $prop = $Object.PSObject.Properties[$Key]
    if (-not $prop -or $null -eq $prop.Value -or $prop.Value -is [string]) {
        return
    }
    $items = @($prop.Value)
    Add-E2EMetricValue -Metrics $Metrics -Label ("{0}.count" -f $Prefix) -Value $items.Count
    if ($items.Count -gt 0 -and $items[-1] -isnot [string]) {
        foreach ($metricKey in @("count", "wraps", "visibleCount", "loadedCount", "badCount", "scrollTop", "navigatorVisible", "minimapVisible")) {
            Add-E2EMetricIfPresent -Metrics $Metrics -Object $items[-1] -Key $metricKey -Label ("{0}.last.{1}" -f $Prefix, $metricKey)
        }
    }
}

function Get-E2EDetailMetrics {
    param([object]$Detail)

    $metrics = [System.Collections.ArrayList]::new()
    if ($null -eq $Detail) {
        return @()
    }
    if ($Detail -is [string]) {
        if (-not [string]::IsNullOrWhiteSpace($Detail)) {
            [void]$metrics.Add(("detail={0}" -f $Detail))
        }
        return $metrics.ToArray()
    }

    foreach ($key in @(
        "count", "wraps", "visibleWraps", "broken", "loadMs",
        "fqLoadMs", "fqCount", "placeholders", "highlighted",
        "folderCount", "classCount", "hasUnknownFolder", "classListExists",
        "unknownCount", "unknownFileCount", "uniqueLotCount", "runsPerScenario", "lotCount", "wfCount",
        "lotHeaders", "scrollTop", "beforePages", "afterPages", "multiVisible", "permissionVisible", "permRows",
        "myLotVisible", "baselineTotalRequests", "finalTotalRequests", "baselineDailyRequests", "finalDailyRequests",
        "rootEndpointCount", "ctxComposite", "ctxMeasure", "refVisible", "overlay", "compositeCount",
        "chipInfoLen", "expectedB", "marked", "beforeHit", "toastSeen", "measureColorVisible",
        "gridCount", "measureItems", "activeRole", "overlayMode",
        "selectedCount", "selectedImages", "tabCount", "annotationAvgMs",
        "lookupMs", "markedCount", "elapsedMs", "elapsedSec",
        "sourceImageCount", "processingTime"
    )) {
        Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail -Key $key
    }
    foreach ($prop in $Detail.PSObject.Properties) {
        $value = $prop.Value
        if ($null -ne $value -and ($value -is [bool] -or $value -is [byte] -or $value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [decimal])) {
            Add-E2EMetricValue -Metrics $metrics -Label (Get-E2EMetricSafeLabel -Label $prop.Name) -Value $value
        }
    }

    if ($Detail.PSObject.Properties.Name -contains "status" -and $Detail.status -isnot [string]) {
        foreach ($key in @("ready", "building", "total_files", "total_dirs")) {
            Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.status -Key $key -Label ("index.{0}" -f $key)
        }
    }

    if ($Detail.PSObject.Properties.Name -contains "ui" -and $Detail.ui) {
        foreach ($group in @("lot100", "wf100")) {
            if ($Detail.ui.PSObject.Properties.Name -contains $group) {
                foreach ($key in @("avgMs", "stdMs", "spreadMs", "count")) {
                    Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.ui.$group -Key $key -Label ("ui.{0}.{1}" -f $group, $key)
                }
            }
        }
    }

    if ($Detail.PSObject.Properties.Name -contains "api" -and $Detail.api) {
        foreach ($group in @("exact", "lot100", "wf100")) {
            if ($Detail.api.PSObject.Properties.Name -contains $group) {
                foreach ($key in @("avgMs", "stdMs", "spreadMs", "count", "totalMs")) {
                    Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.api.$group -Key $key -Label ("api.{0}.{1}" -f $group, $key)
                }
            }
        }
    }

    Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail -Key "classes" -Label "classesCount"
    Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail -Key "compositeSourcePaths" -Label "compositeSourceCount"
    foreach ($key in @("selectedImagesForLabel", "files", "afterHits", "afterTimings", "afterCounts", "deletedHits", "deletedTimings", "deletedCounts", "selectedUnknownPaths", "visibleFloatingPanelsAfterComposite", "pageRoles", "selectedIndices")) {
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail -Key $key -Label ("{0}Count" -f $key)
    }

    if ($Detail.PSObject.Properties.Name -contains "classData" -and $Detail.classData) {
        Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.classData -Key "count" -Label "classData.count"
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail.classData -Key "classes" -Label "classData.classesCount"
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail.classData -Key "images" -Label "classData.imagesCount"
    }

    foreach ($prop in $Detail.PSObject.Properties) {
        $value = $prop.Value
        if ($null -ne $value -and $value -isnot [string] -and ($value.PSObject.Properties.Name -contains "count" -or $value.PSObject.Properties.Name -contains "wraps")) {
            $label = Get-E2EMetricSafeLabel -Label $prop.Name
            foreach ($key in @("count", "total", "wraps", "unknownCount")) {
                Add-E2EMetricIfPresent -Metrics $metrics -Object $value -Key $key -Label ("{0}.{1}" -f $label, $key)
            }
        }
    }

    if ($Detail.PSObject.Properties.Name -contains "apiResults") {
        Add-E2ESearchCollectionMetrics -Metrics $metrics -Collection $Detail.apiResults -Prefix "api"
    }
    if ($Detail.PSObject.Properties.Name -contains "uiTextResults") {
        Add-E2ESearchCollectionMetrics -Metrics $metrics -Collection $Detail.uiTextResults -Prefix "uiText"
    }
    if ($Detail.PSObject.Properties.Name -contains "uiMultiResults") {
        Add-E2ESearchCollectionMetrics -Metrics $metrics -Collection $Detail.uiMultiResults -Prefix "uiMulti"
    }
    if ($Detail.PSObject.Properties.Name -contains "uiResult") {
        foreach ($key in @("count", "wraps", "unknownCount")) {
            Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.uiResult -Key $key -Label ("uiResult.{0}" -f $key)
        }
    }

    if ($Detail.PSObject.Properties.Name -contains "labelSeed" -and $Detail.labelSeed) {
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail.labelSeed -Key "seeded" -Label "labelSeed.seededCount"
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail.labelSeed -Key "classes" -Label "labelSeed.classesCount"
    }

    foreach ($nested in @(
        "single", "multi",
        "compositeBefore", "compositeSettled", "compositeAfter",
        "measureBefore", "measureAfter",
        "labelBefore", "labelAfter",
        "mylotBefore", "mylotAfter",
        "before", "after",
        "searchBefore", "searchAfter", "multiNoResult",
        "labelClearBefore", "labelAfterLeftBlank", "labelAfterRightBlank", "labelAfterReselect", "labelScrollReset"
    )) {
        Add-E2ENestedMetricsIfPresent `
            -Metrics $metrics `
            -Object $Detail `
            -Key $nested `
            -Prefix $nested `
            -MetricKeys @("count", "wraps", "visibleCount", "loadedCount", "badCount", "lotHeaders", "gridCols", "currentGridImages", "scrollTop")
    }

    if ($Detail.PSObject.Properties.Name -contains "explorerDirectRoundTrip") {
        Add-E2ENestedMetricsIfPresent -Metrics $metrics -Object $Detail.explorerDirectRoundTrip -Key "before" -Prefix "explorer.before" -MetricKeys @("count", "wraps", "gridMode")
        Add-E2ENestedMetricsIfPresent -Metrics $metrics -Object $Detail.explorerDirectRoundTrip -Key "after" -Prefix "explorer.after" -MetricKeys @("count", "wraps", "gridMode")
    }
    foreach ($nested in @("mcSubmenuState", "meaSubmenuState", "freshMcState", "mcBeforeGenerate", "selectedPanelAfterComposite")) {
        Add-E2ENestedMetricsIfPresent -Metrics $metrics -Object $Detail -Key $nested -Prefix $nested -MetricKeys @("itemCount", "checkboxCount", "checkedCount", "buttonDisabled", "count", "isCompositeMode")
    }
    if ($Detail.PSObject.Properties.Name -contains "scrollStop") {
        Add-E2ENestedMetricsIfPresent -Metrics $metrics -Object $Detail.scrollStop -Key "early" -Prefix "scrollStop.early" -MetricKeys @("visibleCount", "loadedCount", "badCount", "scrollTop")
        Add-E2ENestedMetricsIfPresent -Metrics $metrics -Object $Detail.scrollStop -Key "settled" -Prefix "scrollStop.settled" -MetricKeys @("visibleCount", "loadedCount", "badCount", "scrollTop")
    }
    foreach ($arrayKey in @("loops", "gridRoundTrips", "scrolledRoundTrips")) {
        Add-E2EArrayMetrics -Metrics $metrics -Object $Detail -Key $arrayKey -Prefix $arrayKey
    }

    foreach ($nested in @(
        "waferBeforeComposite", "waferAfterComposite",
        "compositeGridBefore", "compositeGridAfter",
        "measureGridBefore", "measureGridAfter",
        "labelGridBefore", "labelGridAfter",
        "mylotGridBefore", "mylotGridAfter"
    )) {
        Add-E2ENestedMetricsIfPresent `
            -Metrics $metrics `
            -Object $Detail `
            -Key $nested `
            -Prefix $nested `
            -MetricKeys @("currentGridImagesLen", "selectedImagesLen", "visibleGridWraps", "totalGridWraps", "scrollTop", "gridMode", "viewMode")
    }

    if ($Detail.PSObject.Properties.Name -contains "wafer" -and $Detail.wafer) {
        Add-E2ENestedMetricsIfPresent -Metrics $metrics -Object $Detail.wafer -Key "before" -Prefix "wafer.before" -MetricKeys @("currentGridImagesLen", "visibleGridWraps", "totalGridWraps", "scrollTop")
        Add-E2ENestedMetricsIfPresent -Metrics $metrics -Object $Detail.wafer -Key "after" -Prefix "wafer.after" -MetricKeys @("currentGridImagesLen", "visibleGridWraps", "totalGridWraps", "scrollTop")
    }

    if ($Detail.PSObject.Properties.Name -contains "measure" -and $Detail.measure) {
        Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.measure -Key "overlayMode" -Label "measure.overlayMode"
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail.measure -Key "selectedIdxs" -Label "measure.selectedCount"
    }
    if ($Detail.PSObject.Properties.Name -contains "label" -and $Detail.label) {
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail.label -Key "selectedIdxs" -Label "label.selectedCount"
        Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.label -Key "labelClass" -Label "label.class"
    }
    if ($Detail.PSObject.Properties.Name -contains "mylot" -and $Detail.mylot) {
        Add-E2ECountMetricIfPresent -Metrics $metrics -Object $Detail.mylot -Key "selectedIdxs" -Label "mylot.selectedCount"
    }

    if ($Detail.PSObject.Properties.Name -contains "npzOnlySubsetRecolor" -and $Detail.npzOnlySubsetRecolor) {
        foreach ($key in @("subsetOk", "subsetStatus", "subsetCount", "recolorOk", "recolorStatus", "recolorCount")) {
            Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.npzOnlySubsetRecolor -Key $key -Label ("npz.{0}" -f $key)
        }
    }

    if ($Detail.PSObject.Properties.Name -contains "compositePerf" -and $Detail.compositePerf) {
        foreach ($key in @("elapsedMs", "elapsedSec", "sourceImageCount", "processingTime")) {
            Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.compositePerf -Key $key -Label ("composite.{0}" -f $key)
        }
        if ($Detail.compositePerf.PSObject.Properties.Name -contains "numba") {
            foreach ($key in @("enabled", "warmed", "threads", "accumulator", "batch_size")) {
                Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.compositePerf.numba -Key $key -Label ("numba.{0}" -f $key)
            }
        }
    }

    if ($Detail.PSObject.Properties.Name -contains "coldStartSummary" -and $Detail.coldStartSummary -and $Detail.coldStartSummary.median) {
        Add-E2EMetricIfPresent -Metrics $metrics -Object $Detail.coldStartSummary.median -Key "fqLoadMs" -Label "cold.median.fqLoadMs"
    }

    return @($metrics | Select-Object -First 96)
}

function Format-E2EDetailMetrics {
    param([object]$Detail)

    $metrics = @(Get-E2EDetailMetrics -Detail $Detail)
    if ($metrics.Count -eq 0) {
        return "metrics=not-recorded"
    }
    return ("metrics: {0}" -f ($metrics -join ", "))
}

function Get-E2EMetricNoteLines {
    return @(
        "index.loadMs: wall time for loadFolder('unknown') to load the 5000-image unknown grid into viewer state and DOM in Phase 36,37,38,40. It is not index build time and not a 4M-file scan time.",
        "index.total_files/index.total_dirs: current full index size returned by /api/index-status. These are status counters, not files processed during the loadMs interval.",
        "fqLoadMs: wall time for the grouped unknown 5000-image grid/cache/FQ-missing/placeholder/asset-version phase. It is not single F/Q image generation time.",
        "search apiTotalMs/logicalEvalMs/UI wallMs: API timings measure indexed lookup/logical evaluation; UI wallMs includes browser input and result rendering.",
        "composite.elapsedMs/processingTime: browser-observed composite creation wall time and server-reported processing time for the selected source images."
    )
}

function Write-E2EReportFile {
    param(
        [string]$OutputDir,
        [object]$Summary,
        [string]$ColdStartPath
    )

    $reportPath = Join-Path $OutputDir "e2e-report.txt"
    $lines = [System.Collections.ArrayList]::new()
    [void]$lines.Add("E2E REPORT")
    [void]$lines.Add(("session={0}" -f $Summary.sessionId))
    [void]$lines.Add(("baseUrl={0}" -f $Summary.baseUrl))
    [void]$lines.Add(("chunk={0} headless={1} exitCode={2}" -f $Summary.chunk, $Summary.headless, $Summary.exitCode))
    [void]$lines.Add(("result status={0} pass={1} fail={2} records={3}" -f $Summary.status, $Summary.totals.pass, $Summary.totals.fail, $Summary.totals.records))
    [void]$lines.Add("")
    [void]$lines.Add("Phase results:")
    foreach ($record in $Summary.records) {
        $metrics = Format-E2EDetailMetrics -Detail $record.detail
        [void]$lines.Add(("- [{0}] phase={1} name={2} {3}" -f $record.status, $record.phase, $record.name, $metrics))
    }
    [void]$lines.Add("")
    [void]$lines.Add("Metric notes:")
    foreach ($note in Get-E2EMetricNoteLines) {
        [void]$lines.Add(("- {0}" -f $note))
    }
    if (Test-Path $ColdStartPath) {
        [void]$lines.Add(("coldStartSummary={0}" -f $ColdStartPath))
    }

    $lines | Set-Content -Path $reportPath -Encoding UTF8
    return $reportPath
}

function Write-E2ESummaryFiles {
    param(
        [string]$OutputDir,
        [string]$SessionId,
        [string]$BaseUrl,
        [string]$Chunk,
        [bool]$Headless,
        [int]$ExitCode
    )

    $records = @(Get-ProgressRecords -OutputDir $OutputDir)
    $passCount = @($records | Where-Object { $_.status -eq "PASS" }).Count
    $failCount = @($records | Where-Object { $_.status -eq "FAIL" }).Count
    $summary = [pscustomobject]@{
        sessionId = $SessionId
        baseUrl = $BaseUrl
        chunk = $Chunk
        headless = $Headless
        status = if ($ExitCode -eq 0 -and $failCount -eq 0) { "PASS" } else { "FAIL" }
        exitCode = $ExitCode
        generatedAt = (Get-Date).ToString("o")
        totals = [pscustomobject]@{
            records = $records.Count
            pass = $passCount
            fail = $failCount
        }
        records = $records
    }
    $summaryPath = Join-Path $OutputDir "e2e-summary.json"
    $summary | ConvertTo-Json -Depth 40 | Set-Content -Path $summaryPath -Encoding UTF8

    $coldPath = Join-Path $OutputDir "cold-start-summary.json"
    if (-not (Test-Path $coldPath)) {
        $coldRecords = @(
            $records | Where-Object {
                $recordName = [string]$_.name
                $recordNameLower = $recordName.ToLowerInvariant()
                $_.phase -match '(^|,)6[12](,|$)' -or
                $recordNameLower.Contains('cold') -or
                $recordName.Contains('캐시') -or
                $recordName.Contains('성능')
            }
        )
        $fqValues = @()
        foreach ($record in $coldRecords) {
            if ($record.detail -isnot [string] -and $record.detail.PSObject.Properties.Name -contains "fqLoadMs") {
                $fqValues += [double]$record.detail.fqLoadMs
            }
        }
        $coldSummary = [pscustomobject]@{
            sessionId = $SessionId
            baseUrl = $BaseUrl
            status = if (@($coldRecords | Where-Object { $_.status -eq "FAIL" }).Count -eq 0) { "PASS" } else { "FAIL" }
            generatedAt = (Get-Date).ToString("o")
            source = "runner-progress-fallback"
            strictCold = $false
            note = "No dedicated cold-start artifact was produced by the chunk. This fallback summarizes matching progress records only."
            runs = $coldRecords
            median = [pscustomobject]@{
                fqLoadMs = Get-MedianNumber -Values $fqValues
            }
        }
        $coldSummary | ConvertTo-Json -Depth 40 | Set-Content -Path $coldPath -Encoding UTF8
    }

    $reportPath = Write-E2EReportFile -OutputDir $OutputDir -Summary $summary -ColdStartPath $coldPath

    return [pscustomobject]@{
        summary = $summaryPath
        coldStart = $coldPath
        report = $reportPath
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
                $warmupQueries = @("AAB301", "AAN585", "AAK170", "AAS114", "AAV840", "AAU220")
                foreach ($query in $warmupQueries) {
                    $encodedQuery = [System.Uri]::EscapeDataString($query)
                    $raw = & curl.exe -s -k --max-time 10 "$BaseUrl/api/search?q=$encodedQuery&limit=1"
                    $response = if (-not [string]::IsNullOrWhiteSpace($raw)) {
                        $raw | ConvertFrom-Json
                    } else {
                        $null
                    }
                    if ($response.success -and $response.total -ge 1) {
                        Write-Host "SEARCH_READY backend=$($status.backend) query=$query total=$($response.total)"
                        return $true
                    }
                }
            }
        } catch {
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Test-TcpPortListening {
    param([int]$Port)

    if ($Port -le 0) {
        return $false
    }

    $client = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        if ($client) {
            $client.Dispose()
        }
    }
}

function Get-E2ETrackedPidProcesses {
    param([string[]]$PidFilters)

    $tracked = @()
    foreach ($pidFilter in $PidFilters) {
        Get-ChildItem -Path $tmpRoot -Filter $pidFilter -File -ErrorAction SilentlyContinue | ForEach-Object {
            $pidText = (Get-Content -Path $_.FullName -Raw -ErrorAction SilentlyContinue).Trim()
            $pidValue = 0
            if ([int]::TryParse($pidText, [ref]$pidValue) -and $pidValue -gt 0) {
                $proc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $pidValue) -ErrorAction SilentlyContinue
                if ($proc) {
                    $tracked += [pscustomobject]@{
                        ProcessId = [int]$proc.ProcessId
                        ParentProcessId = [int]$proc.ParentProcessId
                        Name = $proc.Name
                        CommandLine = $proc.CommandLine
                        PidFile = $_.FullName
                    }
                }
            }
        }
    }
    return $tracked
}

function Stop-E2ETrackedPidProcesses {
    param(
        [string[]]$PidFilters,
        [string]$Reason
    )

    foreach ($tracked in @(Get-E2ETrackedPidProcesses -PidFilters $PidFilters)) {
        Write-Host ("CLEAN {0} pid={1} name={2}" -f $Reason, $tracked.ProcessId, $tracked.Name)
        Stop-ProcessTree -ProcessId ([int]$tracked.ProcessId)
    }

    foreach ($pidFilter in $PidFilters) {
        Get-ChildItem -Path $tmpRoot -Filter $pidFilter -File -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-E2EResidualProcesses {
    $e2eNodePattern = 'scripts[\\/](e2e_chunk[123]|e2e_fresh_boot_smoke|e2e_visible_smoke)\.js'
    $tracked = @(Get-E2ETrackedPidProcesses -PidFilters @("e2e-node-*.pid", "e2e-browser-*.pid"))
    $patternMatches = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq "node.exe" -and $_.CommandLine -match $e2eNodePattern) -or
        ($_.CommandLine -match "playwright_chromiumdev_profile" -and $_.Name -in @(
            "chrome.exe",
            "chromium.exe",
            "chrome-headless-shell.exe",
            "chromium-headless-shell.exe"
        ))
    } | Select-Object ProcessId, ParentProcessId, Name, CommandLine)

    return @($tracked + $patternMatches) | Sort-Object ProcessId -Unique
}

function Test-E2EProcessCleanup {
    param([int]$ServerPort)

    $pidFiles = @()
    foreach ($pidFilter in @("e2e-server-*.pid", "e2e-node-*.pid", "e2e-browser-*.pid")) {
        $pidFiles += @(Get-ChildItem -Path $tmpRoot -Filter $pidFilter -File -ErrorAction SilentlyContinue)
    }

    $residualProcesses = @(Get-E2EResidualProcesses)
    $portListening = Test-TcpPortListening -Port $ServerPort
    return [pscustomobject]@{
        ok = ($pidFiles.Count -eq 0 -and $residualProcesses.Count -eq 0 -and -not $portListening)
        pidFiles = $pidFiles
        processes = $residualProcesses
        portListening = $portListening
    }
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
            if (-not $KeepServer -and $serverInfo -and $serverInfo.pid) {
                Stop-ProcessTree -ProcessId ([int]$serverInfo.pid)
            }
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
        -WindowStyle Hidden `
        -PassThru
    $script:E2ECurrentNodePid = $proc.Id
    $nodePidPath = Join-Path $tmpRoot ("e2e-node-{0}-{1}.pid" -f $sessionId, $name)
    Set-Content -Path $nodePidPath -Value ([string]$proc.Id) -Encoding ascii
    Start-E2EProcessWatchdog `
        -TargetProcessId $proc.Id `
        -PidFile $nodePidPath `
        -Reason ("e2e-node-{0}" -f $name) `
        -LogPath (Join-Path $outputDir ("{0}.watch.log" -f $name))

    $progressLineCount = 0
    $chunkStartedAt = Get-Date
    $doneSeen = $false
    $chunkFailedSeen = $false
    $chunkTimedOut = $false
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
                } elseif ($line.Contains('[FAIL]')) {
                    $chunkFailedSeen = $true
                }
            }
        }
        if ($doneSeen -and $doneGraceDeadline -and (Get-Date) -ge $doneGraceDeadline) {
            Write-Host "[$name] forcing process tree shutdown after DONE"
            Stop-ProcessTree -ProcessId $proc.Id
            break
        }
        if (((Get-Date) - $chunkStartedAt).TotalSeconds -ge $maxChunkSeconds) {
            Write-Host "[$name] chunk timeout ${maxChunkSeconds}s"
            Add-Content -Path $progressPath -Encoding UTF8 -Value "[FAIL] $name timeout ${maxChunkSeconds}s"
            $chunkTimedOut = $true
            Stop-ProcessTree -ProcessId $proc.Id
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
            } elseif ($line.Contains('[FAIL]')) {
                $chunkFailedSeen = $true
            }
        }
    }

    $progressText = if (Test-Path $progressPath) { Get-Content -Path $progressPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue } else { "" }
    $stdoutText = if (Test-Path $stdoutPath) { Get-Content -Path $stdoutPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue } else { "" }
    $stderrText = if (Test-Path $stderrPath) { Get-Content -Path $stderrPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue } else { "" }

    $exitCode = if ($proc.HasExited) { $proc.ExitCode } else { 1 }
    $progressHasFail = -not [string]::IsNullOrEmpty($progressText) -and $progressText.Contains('[FAIL]')
    $stdoutHasFail = -not [string]::IsNullOrEmpty($stdoutText) -and (
        $stdoutText.Contains('"status": "FAIL"') -or
        $stdoutText.Contains('"status":"FAIL"') -or
        ($stdoutText -match '"status"\s*:\s*"FAIL"')
    )
    $stderrHasCrash = -not [string]::IsNullOrEmpty($stderrText) -and (
        $stderrText.Contains('triggerUncaughtException') -or
        $stderrText.Contains('TimeoutError') -or
        ($stderrText -match '^\s*Error:|^\s*page\..+Timeout')
    )
    if ($chunkTimedOut) {
        $exitCode = 124
    } elseif ($chunkFailedSeen -or $progressHasFail -or $stdoutHasFail -or $stderrHasCrash) {
        $exitCode = 2
    } elseif (-not $doneSeen) {
        $exitCode = 2
    } elseif (-not $proc.HasExited -and $doneSeen) {
        $exitCode = 0
    }
    if ($exitCode -ne 0 -and (Test-Path $stderrPath)) {
        $stderrTail = Get-Content -Path $stderrPath -Encoding UTF8 -Tail 20 -ErrorAction SilentlyContinue
        foreach ($line in $stderrTail) {
            if ($line) {
                Write-Host "[$name][stderr] $line"
            }
        }
    }
    if ($exitCode -ne 0 -and [string]::IsNullOrWhiteSpace($progressText) -and [string]::IsNullOrWhiteSpace($stdoutText)) {
        Write-Host "[$name] failed before progress/stdout was written. stderr=$stderrPath stdout=$stdoutPath"
    }
    $chunkRecords = @(Get-ProgressRecords -OutputDir $outputDir | Where-Object { $_.log -eq ("{0}.progress.log" -f $name) })
    $chunkPassCount = @($chunkRecords | Where-Object { $_.status -eq "PASS" }).Count
    $chunkFailCount = @($chunkRecords | Where-Object { $_.status -eq "FAIL" }).Count
    $chunkStatus = if (
        -not $chunkTimedOut -and
        -not $chunkFailedSeen -and
        -not $progressHasFail -and
        -not $stdoutHasFail -and
        -not $stderrHasCrash -and
        $doneSeen -and
        $chunkRecords.Count -gt 0 -and
        $chunkFailCount -eq 0
    ) { "PASS" } else { "FAIL" }
    if ($chunkStatus -eq "PASS") {
        $exitCode = 0
    }
    $chunkElapsedSec = [Math]::Round(((Get-Date) - $chunkStartedAt).TotalSeconds, 1)
    Write-Host ("CHUNK_SUMMARY name={0} status={1} pass={2} fail={3} elapsedSec={4}" -f $name, $chunkStatus, $chunkPassCount, $chunkFailCount, $chunkElapsedSec)
    foreach ($record in $chunkRecords) {
        Write-Host ("CHUNK_RESULT_DETAIL name={0} [{1}] phase={2} title={3} {4}" -f $name, $record.status, $record.phase, $record.name, (Format-E2EDetailMetrics -Detail $record.detail))
    }
    if ($exitCode -ne 0 -and $overallExit -eq 0) {
        $overallExit = $exitCode
    }
    Remove-Item -Path $nodePidPath -Force -ErrorAction SilentlyContinue
    $script:E2ECurrentNodePid = $null
    Stop-E2ETrackedPidProcesses -PidFilters @("e2e-node-*.pid", "e2e-browser-*.pid") -Reason ("post-{0}" -f $name)
    & (Join-Path $PSScriptRoot "cleanup-e2e.ps1") -Quiet -SkipServers
    Start-Sleep -Seconds 2
}

if (-not $KeepServer -and $serverInfo -and $serverInfo.pid) {
    Write-Host "STOP E2E server pid=$($serverInfo.pid)"
    Stop-ProcessTree -ProcessId ([int]$serverInfo.pid)
    & (Join-Path $PSScriptRoot "cleanup-e2e.ps1") -Quiet
}

$cleanupCheck = Test-E2EProcessCleanup -ServerPort $port
if ($cleanupCheck.ok) {
    Write-Host "PROCESS_CLEANUP status=PASS"
} else {
    Write-Host ("PROCESS_CLEANUP status=FAIL pidFiles={0} processes={1} portListening={2}" -f $cleanupCheck.pidFiles.Count, $cleanupCheck.processes.Count, $cleanupCheck.portListening)
    foreach ($pidFile in $cleanupCheck.pidFiles) {
        Write-Host ("PROCESS_CLEANUP pidFile={0}" -f $pidFile.FullName)
    }
    foreach ($residual in $cleanupCheck.processes) {
        Write-Host ("PROCESS_CLEANUP process pid={0} name={1}" -f $residual.ProcessId, $residual.Name)
    }
    if ($overallExit -eq 0) {
        $overallExit = 3
    }
}

$summaryFiles = Write-E2ESummaryFiles `
    -OutputDir $outputDir `
    -SessionId $sessionId `
    -BaseUrl $baseUrl `
    -Chunk $Chunk `
    -Headless ([bool]$Headless) `
    -ExitCode $overallExit

try {
    $summaryObject = Get-Content -Path $summaryFiles.summary -Encoding UTF8 -Raw | ConvertFrom-Json
    Write-Host ("RESULT_SUMMARY status={0} pass={1} fail={2}" -f $summaryObject.status, $summaryObject.totals.pass, $summaryObject.totals.fail)
    foreach ($record in $summaryObject.records) {
        Write-Host ("RESULT [{0}] {1} {2}" -f $record.status, $record.phase, $record.name)
        Write-Host ("RESULT_DETAIL [{0}] phase={1} name={2} {3}" -f $record.status, $record.phase, $record.name, (Format-E2EDetailMetrics -Detail $record.detail))
    }
    if (Test-Path $summaryFiles.coldStart) {
        $coldObject = Get-Content -Path $summaryFiles.coldStart -Encoding UTF8 -Raw | ConvertFrom-Json
        $fqMedian = $null
        if ($coldObject.median -and ($coldObject.median.PSObject.Properties.Name -contains "fqLoadMs")) {
            $fqMedian = $coldObject.median.fqLoadMs
        }
        Write-Host ("PERF_SUMMARY coldStartStatus={0} strictCold={1} fqLoadMsMedian={2}" -f $coldObject.status, $coldObject.strictCold, $fqMedian)
    }
    foreach ($note in Get-E2EMetricNoteLines) {
        Write-Host ("METRIC_NOTE {0}" -f $note)
    }
} catch {
    Write-Host "WARN summary print failed: $($_.Exception.Message)"
}

Write-Host "SESSION:$sessionId"
Write-Host "BASE_URL:$baseUrl"
Write-Host "OUTPUT_DIR:$outputDir"
Write-Host "SUMMARY:$($summaryFiles.summary)"
Write-Host "COLD_START_SUMMARY:$($summaryFiles.coldStart)"
Write-Host "REPORT:$($summaryFiles.report)"
exit $overallExit
