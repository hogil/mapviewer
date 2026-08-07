[CmdletBinding()]
param(
    [ValidateSet("once", "hourly-until-clean")]
    [string]$Mode = "once",
    [switch]$PlanOnly,
    [switch]$SkipBrowser,
    [string]$ConfigPath = "",
    [string]$OutputRoot = "",
    [string]$ExistingE2EReportPath = "",
    [int]$ExistingE2EExitCode = -1
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot "e2e-agent-config.json"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Agent config not found: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot ".codex-tmp/e2e-agent-cycles"
}
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

function Get-RoleModels {
    param([object]$Role)

    $raw = [Environment]::GetEnvironmentVariable([string]$Role.model_env)
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        $models = @($raw -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    } else {
        $models = @($Role.default_models | ForEach-Object { [string]$_ })
    }
    $required = [int]$Role.count
    if ($models.Count -lt $required) {
        throw "Role $($Role.provider)/$($Role.model_env) requires $required model slots, got $($models.Count)."
    }
    return $models[0..($required - 1)]
}

function Invoke-ReadOnlyAgent {
    param(
        [string]$RoleName,
        [string]$Provider,
        [string]$Model,
        [string]$Prompt,
        [string]$OutputPath
    )

    $started = Get-Date
    $exitCode = 1
    $stdout = ""
    $command = ""
    try {
        if ($Provider -eq "claude") {
            $command = "claude -p --model $Model --permission-mode plan --strict-mcp-config --tools Read,Glob,Grep"
            $args = @(
                "-p", $Prompt,
                "--model", $Model,
                "--permission-mode", "plan",
                "--strict-mcp-config",
                "--tools", "Read,Glob,Grep",
                "--no-session-persistence",
                "--output-format", "text"
            )
            $stdout = (& claude @args 2>&1 | Out-String)
            $exitCode = $LASTEXITCODE
        } elseif ($Provider -eq "codex") {
            $command = "codex exec --sandbox read-only --ask-for-approval never --model $Model"
            $args = @(
                "exec", "-C", $repoRoot,
                "--sandbox", "read-only",
                "--ask-for-approval", "never",
                "--model", $Model,
                $Prompt
            )
            $stdout = (& codex @args 2>&1 | Out-String)
            $exitCode = $LASTEXITCODE
        } else {
            throw "Unsupported agent provider: $Provider"
        }
    } catch {
        $stdout = "agent invocation failed: $($_.Exception.Message)"
        $exitCode = 1
    }

    $record = @(
        "role=$RoleName",
        "provider=$Provider",
        "model=$Model",
        "started=$($started.ToString('o'))",
        "exit_code=$exitCode",
        "command=$command",
        "",
        $stdout
    ) -join [Environment]::NewLine
    Set-Content -LiteralPath $OutputPath -Value $record -Encoding UTF8
    return [pscustomobject]@{
        role = $RoleName
        provider = $Provider
        model = $Model
        exit_code = $exitCode
        output = $OutputPath
    }
}

function Write-DeterministicEvidence {
    param(
        [string]$CycleDir,
        [int]$E2EExitCode,
        [string]$E2ELogPath,
        [bool]$BrowserSkipped
    )

    $status = git status --short --branch | Out-String
    $diffStat = git diff --stat | Out-String
    $checkSpecs = @(
        @{ name = "py_compile"; executable = "python"; args = @("-m", "py_compile", "api/composite_map.py", "api/full_app.py"); command = "python -m py_compile api/composite_map.py api/full_app.py" },
        @{ name = "node_main"; executable = "node"; args = @("--check", "js/main.js"); command = "node --check js/main.js" },
        @{ name = "node_chunk1"; executable = "node"; args = @("--check", "scripts/e2e_chunk1.js"); command = "node --check scripts/e2e_chunk1.js" },
        @{ name = "node_chunk2"; executable = "node"; args = @("--check", "scripts/e2e_chunk2.js"); command = "node --check scripts/e2e_chunk2.js" }
    )
    $checks = @()
    foreach ($spec in $checkSpecs) {
        $output = ""
        $exitCode = 1
        try {
            $executable = [string]$spec.executable
            $checkArgs = [string[]]$spec.args
            $output = (& $executable @checkArgs 2>&1 | Out-String)
            $exitCode = [int]$LASTEXITCODE
        } catch {
            $output = $_.Exception.Message
            $exitCode = 1
        }
        $checks += [pscustomobject]@{
            name = [string]$spec.name
            command = [string]$spec.command
            exit_code = $exitCode
            passed = ($exitCode -eq 0)
            output = $output.Trim()
        }
    }
    $checksPassed = @($checks | Where-Object { -not $_.passed }).Count -eq 0
    $e2eTail = if (Test-Path -LiteralPath $E2ELogPath) {
        Get-Content -LiteralPath $E2ELogPath -Tail 80 | Out-String
    } else {
        "E2E log not created."
    }
    $evidence = @(
        "# E2E agent evidence",
        "",
        "cycle_dir=$CycleDir",
        "e2e_exit_code=$E2EExitCode",
        "browser_skipped=$BrowserSkipped",
        "",
        "## git status",
        $status,
        "## diff stat",
        $diffStat,
        "## required deterministic checks",
        (($checks | ForEach-Object {
            $status = if ($_.passed) { "PASS" } else { "FAIL" }
            "[{0}] {1} exit_code={2}`n{3}" -f $status, $_.command, $_.exit_code, $_.output
        }) -join ([Environment]::NewLine + [Environment]::NewLine)),
        "",
        "## E2E log tail",
        $e2eTail
    ) -join [Environment]::NewLine
    $path = Join-Path $CycleDir "evidence.md"
    Set-Content -LiteralPath $path -Value $evidence -Encoding UTF8
    $checks | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $CycleDir "deterministic-checks.json") -Encoding UTF8
    return [pscustomobject]@{
        path = $path
        passed = $checksPassed
    }
}

