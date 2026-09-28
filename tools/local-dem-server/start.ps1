[CmdletBinding()]
param(
  [string]$DataRoot = 'E:\AstroSight-GSI-data-20260926\dem\r2-ready',
  [int]$Port = 8789
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')
$entryPoint = Join-Path $PSScriptRoot 'server.ts'

if (-not [System.IO.Path]::IsPathRooted($DataRoot)) {
  throw 'DataRoot must be an absolute path.'
}
if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) {
  throw 'The prepared DEM data directory is unavailable.'
}
if (-not $env:LOCAL_DEM_ORIGIN_TOKEN) {
  throw 'Set LOCAL_DEM_ORIGIN_TOKEN before starting the local service.'
}

$env:LOCAL_DEM_HOST = '127.0.0.1'
$env:LOCAL_DEM_PORT = [string]$Port
$env:LOCAL_DEM_DATA_ROOT = [System.IO.Path]::GetFullPath($DataRoot)

Push-Location $repoRoot
try {
  & node --experimental-strip-types $entryPoint
  if ($LASTEXITCODE -ne 0) { throw 'The local DEM server stopped with an error.' }
}
finally {
  Pop-Location
}
