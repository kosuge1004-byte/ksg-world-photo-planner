param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$DownloadDirectory = (Join-Path $env:USERPROFILE "Downloads"),
  [string]$DestinationRoot = "E:\AstroSight-GSI-data-20260926",
  [int]$PollSeconds = 2,
  [switch]$Once
)

$ErrorActionPreference = "Stop"

$manifestPath = Join-Path $ProjectRoot "dem\gsi-dem-download-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "DEM manifest was not found: $manifestPath"
}
if (-not (Test-Path -LiteralPath $DownloadDirectory -PathType Container)) {
  throw "Download directory was not found: $DownloadDirectory"
}

$destinationDrive = [System.IO.Path]::GetPathRoot($DestinationRoot)
if (-not $destinationDrive -or -not (Test-Path -LiteralPath $destinationDrive -PathType Container)) {
  throw "Destination drive was not found: $DestinationRoot"
}

[System.IO.Directory]::CreateDirectory($DestinationRoot) | Out-Null
$resolvedDestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
$archiveRoot = Join-Path $resolvedDestinationRoot "dem\official-archive"
$statePath = Join-Path $resolvedDestinationRoot "dem-download-state.json"
$logPath = Join-Path $resolvedDestinationRoot "dem-download-watch.log"
$stopPath = Join-Path $resolvedDestinationRoot "STOP_DEM_DOWNLOAD_WATCHER"
[System.IO.Directory]::CreateDirectory($archiveRoot) | Out-Null

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$expected = @{}
foreach ($file in $manifest.files) {
  $expected[$file.filename] = $file
}

function Write-WatcherLog([string]$Message) {
  $line = "{0:o} {1}" -f (Get-Date), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

function Get-DestinationPath($Item) {
  $directory = Join-Path $archiveRoot (Join-Path $Item.type $Item.regionCode)
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $directory $Item.filename))
  if (-not $candidate.StartsWith($resolvedDestinationRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a path outside DestinationRoot: $candidate"
  }
  return $candidate
}

function Write-State {
  $completed = @()
  $bytes = [int64]0
  foreach ($item in $manifest.files) {
    $path = Get-DestinationPath $item
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $info = Get-Item -LiteralPath $path
      $bytes += $info.Length
      $completed += [ordered]@{
        id = $item.id
        filename = $item.filename
        type = $item.type
        regionCode = $item.regionCode
        bytes = $info.Length
        path = $path
      }
    }
  }
  $state = [ordered]@{
    schemaVersion = 1
    updatedAt = (Get-Date).ToString("o")
    expectedFiles = $manifest.files.Count
    completedFiles = $completed.Count
    completedBytes = $bytes
    completedGiB = [math]::Round($bytes / 1GB, 3)
    remainingFiles = $manifest.files.Count - $completed.Count
    files = $completed
  }
  $temporaryState = "$statePath.tmp"
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryState -Encoding utf8
  Move-Item -LiteralPath $temporaryState -Destination $statePath -Force
  return $state
}

Write-WatcherLog "watcher-start expected=$($manifest.files.Count) source=$DownloadDirectory destination=$archiveRoot"
$lastCompleted = -1

while (-not (Test-Path -LiteralPath $stopPath)) {
  $movedAny = $false
  foreach ($source in Get-ChildItem -LiteralPath $DownloadDirectory -File -Filter "*.zip" -ErrorAction SilentlyContinue) {
    $item = $expected[$source.Name]
    if ($null -eq $item) { continue }

    $destination = Get-DestinationPath $item
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
      $existing = Get-Item -LiteralPath $destination
      if ($existing.Length -eq $source.Length) {
        Remove-Item -LiteralPath $source.FullName -Force
        Write-WatcherLog "deduplicated name=$($source.Name) bytes=$($source.Length)"
        $movedAny = $true
      } else {
        Write-WatcherLog "size-conflict name=$($source.Name) sourceBytes=$($source.Length) destinationBytes=$($existing.Length)"
      }
      continue
    }

    Move-Item -LiteralPath $source.FullName -Destination $destination
    $moved = Get-Item -LiteralPath $destination
    if ($moved.Length -ne $source.Length) {
      throw "Move verification failed: $($source.Name)"
    }
    Write-WatcherLog "moved name=$($source.Name) bytes=$($moved.Length) destination=$destination"
    $movedAny = $true
  }

  if ($movedAny -or $lastCompleted -lt 0) {
    $state = Write-State
    if ($state.completedFiles -ne $lastCompleted) {
      Write-WatcherLog "progress completed=$($state.completedFiles)/$($state.expectedFiles) gib=$($state.completedGiB)"
      $lastCompleted = $state.completedFiles
    }
    if ($state.completedFiles -ge $state.expectedFiles) {
      Write-WatcherLog "watcher-complete"
      break
    }
  }

  if ($Once) { break }

  Start-Sleep -Seconds ([math]::Max(1, $PollSeconds))
}

if (Test-Path -LiteralPath $stopPath) {
  Write-WatcherLog "watcher-stopped-by-sentinel"
}
Write-State | Out-Null
