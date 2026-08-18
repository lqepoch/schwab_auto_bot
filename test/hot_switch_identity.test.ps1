Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/hot-switch-identity.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw "ASSERT_TRUE_FAILED: $Message" }
}

function Assert-False {
  param([bool]$Value, [string]$Message)
  if ($Value) { throw "ASSERT_FALSE_FAILED: $Message" }
}

$workspace = Join-Path ([System.IO.Path]::GetTempPath()) 'schwab-hot-switch-workspace'
$nodePath = Join-Path $workspace 'runtime/node'
$sourceEntry = Join-Path $workspace 'src/main.ts'
$distEntry = Join-Path $workspace 'dist/main.js'

Assert-True (Test-HotSwitchApprovedRuntimeEntry -Workspace $workspace -EntryPath $sourceEntry) 'source runtime entry must be approved'
Assert-True (Test-HotSwitchApprovedRuntimeEntry -Workspace $workspace -EntryPath $distEntry) 'dist runtime entry must be approved'
Assert-False (Test-HotSwitchApprovedRuntimeEntry -Workspace $workspace -EntryPath (Join-Path $workspace 'src/automation/cli.ts')) 'CLI entry is a launch identity, not persisted runtime replacement entry'
Assert-False (Test-HotSwitchApprovedRuntimeEntry -Workspace $workspace -EntryPath (Join-Path $workspace 'other.ts')) 'arbitrary entry must be rejected'

$sourceCli = [pscustomobject]@{
  ExecutablePath = $nodePath
  CommandLine = "`"$nodePath`" src/automation/cli.ts --confirm-live I_UNDERSTAND"
}
Assert-True (Test-HotSwitchProcessIdentity -ProcessDetails $sourceCli -Workspace $workspace -NodePath $nodePath -EntryPath $sourceEntry) 'npm/start source CLI must identify as the bot process'

$sourceMain = [pscustomobject]@{
  ExecutablePath = $nodePath
  CommandLine = "`"$nodePath`" `"$sourceEntry`" --read-only"
}
Assert-True (Test-HotSwitchProcessIdentity -ProcessDetails $sourceMain -Workspace $workspace -NodePath $nodePath -EntryPath $sourceEntry) 'hot-switch source replacement must identify as the bot process'

$distCli = [pscustomobject]@{
  ExecutablePath = $nodePath
  CommandLine = "`"$nodePath`" ./dist/automation/cli.js --read-only"
}
Assert-True (Test-HotSwitchProcessIdentity -ProcessDetails $distCli -Workspace $workspace -NodePath $nodePath -EntryPath $distEntry) 'compiled CLI must identify as the bot process'

$nearMiss = [pscustomobject]@{
  ExecutablePath = $nodePath
  CommandLine = "`"$nodePath`" src/automation/cli.ts.evil --read-only"
}
Assert-False (Test-HotSwitchProcessIdentity -ProcessDetails $nearMiss -Workspace $workspace -NodePath $nodePath -EntryPath $sourceEntry) 'path prefix near-miss must not pass token boundaries'

$wrongExecutable = [pscustomobject]@{
  ExecutablePath = Join-Path $workspace 'runtime/other-node'
  CommandLine = "node src/automation/cli.ts --read-only"
}
Assert-False (Test-HotSwitchProcessIdentity -ProcessDetails $wrongExecutable -Workspace $workspace -NodePath $nodePath -EntryPath $sourceEntry) 'PID reuse by another executable must be rejected'

$unrelatedCommand = [pscustomobject]@{
  ExecutablePath = $nodePath
  CommandLine = "`"$nodePath`" unrelated.js src/automation/cli.ts.evil"
}
Assert-False (Test-HotSwitchProcessIdentity -ProcessDetails $unrelatedCommand -Workspace $workspace -NodePath $nodePath -EntryPath $sourceEntry) 'unrelated node command must be rejected'

$active = [pscustomobject]@{ pid = 1234; runId = 'run-current' }
$matchingLock = [pscustomobject]@{ schemaVersion = 1; pid = 1234; runId = 'run-current'; ownerId = 'owner-current' }
Assert-True (Test-HotSwitchRuntimeLockMatchesState -LockRecord $matchingLock -ActiveState $active) 'runtime lock must bind process pid and run id'
Assert-False (Test-HotSwitchRuntimeLockMatchesState -LockRecord ([pscustomobject]@{ schemaVersion = 1; pid = 1234; runId = 'other-run'; ownerId = 'owner-current' }) -ActiveState $active) 'run id mismatch must fail'
Assert-False (Test-HotSwitchRuntimeLockMatchesState -LockRecord ([pscustomobject]@{ schemaVersion = 1; pid = 9999; runId = 'run-current'; ownerId = 'owner-current' }) -ActiveState $active) 'pid mismatch must fail'
Assert-False (Test-HotSwitchRuntimeLockMatchesState -LockRecord ([pscustomobject]@{ schemaVersion = 1; pid = 1234; runId = 'run-current'; ownerId = '' }) -ActiveState $active) 'ownerless lock must fail'

Write-Output 'HOT_SWITCH_IDENTITY_TESTS_PASSED'
