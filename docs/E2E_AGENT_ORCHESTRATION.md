# E2E Agent Orchestration

## Roles

The E2E result is produced by deterministic Playwright lanes first. LLM agents only inspect the resulting evidence and never replace the browser test.

- `scout`: one low-cost read-only agent extracts facts, failures, and missing evidence.
- `planner`: three independent high-tier agents propose the smallest verification or correction plan.
- `reviewer`: three independent high-tier judge agents score the implementation and check the data, UI request body, image dimensions, positions, and export fields.
- `master`: three high-tier master slots rotate one per cycle and issue the final PASS/FAIL decision. A cycle is clean only when the browser runner exits 0 and the master reports PASS.

The browser lane is `scripts/run-e2e-playwright.ps1 -Chunk all -Headless`. It remains deterministic because a language model should not be responsible for clicking arbitrary UI controls or deciding whether a bitmap is blank.

## Run

The default config uses Claude aliases (`sonnet` for the scout and `opus` for high-tier slots). Override model slots when the environment has different top models:

```powershell
$env:E2E_SCOUT_MODELS = "sonnet"
$env:E2E_PLANNER_MODELS = "opus,opus,opus"
$env:E2E_REVIEWER_MODELS = "opus,opus,opus"
$env:E2E_MASTER_MODELS = "opus,opus,opus"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-agent-cycle.ps1 -Mode once
```

When a deterministic full E2E session has already passed, the agent-only review can reuse its report without opening a browser or rerunning the browser lane:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-agent-cycle.ps1 `
  -Mode once `
  -ExistingE2EReportPath D:\project\mapviewer\.codex-tmp\e2e-sessions\<session>\e2e-report.txt `
  -ExistingE2EExitCode 0
```

For the requested hourly retry behavior, use `-Mode hourly-until-clean`. It stops as soon as the E2E lane and master decision are clean; it does not continue repeating after a clean result:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-agent-cycle.ps1 -Mode hourly-until-clean
```

Use `-PlanOnly` to validate the role layout without starting a browser or calling an LLM. Every cycle writes its evidence and agent outputs under the absolute path `D:\project\mapviewer\.codex-tmp\e2e-agent-cycles\cycle-<UTC>-<index>\`. Each cycle also executes and records `py_compile` plus the JavaScript `node --check` commands in `deterministic-checks.json`; a failed check prevents a clean decision.

## Stop and failure rules

- A deterministic E2E failure, an agent invocation failure, or a reviewer/master blocking finding is not treated as transient.
- Hourly mode waits 60 minutes only after a non-clean cycle, then starts a new fresh E2E session.
- Browser/test execution is always headless in this runner. No visible Chromium window is created.
- Read-only Claude reviewers run with `--strict-mcp-config`, so they do not start unrelated MCP browser/filesystem servers.
- The master must not declare PASS from a state flag alone. The evidence must include actual Playwright UI/API behavior and output data.