function Get-AgentPrompt {
    param([string]$RoleName, [string]$EvidencePath, [string[]]$RelatedPaths)

    $related = if ($RelatedPaths.Count -gt 0) { $RelatedPaths -join ", " } else { "none" }
    switch ($RoleName) {
        "scout" {
            return @"
You are the low-cost evidence scout for the L3 Tracker repository.
Read-only task. Do not edit files, run git write commands, or claim a test passed without evidence.
Read the evidence file at $EvidencePath and the related files: $related.
Extract concrete PASS/FAIL signals, changed files, missing verification, and the first actionable failure.
Return a compact report with sections: facts, failures, risks, next_check.
"@
        }
        "planner" {
            return @"
You are one of three independent high-quality planning agents reviewing an L3 Tracker change.
Read-only task. Do not edit files. Inspect the evidence at $EvidencePath and related files: $related.
Plan the smallest verification or correction needed for the requested multi-Shot/multi-Chip Composite and export behavior.
Check canonical Shot shape, chip counts, positions canvas, UI request payload, Shot/Chip TSV fields, and regression scope.
Return a concrete plan with acceptance checks and stop conditions. Do not mark PASS from state flags alone.
"@
        }
        "reviewer" {
            return @"
You are one of three independent high-quality judge agents for an L3 Tracker E2E result.
Read-only task. Inspect the evidence at $EvidencePath and related plan/review files: $related.
Score the implementation from 0 to 100. Verify actual Playwright/API evidence for multi-Shot canonical output, multi-Chip output,
Shot/Chip context-menu export, requested columns, and regression tests. Identify any unsupported claim or missing test.
Return JSON-like fields: verdict (PASS/FAIL/RECHECK), score, evidence, blocking_findings, required_recheck.
"@
        }
        "master" {
            return @"
You are the rotating master agent for the L3 Tracker E2E cycle.
Read-only task. Inspect the evidence at $EvidencePath and all related planner/reviewer files: $related.
Resolve disagreements by requiring concrete test evidence. The change is clean only when deterministic E2E exit is 0,
the required UI/API/export contracts are covered, and no reviewer has a blocking finding.
Return a final JSON-like decision with status (PASS/FAIL), score, reasons, and whether the hourly cycle should stop.
Do not suggest ignoring failures or relaxing timeouts.
"@
        }
    }
    throw "Unknown role: $RoleName"
}

