[CmdletBinding()]
param(
  [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(5, 300)]
  [int]$TimeoutSeconds = 60,
  [switch]$StopOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$statePath = Join-Path $workspace ".state\runtime\active-run.json"
$controlPath = Join-Path $workspace ".state\runtime\control-request.json"

if ((git -C $workspace branch --show-current) -ne "main") {
  throw "HOT_SWITCH_REQUIRES_MAIN: merge and fast-forward the primary checkout before switching."
}
if (git -C $workspace status --porcelain) {
  throw "HOT_SWITCH_REQUIRES_CLEAN_MAIN: resolve or commit local changes before switching."
}
$buildId = (git -C $workspace rev-parse HEAD).Trim()

if (-not (Test-Path -LiteralPath $statePath)) {
  throw "ACTIVE_RUN_STATE_MISSING: start this bot version once before using hot-switch."
}

$active = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$active.nodePath) -or [string]::IsNullOrWhiteSpace([string]$active.entryPath)) {
  throw "ACTIVE_RUN_STATE_INVALID"
}
if ((Resolve-Path -LiteralPath ([string]$active.workspaceRoot)).Path -ne $workspace) {
  throw "ACTIVE_RUN_WORKSPACE_MISMATCH: refusing to replace a process from another workspace."
}

$oldProcess = Get-Process -Id ([int]$active.pid) -ErrorAction SilentlyContinue
if ($null -ne $oldProcess) {
  $processDetails = Get-CimInstance Win32_Process -Filter "ProcessId=$($oldProcess.Id)"
  if ($null -eq $processDetails -or $processDetails.CommandLine -notmatch "src[\\/]main\.ts") {
    throw "ACTIVE_RUN_PID_NOT_A_BOT_PROCESS: refusing to stop pid $($oldProcess.Id)."
  }
  $request = [ordered]@{
    command = $(if ($StopOnly) { "stop" } else { "stop-for-restart" })
    requestId = [guid]::NewGuid().ToString()
    requestedAt = [DateTime]::UtcNow.ToString("o")
    requestedBy = "scripts/hot-switch.ps1"
  } | ConvertTo-Json -Compress
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $controlPath) | Out-Null
  [System.IO.File]::WriteAllText($controlPath, $request, [System.Text.UTF8Encoding]::new($false))
  Write-Output "Requested controlled stop for pid $($oldProcess.Id)."

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($null -ne (Get-Process -Id $oldProcess.Id -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if ($null -ne (Get-Process -Id $oldProcess.Id -ErrorAction SilentlyContinue)) {
    throw "CONTROLLED_STOP_TIMEOUT: pid $($oldProcess.Id) is still running; no replacement was started."
  }
}

if ($StopOnly) {
  Write-Output "Bot stopped without replacement."
  exit 0
}

if (-not (Test-Path -LiteralPath ([string]$active.nodePath)) -or -not (Test-Path -LiteralPath ([string]$active.entryPath))) {
  throw "ACTIVE_RUN_EXECUTABLE_OR_ENTRY_MISSING"
}

$runtimeDirectory = Join-Path $workspace ".state\runtime"
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$stdout = Join-Path $runtimeDirectory "hot-switch-$stamp.stdout.log"
$stderr = Join-Path $runtimeDirectory "hot-switch-$stamp.stderr.log"
$arguments = @([string]$active.entryPath) + @($active.args | ForEach-Object { [string]$_ })
$previousBuildId = $env:SCHWAB_BOT_BUILD_ID
$env:SCHWAB_BOT_BUILD_ID = $buildId
try {
  $replacement = Start-Process -FilePath ([string]$active.nodePath) -ArgumentList $arguments -WorkingDirectory $workspace `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
} finally {
  if ($null -eq $previousBuildId) {
    Remove-Item Env:SCHWAB_BOT_BUILD_ID
  } else {
    $env:SCHWAB_BOT_BUILD_ID = $previousBuildId
  }
}

Write-Output "Started replacement pid $($replacement.Id). stdout=$stdout stderr=$stderr"
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
  $current = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ([int]$current.pid -eq $replacement.Id -and [string]$current.state -eq "running") {
    Write-Output "Hot switch completed. runId=$($current.runId) journal=$($current.journalPath)"
    exit 0
  }
  if ($null -eq (Get-Process -Id $replacement.Id -ErrorAction SilentlyContinue)) {
    throw "REPLACEMENT_EXITED_EARLY: inspect $stderr"
  }
  Start-Sleep -Milliseconds 250
}

throw "REPLACEMENT_START_TIMEOUT: inspect $stderr"
