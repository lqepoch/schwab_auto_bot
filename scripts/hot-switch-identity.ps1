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

function Test-HotSwitchCommandLineEntry {
  param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$CommandLine
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $normalizedCommandLine = $CommandLine.Replace('\', '/').ToLowerInvariant()
  $workspaceNormalized = ConvertTo-HotSwitchNormalizedPath -Path $Workspace -BasePath $Workspace

  $relativeEntries = @(
    'src/main.ts'
    'dist/main.js'
    'src/automation/cli.ts'
    'dist/automation/cli.js'
  )
  $candidates = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($relative in $relativeEntries) {
    [void]$candidates.Add($relative)
    [void]$candidates.Add("./$relative")
    [void]$candidates.Add("$workspaceNormalized/$relative")
  }

  foreach ($candidate in $candidates) {
    $escaped = [regex]::Escape($candidate)
    if ($normalizedCommandLine -match "(^|[\s`"'])$escaped($|[\s`"'])") {
      return $true
    }
  }
  return $false
}

function Test-HotSwitchProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]$ProcessDetails,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$EntryPath
  )

  if ($null -eq $ProcessDetails) { return $false }
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
  if ([int]$LockRecord.schemaVersion -ne 1) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$LockRecord.ownerId)) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$LockRecord.runId)) { return $false }
  if ([int]$LockRecord.pid -le 0) { return $false }
  return [int]$LockRecord.pid -eq [int]$ActiveState.pid -and [string]$LockRecord.runId -eq [string]$ActiveState.runId
}
