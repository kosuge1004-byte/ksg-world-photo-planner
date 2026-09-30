[CmdletBinding()]
param(
  [string]$DataRoot = 'E:\AstroSight-GSI-data-20260926\dem\r2-ready',
  [int]$Port = 8789,
  [string]$SecretFile = 'E:\AstroSight-GSI-data-20260926\runtime\local-dem-secrets.json',
  [string]$CloudflaredExecutable = '',
  [string]$RegistrationUrl = 'https://astrosight.pages.dev/api/local-dem-register',
  [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'AstroSight\local-dem-gateway.log')
)

$ErrorActionPreference = 'Stop'
$stage = 'initializing'

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
  $stage = 'loading-security'
  Add-Type -AssemblyName System.Security
  $stage = 'resolving-repository'
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

$stage = 'checking-data-root'
if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) {
  throw 'The prepared E-drive DEM directory is unavailable.'
}
$stage = 'checking-secret-file'
if (-not (Test-Path -LiteralPath $SecretFile -PathType Leaf)) {
  throw 'Run configure-domainless-secrets.ps1 before starting the Quick Tunnel.'
}
$stage = 'locating-cloudflared'
$cloudflaredPath = if (-not [string]::IsNullOrWhiteSpace($CloudflaredExecutable)) {
  [IO.Path]::GetFullPath($CloudflaredExecutable)
} else {
  $cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cloudflaredCommand) {
    $cloudflaredCommand.Source
  } elseif (Test-Path -LiteralPath 'E:\AstroSight-GSI-data-20260926\runtime\cloudflared.exe' -PathType Leaf) {
    'E:\AstroSight-GSI-data-20260926\runtime\cloudflared.exe'
  } else {
    Join-Path $env:LOCALAPPDATA 'AstroSight\bin\cloudflared.exe'
  }
}
$stage = 'checking-cloudflared'
if (-not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
  throw 'Run install-cloudflared-user.ps1 before starting the Quick Tunnel.'
}
$stage = 'checking-tsx'
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
  throw 'Run npm install before starting the local service.'
}
$stage = 'reading-secrets'

$saved = Get-Content -LiteralPath $SecretFile -Raw -Encoding UTF8 | ConvertFrom-Json
$env:LOCAL_DEM_ORIGIN_TOKEN = Unprotect-Secret ([string]$saved.originToken)
$env:LOCAL_DEM_REGISTRATION_TOKEN = Unprotect-Secret ([string]$saved.registrationToken)
$stage = 'starting-child'
$env:LOCAL_DEM_HOST = '127.0.0.1'
$env:LOCAL_DEM_PORT = [string]$Port
$env:LOCAL_DEM_DATA_ROOT = [IO.Path]::GetFullPath($DataRoot)
$env:ASTROSIGHT_LOCAL_DEM_REGISTER_URL = $RegistrationUrl
$env:LOCAL_DEM_CLOUDFLARED_PATH = $cloudflaredPath

  Push-Location $repoRoot
  try {
    & $tsx $entryPoint 2>&1 | ForEach-Object {
      $line = [string]$_
      # Keep the operational log UTF-8 and intentionally omit cloudflared's
      # public URL, network addresses and any Node stack paths. The installer
      # only needs the fixed local-dem readiness/heartbeat events.
      if ($line.StartsWith('[local-dem]')) {
        Write-OperationalLog ("child {0}" -f (
          $line -replace 'https://[a-z0-9-]+\.trycloudflare\.com', '[endpoint]'
        ))
      }
    }
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
  Write-OperationalLog ('supervisor-failed stage={0} type={1}' -f $stage, $_.Exception.GetType().Name)
  throw
}
finally {
  Write-OperationalLog 'supervisor-stopped'
}
