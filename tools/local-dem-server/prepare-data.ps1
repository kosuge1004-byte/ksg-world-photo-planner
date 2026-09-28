[CmdletBinding()]
param(
  [string]$ArchiveRoot = 'E:\AstroSight-GSI-data-20260926\dem\official-archive',
  [string]$OutputRoot = 'E:\AstroSight-GSI-data-20260926\dem\r2-ready'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')
$converter = Join-Path $repoRoot 'scripts\prepare-gsi-dem-r2-assets.mjs'

if (-not [System.IO.Path]::IsPathRooted($ArchiveRoot) -or
    -not [System.IO.Path]::IsPathRooted($OutputRoot)) {
  throw 'ArchiveRoot and OutputRoot must be absolute paths.'
}
if (-not (Test-Path -LiteralPath $ArchiveRoot -PathType Container)) {
  throw 'The GSI archive directory is unavailable.'
}

$archiveCanonical = [System.IO.Path]::GetFullPath($ArchiveRoot)
$outputCanonical = [System.IO.Path]::GetFullPath($OutputRoot)
if ($archiveCanonical -eq $outputCanonical -or $outputCanonical.StartsWith($archiveCanonical + [System.IO.Path]::DirectorySeparatorChar)) {
  throw 'OutputRoot must be separate from the immutable official archives.'
}

New-Item -ItemType Directory -Path $outputCanonical -Force | Out-Null
Push-Location $repoRoot
try {
  & node --experimental-strip-types $converter --input $archiveCanonical --output $outputCanonical
  if ($LASTEXITCODE -ne 0) { throw 'DEM conversion failed.' }
}
finally {
  Pop-Location
}
