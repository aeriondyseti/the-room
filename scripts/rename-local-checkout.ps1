# Run from X:\Development in a fresh PowerShell after closing Codex, Claude Code
# sessions using this checkout, and the room TUI:
# pwsh -NoProfile -File .\vibe-pairing\scripts\rename-local-checkout.ps1
# Use -Plan to inspect the migration without changing anything.
[CmdletBinding()]
param([switch]$Plan)

$ErrorActionPreference = 'Stop'
$old = 'X:\Development\vibe-pairing'
$new = 'X:\Development\the-room'
$parent = [IO.Path]::GetFullPath('X:\Development').TrimEnd('\')
$old = [IO.Path]::GetFullPath($old).TrimEnd('\')
$new = [IO.Path]::GetFullPath($new).TrimEnd('\')
if ((Split-Path -Parent $old) -ne $parent -or (Split-Path -Parent $new) -ne $parent) {
  throw 'The source and destination must be direct children of X:\Development.'
}
$cwd = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\')
if ($cwd.Equals($old, [StringComparison]::OrdinalIgnoreCase) -or
    $cwd.StartsWith($old + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Run this script from X:\Development, outside the directory being renamed.'
}
$oldExists = Test-Path -LiteralPath $old -PathType Container
$newExists = Test-Path -LiteralPath $new -PathType Container
if ($oldExists -eq $newExists) {
  throw 'Expected exactly one of X:\Development\vibe-pairing and X:\Development\the-room to exist.'
}
if ($oldExists -and ((Get-Item -LiteralPath $old).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'The source is a reparse point; refusing to rename it.'
}
$repo = if ($oldExists) { $old } else { $new }
$branch = & git -C $repo branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw 'The checkout must be on main.' }
$origin = & git -C $repo remote get-url origin
if ($LASTEXITCODE -ne 0 -or $origin -notmatch 'github\.com[:/]aeriondyseti/the-room(\.git)?$') {
  throw 'The checkout does not have the expected GitHub origin.'
}
$porcelain = & git -C $repo worktree list --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Cannot list linked worktrees.' }
$movedWorktrees = [System.Collections.Generic.List[string]]::new()
$oldPrefix = $old + '\'
foreach ($line in $porcelain) {
  if (-not $line.StartsWith('worktree ')) { continue }
  $path = $line.Substring(9).Replace('/', '\')
  if (-not $path.StartsWith($oldPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
  $relative = $path.Substring($oldPrefix.Length)
  $mapped = [IO.Path]::GetFullPath((Join-Path $new $relative))
  if (-not $mapped.StartsWith($new + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unexpected worktree path: $path"
  }
  $movedWorktrees.Add($mapped)
}
$globalRoot = (& npm root --global | Select-Object -Last 1).Trim()
$globalPrefix = (& npm prefix --global | Select-Object -Last 1).Trim()
if ([IO.Path]::GetFullPath($globalRoot) -ne [IO.Path]::GetFullPath((Join-Path $globalPrefix 'node_modules'))) {
  throw 'Unexpected global npm root; refusing to change links.'
}
$oldLinkPath = Join-Path $globalRoot 'vibe-pairing'
$newLinkPath = Join-Path $globalRoot 'the-room'
$oldLink = Get-Item -LiteralPath $oldLinkPath -Force -ErrorAction SilentlyContinue
$newLink = Get-Item -LiteralPath $newLinkPath -Force -ErrorAction SilentlyContinue
if ($oldLink -and ($oldLink.LinkType -ne 'Junction' -or
    -not ([string]@($oldLink.Target)[0]).Equals($old, [StringComparison]::OrdinalIgnoreCase))) {
  throw 'The existing vibe-pairing npm entry is not the expected junction.'
}
if ($newLink -and ($newLink.LinkType -ne 'Junction' -or
    -not ([string]@($newLink.Target)[0]).Equals($new, [StringComparison]::OrdinalIgnoreCase))) {
  throw 'An unrelated the-room global npm entry already exists.'
}
foreach ($name in @('room', 'room.cmd', 'room.ps1')) {
  $shim = Join-Path $globalPrefix $name
  if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) { continue }
  $shimText = [IO.File]::ReadAllText($shim)
  if ($shimText -notmatch 'node_modules[/\\](vibe-pairing|the-room)[/\\]dist[/\\]cli[/\\]main\.js') {
    throw "An unrelated global room command already exists: $shim"
  }
}
Write-Host "Checkout: $repo -> $new"
Write-Host "Linked worktrees to repair: $($movedWorktrees.Count)"
Write-Host 'Codex and Claude room MCP paths and the global npm link will be updated.'
if ($Plan) { return }

function Replace-LiteralInFile([string]$path, [string]$before, [string]$after) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing configuration: $path" }
  $content = [IO.File]::ReadAllText($path)
  if (-not $content.Contains($before)) {
    if (-not $content.Contains($after)) { throw "Expected path not found in $path" }
    return
  }
  $updated = $content.Replace($before, $after)
  if ($path.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) {
    $null = $updated | ConvertFrom-Json
  }
  $temporary = $path + '.the-room-migration.tmp'
  if (Test-Path -LiteralPath $temporary) { throw "Temporary file already exists: $temporary" }
  try {
    [IO.File]::WriteAllText($temporary, $updated, [Text.UTF8Encoding]::new($false))
    [IO.File]::Replace($temporary, $path, $null)
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

if ($oldExists) {
  $serviceLock = Join-Path $old '.room\service.lock'
  if (Test-Path -LiteralPath $serviceLock -PathType Leaf) {
    $owner = [IO.File]::ReadAllText($serviceLock) | ConvertFrom-Json
    if ([string]$owner.pid -notmatch '^[0-9]+$') { throw 'The room service lock has no valid PID.' }
    $servicePid = [int]$owner.pid
    $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid"
    if ($serviceProcess) {
      $expectedScript = Join-Path $old 'dist\core\service\main.js'
      if ($serviceProcess.Name -ne 'node.exe' -or
          ([string]$serviceProcess.CommandLine).IndexOf($expectedScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'The room service lock PID belongs to an unexpected process; inspect it before moving.'
      }
      Write-Host "Shutting down room service PID $servicePid"
      $previousRoomRoot = $env:ROOM_ROOT
      try {
        $env:ROOM_ROOT = $old
        & node (Join-Path $old 'dist\cli\main.js') shutdown --json | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Room service did not confirm shutdown.' }
      } finally {
        $env:ROOM_ROOT = $previousRoomRoot
      }
      $deadline = [DateTime]::UtcNow.AddSeconds(15)
      while ((Get-Process -Id $servicePid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
      }
      if (Get-Process -Id $servicePid -ErrorAction SilentlyContinue) {
        throw 'Room service has not exited; close the TUI and rerun the script.'
      }
    }
  }
  try {
    Rename-Item -LiteralPath $old -NewName 'the-room'
  } catch {
    throw "Windows still has the old checkout open. Close Codex, Claude, room TUI and any remaining processes using it, then rerun this script. Original error: $($_.Exception.Message)"
  }
  Write-Host "Moved checkout to $new"
}

if ($movedWorktrees.Count -gt 0) {
  $repairPaths = $movedWorktrees.ToArray()
  & git -C $new worktree repair @repairPaths
} else {
  & git -C $new worktree repair
}
if ($LASTEXITCODE -ne 0) { throw 'git worktree repair failed; rerun this script after resolving the reported error.' }
$repaired = & git -C $new worktree list --porcelain
if ($LASTEXITCODE -ne 0 -or @($repaired | Where-Object {
      $_.StartsWith('worktree ') -and
      $_.Substring(9).Replace('/', '\').StartsWith($old, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0) {
  throw 'Linked worktree metadata still refers to the old path.'
}
foreach ($worktree in $movedWorktrees) {
  & git -C $worktree rev-parse --git-common-dir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "A linked worktree is not usable after repair: $worktree" }
}
Write-Host 'Git worktrees repaired.'

$codexConfig = Join-Path $env:USERPROFILE '.codex\config.toml'
Replace-LiteralInFile $codexConfig 'X:\Development\vibe-pairing\dist\cli\main.js' 'X:\Development\the-room\dist\cli\main.js'
$claudeConfig = Join-Path $env:USERPROFILE '.claude.json'
Replace-LiteralInFile $claudeConfig 'X:\\Development\\vibe-pairing\\dist\\cli\\main.js' 'X:\\Development\\the-room\\dist\\cli\\main.js'
Write-Host 'MCP executable paths updated. Existing harness sessions must be reopened to load them.'
Write-Warning 'Codex project trust and the optional thread-id-probe MCP still refer to the old path. Re-establish trust for the new checkout and update that probe separately if you use it.'

$oldLink = Get-Item -LiteralPath $oldLinkPath -Force -ErrorAction SilentlyContinue
if ($oldLink) {
  & npm unlink --global vibe-pairing --ignore-scripts | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Warning 'npm could not remove the old global link; trying the verified junction directly.' }
}
$oldLink = Get-Item -LiteralPath $oldLinkPath -Force -ErrorAction SilentlyContinue
if ($oldLink) {
  $oldLinkTarget = [string]@($oldLink.Target)[0]
  if ($oldLink.LinkType -ne 'Junction' -or
      -not $oldLinkTarget.Equals($old, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The remaining old npm entry is not the expected junction; inspect it manually.'
  }
  [IO.Directory]::Delete($oldLinkPath)
}
foreach ($name in @('room', 'room.cmd', 'room.ps1')) {
  $shim = Join-Path $globalPrefix $name
  if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) { continue }
  $shimText = [IO.File]::ReadAllText($shim)
  if ($shimText -match 'node_modules[/\\]vibe-pairing[/\\]dist[/\\]cli[/\\]main\.js') {
    Remove-Item -LiteralPath $shim -Force
  } elseif ($shimText -notmatch 'node_modules[/\\]the-room[/\\]dist[/\\]cli[/\\]main\.js') {
    throw "An unrelated global room command appeared during migration: $shim"
  }
}
Push-Location -LiteralPath $new
try {
  & npm link --ignore-scripts | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'npm link failed.' }
} finally { Pop-Location }
$newLink = Get-Item -LiteralPath $newLinkPath -ErrorAction Stop
if ($newLink.LinkType -ne 'Junction' -or
    -not ([string]@($newLink.Target)[0]).Equals($new, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The global npm link does not point at the renamed checkout.'
}
& node (Join-Path $new 'dist\cli\main.js') --version
if ($LASTEXITCODE -ne 0) { throw 'The CLI did not start from the new path.' }
Push-Location -LiteralPath $new
try {
  & node (Join-Path $new 'dist\cli\main.js') who --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The room service did not start from the new path.' }
} finally { Pop-Location }
& git -C $new status --short --branch
if ($LASTEXITCODE -ne 0) { throw 'Git status failed from the new path.' }
Write-Host 'Local checkout migration complete.'
