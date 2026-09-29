[CmdletBinding()]
param(
  [string]$TaskName = 'AstroSight Local DEM Gateway'
)

$ErrorActionPreference = 'Stop'
$startScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-quick-tunnel.ps1')).Path
$secretFile = Join-Path $env:LOCALAPPDATA 'AstroSight\local-dem-secrets.json'
if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
  throw 'Run configure-domainless-secrets.ps1 first.'
}
$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflaredPath = if ($cloudflaredCommand) {
  $cloudflaredCommand.Source
} else {
  Join-Path $env:LOCALAPPDATA 'AstroSight\bin\cloudflared.exe'
}
if (-not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
  throw 'Run install-cloudflared-user.ps1 first.'
}

$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Starts the loopback AstroSight DEM service and domainless Cloudflare Quick Tunnel.' `
  -Force | Out-Null

Write-Output "Scheduled task installed: $TaskName"
Write-Output 'It runs only after this Windows user logs on and does not open a LAN port.'
