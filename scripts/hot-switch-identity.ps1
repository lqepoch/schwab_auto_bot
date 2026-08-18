Set-StrictMode -Version Latest

function ConvertTo-HotSwitchNormalizedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$BasePath
  )

  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $candidate = $Path
  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    $candidate = Join-Path $BasePath $candidate
  }
  return ([System.IO.Path]::GetFullPath($candidate).TrimEnd([char[]]@('\', '/')).Replace('\', '/')).ToLowerInvariant()
}

function Get-HotSwitchRuntimeEntryPaths {
  param([Parameter(Mandatory = $true)][string]$Workspace)
  return @(
    ConvertTo-HotSwitchNormalizedPath -Path 'src/main.ts' -BasePath $Workspace
    ConvertTo-HotSwitchNormalizedPath -Path 'dist/main.js' -BasePath $Workspace
  )
}

function Get-HotSwitchLaunchEntryPaths {
  param([Parameter(Mandatory = $true)][string]$Workspace)
  return @(
    ConvertTo-HotSwitchNormalizedPath -Path 'src/main.ts' -BasePath $Workspace
    ConvertTo-HotSwitchNormalizedPath -Path 'dist/main.js' -BasePath $Workspace
    ConvertTo-HotSwitchNormalizedPath -Path 'src/automation/cli.ts' -BasePath $Workspace
    ConvertTo-HotSwitchNormalizedPath -Path 'dist/automation/cli.js' -BasePath $Workspace
  )
}

function Test-HotSwitchApprovedRuntimeEntry {
  param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$EntryPath
  )

  $normalized = ConvertTo-HotSwitchNormalizedPath -Path $EntryPath -BasePath $Workspace
  return (Get-HotSwitchRuntimeEntryPaths -Workspace $Workspace) -contains $normalized
}

function Test-HotSwitchApprovedNodeExecutable {
  param([Parameter(Mandatory = $true)][string]$NodePath)
  if ([string]::IsNullOrWhiteSpace($NodePath)) { return $false }
  $leaf = [System.IO.Path]::GetFileName($NodePath).ToLowerInvariant()
  return $leaf -eq 'node' -or $leaf -eq 'node.exe'
}

function Get-HotSwitchCommandLineTokens {
  param([Parameter(Mandatory = $true)][string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }

  $tokens = @()
  $matches = [regex]::Matches($CommandLine, '"([^"]*)"|''([^'']*)''|(\S+)')
  foreach ($match in $matches) {
    if ($match.Groups[1].Success) {
      $tokens += $match.Groups[1].Value
    } elseif ($match.Groups[2].Success) {
      $tokens += $match.Groups[2].Value
    } else {
      $tokens += $match.Groups[3].Value
    }
  }
  return $tokens
}

function Test-HotSwitchCommandLineEntry {
  param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$CommandLine
  )

  $tokens = @(Get-HotSwitchCommandLineTokens -CommandLine $CommandLine)
  if ($tokens.Count -lt 2) { return $false }

  # The supported bot launch contract invokes Node with the entry script as the
  # first argument. An approved path appearing later as arbitrary user data does
  # not establish process identity.
  $entry = ConvertTo-HotSwitchNormalizedPath -Path ([string]$tokens[1]) -BasePath $Workspace
  return (Get-HotSwitchLaunchEntryPaths -Workspace $Workspace) -contains $entry
}

function Test-HotSwitchProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]$ProcessDetails,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$EntryPath
  )

  if ($null -eq $ProcessDetails) { return $false }
  $processProperties = @($ProcessDetails.PSObject.Properties.Name)
  if ($processProperties -notcontains 'ExecutablePath' -or $processProperties -notcontains 'CommandLine') { return $false }
  if (-not (Test-HotSwitchApprovedNodeExecutable -NodePath $NodePath)) { return $false }
  if (-not (Test-HotSwitchApprovedRuntimeEntry -Workspace $Workspace -EntryPath $EntryPath)) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$ProcessDetails.ExecutablePath)) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$ProcessDetails.CommandLine)) { return $false }

  $expectedNode = ConvertTo-HotSwitchNormalizedPath -Path $NodePath -BasePath $Workspace
  $observedNode = ConvertTo-HotSwitchNormalizedPath -Path ([string]$ProcessDetails.ExecutablePath) -BasePath $Workspace
  if ($expectedNode -ne $observedNode) { return $false }

  return Test-HotSwitchCommandLineEntry -Workspace $Workspace -CommandLine ([string]$ProcessDetails.CommandLine)
}

function Test-HotSwitchRuntimeLockMatchesState {
  param(
    [Parameter(Mandatory = $true)]$LockRecord,
    [Parameter(Mandatory = $true)]$ActiveState
  )

  if ($null -eq $LockRecord -or $null -eq $ActiveState) { return $false }
  $lockProperties = @($LockRecord.PSObject.Properties.Name)
  $stateProperties = @($ActiveState.PSObject.Properties.Name)
  foreach ($name in @('schemaVersion', 'pid', 'runId', 'ownerId')) {
    if ($lockProperties -notcontains $name) { return $false }
  }
  foreach ($name in @('pid', 'runId')) {
    if ($stateProperties -notcontains $name) { return $false }
  }
  if ([int]$LockRecord.schemaVersion -ne 1) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$LockRecord.ownerId)) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$LockRecord.runId)) { return $false }
  if ([int]$LockRecord.pid -le 0) { return $false }
  return [int]$LockRecord.pid -eq [int]$ActiveState.pid -and [string]$LockRecord.runId -eq [string]$ActiveState.runId
}
