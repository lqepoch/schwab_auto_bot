[CmdletBinding()]
param(
  [string]$WorkspaceRoot,
  [ValidateRange(5, 300)]
  [int]$TimeoutSeconds = 60,
  [switch]$StopOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "hot-switch-identity.ps1")

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  $WorkspaceRoot = Split-Path -Parent $PSScriptRoot
}

$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$statePath = Join-Path $workspace ".state\runtime\active-run.json"
$controlPath = Join-Path $workspace ".state\runtime\control-request.json"
$lockPath = Join-Path $workspace ".state\runtime\active-run.lock"

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

try {
  $active = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
} catch {
  throw "ACTIVE_RUN_STATE_INVALID: $($_.Exception.Message)"
}
$requiredStateProperties = @("pid", "runId", "workspaceRoot", "nodePath", "entryPath", "args")
foreach ($name in $requiredStateProperties) {
  if ($active.PSObject.Properties.Name -notcontains $name) {
    throw "ACTIVE_RUN_STATE_INVALID: missing $name"
  }
}
if (
  [int]$active.pid -le 0 -or
  [string]::IsNullOrWhiteSpace([string]$active.runId) -or
  [string]::IsNullOrWhiteSpace([string]$active.workspaceRoot) -or
  [string]::IsNullOrWhiteSpace([string]$active.nodePath) -or
  [string]::IsNullOrWhiteSpace([string]$active.entryPath)
) {
  throw "ACTIVE_RUN_STATE_INVALID"
}
if ((Resolve-Path -LiteralPath ([string]$active.workspaceRoot)).Path -ne $workspace) {
  throw "ACTIVE_RUN_WORKSPACE_MISMATCH: refusing to replace a process from another workspace."
}
if (-not (Test-HotSwitchApprovedNodeExecutable -NodePath ([string]$active.nodePath))) {
  throw "ACTIVE_RUN_NODE_EXECUTABLE_INVALID: only the Node.js runtime is eligible for hot-switch."
}
if (-not (Test-HotSwitchApprovedRuntimeEntry -Workspace $workspace -EntryPath ([string]$active.entryPath))) {
  throw "ACTIVE_RUN_ENTRY_NOT_APPROVED: refusing to execute an unrecognized runtime entry."
}

# Validate the replacement before stopping the current runtime. StopOnly keeps
# working even if a future deployment artifact is unavailable.
if (-not $StopOnly) {
  if (-not (Test-Path -LiteralPath ([string]$active.nodePath)) -or -not (Test-Path -LiteralPath ([string]$active.entryPath))) {
    throw "ACTIVE_RUN_EXECUTABLE_OR_ENTRY_MISSING"
  }
}

$oldProcess = Get-Process -Id ([int]$active.pid) -ErrorAction SilentlyContinue
$requestId = $null
if ($null -ne $oldProcess) {
  if (-not (Test-Path -LiteralPath $lockPath)) {
    throw "ACTIVE_RUN_LOCK_MISSING: refusing to signal a live pid without its runtime lock."
  }
  try {
    $runtimeLock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  } catch {
    throw "ACTIVE_RUN_LOCK_INVALID: $($_.Exception.Message)"
  }
  if (-not (Test-HotSwitchRuntimeLockMatchesState -LockRecord $runtimeLock -ActiveState $active)) {
    throw "ACTIVE_RUN_LOCK_MISMATCH: refusing to signal a pid whose runtime lock does not match active state."
  }

  $processDetails = Get-CimInstance Win32_Process -Filter "ProcessId=$($oldProcess.Id)"
  if (-not (Test-HotSwitchProcessIdentity `
    -ProcessDetails $processDetails `
    -Workspace $workspace `
    -NodePath ([string]$active.nodePath) `
    -EntryPath ([string]$active.entryPath))) {
    throw "ACTIVE_RUN_PID_NOT_A_BOT_PROCESS: refusing to stop pid $($oldProcess.Id)."
  }

  if (Test-Path -LiteralPath $controlPath) {
    throw "CONTROL_REQUEST_ALREADY_PENDING: inspect the existing operator request before writing another."
  }

  $requestId = [guid]::NewGuid().ToString()
  $request = [ordered]@{
    command = $(if ($StopOnly) { "stop" } else { "stop-for-restart" })
    requestId = $requestId
    requestedAt = [DateTime]::UtcNow.ToString("o")
    requestedBy = "scripts/hot-switch.ps1"
  } | ConvertTo-Json -Compress
  $controlDirectory = Split-Path -Parent $controlPath
  New-Item -ItemType Directory -Force -Path $controlDirectory | Out-Null
  $controlTemporaryPath = "$controlPath.$requestId.tmp"
  try {
    [System.IO.File]::WriteAllText($controlTemporaryPath, $request, [System.Text.UTF8Encoding]::new($false))
    try {
      # No -Force: a concurrent operator that won the destination path keeps
      # ownership. This invocation must not overwrite another stop request.
      Move-Item -LiteralPath $controlTemporaryPath -Destination $controlPath -ErrorAction Stop
    } catch {
      if (Test-Path -LiteralPath $controlPath) {
        throw "CONTROL_REQUEST_ALREADY_PENDING: another operator won the control-request race."
      }
      throw
    }
  } finally {
    Remove-Item -LiteralPath $controlTemporaryPath -Force -ErrorAction SilentlyContinue
  }
  Write-Output "Requested controlled stop for pid $($oldProcess.Id)."

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($null -ne (Get-Process -Id $oldProcess.Id -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if ($null -ne (Get-Process -Id $oldProcess.Id -ErrorAction SilentlyContinue)) {
    throw "CONTROLLED_STOP_TIMEOUT: pid $($oldProcess.Id) is still running; no replacement was started."
  }

  # If the process exited after our write but before consuming the request, a
  # leftover stop-for-restart file would immediately stop the replacement.
  if (Test-Path -LiteralPath $controlPath) {
    try {
      $remainingControl = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
    } catch {
      throw "CONTROL_REQUEST_LEFT_INVALID: process exited with an unreadable control request."
    }
    if ([string]$remainingControl.requestId -ne $requestId) {
      throw "CONTROL_REQUEST_OWNERSHIP_CHANGED: another operator request appeared during shutdown."
    }
    Remove-Item -LiteralPath $controlPath -Force
    Write-Output "Removed unconsumed control request $requestId after pid $($oldProcess.Id) exited."
  }
} elseif (-not $StopOnly -and (Test-Path -LiteralPath $controlPath)) {
  throw "STALE_CONTROL_REQUEST_PRESENT: inspect and clear the existing control request before starting a replacement."
}

if ($StopOnly) {
  Write-Output "Bot stopped without replacement."
  exit 0
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
    if ([string]$current.buildId -ne $buildId) {
      throw "REPLACEMENT_BUILD_ID_MISMATCH: expected=$buildId observed=$($current.buildId)"
    }
    Write-Output "Hot switch completed. runId=$($current.runId) journal=$($current.journalPath)"
    exit 0
  }
  if ($null -eq (Get-Process -Id $replacement.Id -ErrorAction SilentlyContinue)) {
    throw "REPLACEMENT_EXITED_EARLY: inspect $stderr"
  }
  Start-Sleep -Milliseconds 250
}

throw "REPLACEMENT_START_TIMEOUT: inspect $stderr"
