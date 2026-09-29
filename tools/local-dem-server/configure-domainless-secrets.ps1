[CmdletBinding()]
param(
  [string]$SecretFile = (Join-Path $env:LOCALAPPDATA 'AstroSight\local-dem-secrets.json'),
  [string]$PagesProject = 'astrosight'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

function New-RandomToken {
  $bytes = [byte[]]::new(48)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) }
  finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Protect-Secret([string]$value) {
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($value)
  try {
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    try { return [Convert]::ToBase64String($protectedBytes) }
    finally { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
  }
  finally { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
}

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

$secretDirectory = Split-Path -Parent $SecretFile
if (-not (Test-Path -LiteralPath $secretDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
}

if (Test-Path -LiteralPath $SecretFile -PathType Leaf) {
  $saved = Get-Content -LiteralPath $SecretFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $originToken = Unprotect-Secret ([string]$saved.originToken)
  $registrationToken = Unprotect-Secret ([string]$saved.registrationToken)
} else {
  $originToken = New-RandomToken
  $registrationToken = New-RandomToken
  [ordered]@{
    version = 1
    originToken = Protect-Secret $originToken
    registrationToken = Protect-Secret $registrationToken
  } | ConvertTo-Json | Set-Content -LiteralPath $SecretFile -Encoding UTF8
}

Push-Location $repoRoot
try {
  $originToken | & npx.cmd wrangler pages secret put LOCAL_DEM_ORIGIN_TOKEN --project-name $PagesProject
  if ($LASTEXITCODE -ne 0) { throw 'Failed to configure the Pages origin token.' }
  $registrationToken | & npx.cmd wrangler pages secret put LOCAL_DEM_REGISTRATION_TOKEN --project-name $PagesProject
  if ($LASTEXITCODE -ne 0) { throw 'Failed to configure the Pages registration token.' }

  foreach ($config in @(
    'wrangler.spot-search.jsonc',
    'wrangler.bearing-profile-download.jsonc',
    'wrangler.prewarm.jsonc'
  )) {
    $originToken | & npx.cmd wrangler secret put LOCAL_DEM_ORIGIN_TOKEN --config $config
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure LOCAL_DEM_ORIGIN_TOKEN for $config." }
  }
}
finally {
  $originToken = $null
  $registrationToken = $null
  Pop-Location
}

Write-Output "Encrypted local secrets: $SecretFile"
Write-Output 'Cloudflare secret values were configured without printing them.'
Write-Output 'Create or retry a Pages production deployment now so the new secrets are bound to it.'