function Invoke-Cycle {
    param([int]$CycleIndex)

    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssZ")
    $cycleDir = Join-Path $OutputRoot ("cycle-{0}-{1}" -f $stamp, $CycleIndex)
    New-Item -ItemType Directory -Path $cycleDir -Force | Out-Null
    $e2eLogPath = Join-Path $cycleDir "e2e-run.log"
    $e2eExitCode = 0
    $browserSkipped = [bool]$SkipBrowser

    if (-not [string]::IsNullOrWhiteSpace($ExistingE2EReportPath)) {
        if (-not (Test-Path -LiteralPath $ExistingE2EReportPath)) {
            throw "Existing E2E report not found: $ExistingE2EReportPath"
        }
        Copy-Item -LiteralPath $ExistingE2EReportPath -Destination $e2eLogPath -Force
        if ($ExistingE2EExitCode -ge 0) {
            $e2eExitCode = $ExistingE2EExitCode
        } else {
            $existingText = Get-Content -LiteralPath $ExistingE2EReportPath -Raw
            $e2eExitCode = if ($existingText -match '(?i)\[FAIL\]|RESULT_SUMMARY\s+status=FAIL') { 1 } else { 0 }
        }
        $browserSkipped = $false
    } elseif (-not $SkipBrowser -and -not $PlanOnly) {
        $runner = Join-Path $PSScriptRoot "run-e2e-playwright.ps1"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -Chunk all -Headless *>&1 |
            Tee-Object -FilePath $e2eLogPath
        $e2eExitCode = $LASTEXITCODE
    } elseif ($SkipBrowser) {
        Set-Content -LiteralPath $e2eLogPath -Value "browser lane skipped by caller" -Encoding UTF8
        $e2eExitCode = 2
    } else {
        Set-Content -LiteralPath $e2eLogPath -Value "plan-only: browser lane not executed" -Encoding UTF8
        $e2eExitCode = 2
    }

    $evidenceResult = Write-DeterministicEvidence -CycleDir $cycleDir -E2EExitCode $e2eExitCode -E2ELogPath $e2eLogPath -BrowserSkipped $browserSkipped
    $evidencePath = [string]$evidenceResult.path
    $deterministicChecksPassed = [bool]$evidenceResult.passed
    $outputs = @()

    if (-not $PlanOnly) {
        foreach ($roleName in @("scout", "planner")) {
            $role = $config.roles.$roleName
            $models = @(Get-RoleModels -Role $role)
            for ($i = 0; $i -lt $models.Count; $i++) {
                $outputPath = Join-Path $cycleDir ("{0}-{1}.txt" -f $roleName, ($i + 1))
                $related = @($evidencePath)
                $result = Invoke-ReadOnlyAgent -RoleName $roleName -Provider ([string]$role.provider) -Model $models[$i] -Prompt (Get-AgentPrompt -RoleName $roleName -EvidencePath $evidencePath -RelatedPaths $related) -OutputPath $outputPath
                $outputs += $result
            }
        }

        $plannerPaths = @($outputs | Where-Object { $_.role -eq "planner" } | ForEach-Object { $_.output })
        $reviewerRole = $config.roles.reviewer
        foreach ($model in @(Get-RoleModels -Role $reviewerRole)) {
            $outputPath = Join-Path $cycleDir ("reviewer-{0}.txt" -f ($outputs.Count + 1))
            $related = @($evidencePath) + $plannerPaths
            $result = Invoke-ReadOnlyAgent -RoleName "reviewer" -Provider ([string]$reviewerRole.provider) -Model $model -Prompt (Get-AgentPrompt -RoleName "reviewer" -EvidencePath $evidencePath -RelatedPaths $related) -OutputPath $outputPath
            $outputs += $result
        }

        $reviewPaths = @($outputs | Where-Object { $_.role -eq "reviewer" } | ForEach-Object { $_.output })
        $masterRole = $config.roles.master
        $masterModels = @(Get-RoleModels -Role $masterRole)
        $masterModel = $masterModels[$CycleIndex % $masterModels.Count]
        $masterPath = Join-Path $cycleDir "master.txt"
        $related = @($evidencePath) + $plannerPaths + $reviewPaths
        $masterResult = Invoke-ReadOnlyAgent -RoleName "master" -Provider ([string]$masterRole.provider) -Model $masterModel -Prompt (Get-AgentPrompt -RoleName "master" -EvidencePath $evidencePath -RelatedPaths $related) -OutputPath $masterPath
        $outputs += $masterResult
    } else {
        Set-Content -LiteralPath (Join-Path $cycleDir "PLAN_ONLY.txt") -Value @"
Roles configured: scout 1 cheap, planner 3 top, reviewer 3 top, master 3 top rotating one per cycle.
Browser lane: run-e2e-playwright.ps1 -Chunk all -Headless.
Stop condition: E2E exit 0 and master PASS; hourly mode stops immediately when clean.
"@ -Encoding UTF8
    }

    $agentFailures = @($outputs | Where-Object { $_.exit_code -ne 0 })
    $masterText = if (Test-Path -LiteralPath (Join-Path $cycleDir "master.txt")) {
        Get-Content -LiteralPath (Join-Path $cycleDir "master.txt") -Raw
    } else { "" }
    $masterPass = $masterText -match '(?i)status\s*[:=]\s*["'']?PASS' -and $masterText -notmatch '(?i)status\s*[:=]\s*["'']?FAIL'
    $clean = (-not $PlanOnly) -and $e2eExitCode -eq 0 -and $deterministicChecksPassed -and $agentFailures.Count -eq 0 -and $masterPass
    $summary = [pscustomobject]@{
        cycle = $CycleIndex
        directory = $cycleDir
        e2e_exit_code = $e2eExitCode
        deterministic_checks_passed = $deterministicChecksPassed
        agent_failure_count = $agentFailures.Count
        master_pass = $masterPass
        clean = $clean
        outputs = @($outputs)
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $cycleDir "cycle-summary.json") -Encoding UTF8
    Write-Host ("AGENT_CYCLE cycle={0} clean={1} e2e_exit={2} agent_failures={3} output={4}" -f $CycleIndex, $clean, $e2eExitCode, $agentFailures.Count, $cycleDir)
    return $summary
}

$cycle = 0
do {
    $summary = Invoke-Cycle -CycleIndex $cycle
    if ($Mode -eq "once" -or $summary.clean -or $PlanOnly) {
        break
    }
    Write-Host ("AGENT_CYCLE waiting_minutes={0} reason=not-clean" -f [int]$config.interval_minutes)
    Start-Sleep -Seconds ([int]$config.interval_minutes * 60)
    $cycle++
} while ($true)

if ($summary.clean) {
    Write-Host "AGENT_CYCLE_STOP reason=clean"
    exit 0
}
if ($PlanOnly) {
    exit 0
}
exit 1
