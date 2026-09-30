[CmdletBinding()]
param(
  [string]$DataRoot = 'E:\AstroSight-GSI-data-20260926\dem\r2-ready',
  [int]$Port = 8789,
  [string]$SecretFile = (Join-Path $env:LOCALAPPDATA 'AstroSight\local-dem-secrets.json'),
  [string]$RegistrationUrl = 'https://astrosight.pages.dev/api/local-dem-register',
  [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'AstroSight\local-dem-gateway.log')
)

$ErrorActionPreference = 'Stop'

function Write-OperationalLog([string]$message) {
  $directory = Split-Path -Parent $LogFile
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value (
    '{0} {1}' -f ([DateTimeOffset]::Now.ToString('o')), $message
  )
}

try {
  Write-OperationalLog 'supervisor-starting'
  Add-Type -AssemblyName System.Security
  $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
  $tsx = Join-Path $repoRoot 'node_modules\.bin\tsx.cmd'
  $entryPoint = Join-Path $PSScriptRoot 'quickTunnelSupervisor.ts'

function Unprotect-Secret([string]$encrypted) {
  $protectedBytes = [Convert]::FromBase64String($encrypted)
  try {
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $protectedBytes,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    try { return [Text.Encoding]::UTF8.GetString($plainBytes) }
    finally { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  }
  finally { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
}

if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) {
  throw 'The prepared E-drive DEM directory is unavailable.'
}
if (-not (Test-Path -LiteralPath $SecretFile -PathType Leaf)) {
  throw 'Run configure-domainless-secrets.ps1 before starting the Quick Tunnel.'
}
$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflaredPath = if ($cloudflaredCommand) {
  $cloudflaredCommand.Source
} else {
  Join-Path $env:LOCALAPPDATA 'AstroSight\bin\cloudflared.exe'
}
if (-not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
  throw 'Run install-cloudflared-user.ps1 before starting the Quick Tunnel.'
}
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
  throw 'Run npm install before starting the local service.'
}

$saved = Get-Content -LiteralPath $SecretFile -Raw -Encoding UTF8 | ConvertFrom-Json
$env:LOCAL_DEM_ORIGIN_TOKEN = Unprotect-Secret ([string]$saved.originToken)
$env:LOCAL_DEM_REGISTRATION_TOKEN = Unprotect-Secret ([string]$saved.registrationToken)
$env:LOCAL_DEM_HOST = '127.0.0.1'
$env:LOCAL_DEM_PORT = [string]$Port
$env:LOCAL_DEM_DATA_ROOT = [IO.Path]::GetFullPath($DataRoot)
$env:ASTROSIGHT_LOCAL_DEM_REGISTER_URL = $RegistrationUrl
$env:LOCAL_DEM_CLOUDFLARED_PATH = $cloudflaredPath

  Push-Location $repoRoot
  try {
    & $tsx $entryPoint 2>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -ne 0) { throw 'The domainless local DEM supervisor stopped with an error.' }
  }
  finally {
    $env:LOCAL_DEM_ORIGIN_TOKEN = $null
    $env:LOCAL_DEM_REGISTRATION_TOKEN = $null
    $env:LOCAL_DEM_CLOUDFLARED_PATH = $null
    Pop-Location
  }
}
catch {
  # Record only the exception type. Messages can contain local paths; tokens
  # must never be written to this operational log.
  Write-OperationalLog ('supervisor-failed type={0}' -f $_.Exception.GetType().Name)
  throw
}
finally {
  Write-OperationalLog 'supervisor-stopped'
}
