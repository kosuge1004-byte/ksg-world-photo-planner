[CmdletBinding()]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'AstroSight\bin')
)

$ErrorActionPreference = 'Stop'
$version = '2026.9.3'
$expectedSha256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'
$downloadUrl = "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-windows-amd64.exe"
$destination = Join-Path $InstallDirectory 'cloudflared.exe'
$temporary = Join-Path $InstallDirectory 'cloudflared.download.exe'

function Get-Sha256([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $InstallDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
}

if (Test-Path -LiteralPath $destination -PathType Leaf) {
  $installedHash = Get-Sha256 $destination
  if ($installedHash -eq $expectedSha256) {
    Write-Output "cloudflared $version is already installed for this user."
    Write-Output $destination
    exit 0
  }
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $downloadUrl -OutFile $temporary -UseBasicParsing
  $downloadedHash = Get-Sha256 $temporary
  if ($downloadedHash -ne $expectedSha256) {
    throw 'The downloaded cloudflared SHA-256 does not match the official release checksum.'
  }
  Move-Item -LiteralPath $temporary -Destination $destination -Force
  Unblock-File -LiteralPath $destination
}
finally {
  if (Test-Path -LiteralPath $temporary -PathType Leaf) {
    Remove-Item -LiteralPath $temporary -Force
  }
}

& $destination --version
if ($LASTEXITCODE -ne 0) { throw 'cloudflared could not be started.' }
Write-Output "User-local cloudflared installed: $destination"
