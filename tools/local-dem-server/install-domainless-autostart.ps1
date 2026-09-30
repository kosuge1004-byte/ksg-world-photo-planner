[CmdletBinding()]
param(
  [string]$TaskName = 'AstroSight Local DEM Gateway',
  [string]$RuntimeDirectory = 'E:\AstroSight-GSI-data-20260926\runtime'
)

$ErrorActionPreference = 'Stop'
$startScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-quick-tunnel.ps1')).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$secretFile = Join-Path $RuntimeDirectory 'local-dem-secrets.json'
$logFile = Join-Path $env:LOCALAPPDATA 'AstroSight\local-dem-gateway.log'
if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
  throw 'Run configure-domainless-secrets.ps1 first.'
}
$runtimeCloudflared = Join-Path $RuntimeDirectory 'cloudflared.exe'
$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflaredPath = if (Test-Path -LiteralPath $runtimeCloudflared -PathType Leaf) {
  $runtimeCloudflared
} elseif ($cloudflaredCommand) {
  $cloudflaredCommand.Source
} else {
  Join-Path $env:LOCALAPPDATA 'AstroSight\bin\cloudflared.exe'
}
if (-not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
  throw 'Run install-cloudflared-user.ps1 first.'
}

$arguments = (
  '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass ' +
  "-File `"$startScript`" " +
  "-SecretFile `"$secretFile`" " +
  "-CloudflaredExecutable `"$cloudflaredPath`" " +
  "-LogFile `"$logFile`""
)
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument $arguments `
  -WorkingDirectory $repoRoot
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

if (Test-Path -LiteralPath $logFile -PathType Leaf) {
  Move-Item -LiteralPath $logFile -Destination "$logFile.previous" -Force
}
Start-ScheduledTask -TaskName $TaskName

$deadline = [DateTimeOffset]::Now.AddSeconds(90)
$localReady = $false
$gatewayRegistered = $false
do {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:8789/health' -TimeoutSec 2
    $localReady = $health.ok -eq $true
  }
  catch { $localReady = $false }
  if (Test-Path -LiteralPath $logFile -PathType Leaf) {
    $gatewayRegistered = Select-String `
      -LiteralPath $logFile `
      -SimpleMatch 'Quick Tunnel heartbeat registered' `
      -Quiet
  }
} while ((-not $localReady -or -not $gatewayRegistered) -and [DateTimeOffset]::Now -lt $deadline)

$task = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
if ($task.State -ne 'Running' -or -not $localReady -or -not $gatewayRegistered) {
  Write-Output "Task state: $($task.State); last result: $($taskInfo.LastTaskResult)"
  Write-Output "Operational log: $logFile"
  throw 'The scheduled local DEM gateway did not pass its startup and edge round-trip checks.'
}

Write-Output "Scheduled task installed and running: $TaskName"
Write-Output "Operational log: $logFile"
Write-Output 'It runs only after this Windows user logs on and does not open a LAN port.'
