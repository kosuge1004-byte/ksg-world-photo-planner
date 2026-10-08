[CmdletBinding()]
param(
  [string]$ArchiveRoot = 'E:\AstroSight-GSI-data-20260926\dem\official-archive',
  [string]$OutputRoot = 'E:\AstroSight-GSI-data-20260926\dem\r2-ready'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$toolRoot = $PSScriptRoot
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $toolRoot '..\..'))
$workerPath = Join-Path $toolRoot 'Invoke-NationwideDemConversion.ps1'
$converterPath = Join-Path $repoRoot 'scripts\prepare-gsi-dem-r2-assets.mjs'
$finalizerPath = Join-Path $repoRoot 'scripts\finalize-nationwide-dem.mjs'
$manifestPath = Join-Path $repoRoot 'dem\gsi-dem-download-manifest.json'
$runtimeRoot = 'E:\AstroSight-GSI-data-20260926\runtime\gsi-dem-converter'
$progressPath = Join-Path $runtimeRoot 'progress.json'
$logPath = Join-Path $runtimeRoot 'conversion.log'

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="AstroSight 全国DEM変換" Height="245" Width="430"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="#10151D" Foreground="White">
  <Grid Margin="24">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="32" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="18" />
      <RowDefinition Height="Auto" />
    </Grid.RowDefinitions>
    <TextBlock Name="StatusText" Grid.Row="0" Text="実行ボタンを押してください"
               FontSize="17" FontWeight="SemiBold" TextAlignment="Center"
               Margin="0,4,0,18" />
    <ProgressBar Name="ProgressBar" Grid.Row="1" Minimum="0" Maximum="100"
                 Value="0" Height="24" Foreground="#53A9FF" />
    <TextBlock Name="PercentText" Grid.Row="2" Text="0%" FontSize="22"
               FontWeight="Bold" TextAlignment="Center" Margin="0,10,0,0" />
    <Button Name="ActionButton" Grid.Row="4" Content="実行" Height="42" Width="150"
            FontSize="17" FontWeight="Bold" HorizontalAlignment="Center"
            Background="#53A9FF" Foreground="#07111D" />
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$statusText = $window.FindName('StatusText')
$progressBar = $window.FindName('ProgressBar')
$percentText = $window.FindName('PercentText')
$actionButton = $window.FindName('ActionButton')
$workerProcess = $null
$finished = $false

function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Read-ProgressState {
  if (-not (Test-Path -LiteralPath $progressPath -PathType Leaf)) { return $null }
  try {
    return Get-Content -Raw -LiteralPath $progressPath -Encoding UTF8 | ConvertFrom-Json
  }
  catch {
    # The worker replaces this file atomically. A transient read failure is safe
    # to ignore and will be retried at the next timer tick.
    return $null
  }
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  $state = Read-ProgressState
  if ($null -eq $state) { return }
  $percent = [Math]::Max(0, [Math]::Min(100, [int]$state.percent))
  $progressBar.Value = $percent
  $percentText.Text = "${percent}%"
  if ($state.status -eq 'completed') {
    $statusText.Text = '終了'
    $actionButton.Content = '終了'
    $actionButton.IsEnabled = $true
    $finished = $true
    $timer.Stop()
  }
  elseif ($state.status -eq 'failed') {
    $statusText.Text = 'エラー: ' + [string]$state.message
    $actionButton.Content = '終了'
    $actionButton.IsEnabled = $true
    $finished = $true
    $timer.Stop()
  }
  else {
    $statusText.Text = '変換中'
  }
})

$actionButton.Add_Click({
  if ($finished) {
    $window.Close()
    return
  }

  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Remove-Item -LiteralPath $progressPath -Force -ErrorAction SilentlyContinue
  $statusText.Text = '準備中'
  $progressBar.Value = 0
  $percentText.Text = '0%'
  $actionButton.IsEnabled = $false

  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-ProcessArgument $workerPath),
    '-ArchiveRoot', (Quote-ProcessArgument $ArchiveRoot),
    '-OutputRoot', (Quote-ProcessArgument $OutputRoot),
    '-ConverterPath', (Quote-ProcessArgument $converterPath),
    '-FinalizerPath', (Quote-ProcessArgument $finalizerPath),
    '-ManifestPath', (Quote-ProcessArgument $manifestPath),
    '-ProgressPath', (Quote-ProcessArgument $progressPath),
    '-LogPath', (Quote-ProcessArgument $logPath)
  ) -join ' '

  try {
    $workerProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments `
      -WindowStyle Hidden -PassThru
    $timer.Start()
  }
  catch {
    $statusText.Text = 'エラー: 変換処理を開始できません'
    $actionButton.Content = '終了'
    $actionButton.IsEnabled = $true
    $finished = $true
  }
})

$window.Add_Closing({
  $timer.Stop()
  if ($null -ne $workerProcess -and -not $workerProcess.HasExited) {
    & taskkill.exe /PID $workerProcess.Id /T /F 2>$null | Out-Null
  }
})

[void]$window.ShowDialog()
