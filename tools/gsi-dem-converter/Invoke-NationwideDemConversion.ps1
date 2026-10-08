[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArchiveRoot,
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [Parameter(Mandatory = $true)][string]$ConverterPath,
  [Parameter(Mandatory = $true)][string]$FinalizerPath,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$ProgressPath,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [switch]$SkipManifestCompletenessCheck
)

$ErrorActionPreference = 'Stop'
$script:temporaryProgressPath = $null

function Write-ConversionProgress {
  param(
    [ValidateSet('running', 'completed', 'failed')][string]$Status,
    [int]$Percent,
    [string]$Message
  )
  $directory = Split-Path -Parent $ProgressPath
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $payload = [ordered]@{
    status = $Status
    percent = [Math]::Max(0, [Math]::Min(100, $Percent))
    message = $Message
    updatedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  $script:temporaryProgressPath = "$ProgressPath.tmp.$PID"
  [System.IO.File]::WriteAllText($script:temporaryProgressPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $script:temporaryProgressPath -Destination $ProgressPath -Force
  $script:temporaryProgressPath = $null
}

function Resolve-FullPath([string]$PathValue) {
  return [System.IO.Path]::GetFullPath($PathValue).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Test-ReplacementArchives([string]$Root, [string[]]$MissingNames) {
  $hasZip = {
    param([string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
    return $null -ne (Get-ChildItem -LiteralPath $Directory -File -Filter '*.zip' | Select-Object -First 1)
  }
  $replacementRoot = Join-Path $Root 'mesh-highres-kyushu-okinawa'
  $dem1 = & $hasZip (Join-Path $replacementRoot 'DEM1A')
  $dem5a = & $hasZip (Join-Path $replacementRoot 'DEM5A')
  $dem5b = & $hasZip (Join-Path $replacementRoot 'DEM5B')
  $dem5c = & $hasZip (Join-Path $replacementRoot 'DEM5C')
  foreach ($name in $MissingNames) {
    if ($name -match '^FG-GML-kyushu_okinawa-DEM1-' -and $dem1) { continue }
    if ($name -match '^FG-GML-kyushu_okinawa-DEM5-' -and $dem5a -and $dem5b -and $dem5c) { continue }
    return $false
  }
  return $true
}

try {
  Write-ConversionProgress -Status running -Percent 0 -Message '準備中'

  if (-not (Test-Path -LiteralPath $ArchiveRoot -PathType Container)) {
    throw '国土地理院ZIPの保存フォルダが見つかりません。'
  }
  if (-not (Test-Path -LiteralPath $ConverterPath -PathType Leaf)) {
    throw '既存のDEM変換プログラムが見つかりません。'
  }
  if (-not (Test-Path -LiteralPath $FinalizerPath -PathType Leaf)) {
    throw '全国DEM完成検査プログラムが見つかりません。'
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.jsが見つかりません。'
  }

  $archiveCanonical = Resolve-FullPath $ArchiveRoot
  $outputCanonical = Resolve-FullPath $OutputRoot
  if ($archiveCanonical -eq $outputCanonical -or
      $outputCanonical.StartsWith($archiveCanonical + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '変換先を公式ZIP保存フォルダの中には設定できません。'
  }

  $sourceFiles = @(Get-ChildItem -LiteralPath $archiveCanonical -File -Recurse |
    Where-Object { $_.Extension -in '.zip', '.xml' } |
    Sort-Object FullName)
  if ($sourceFiles.Count -eq 0) {
    throw '変換対象のZIPがありません。'
  }

  if (-not $SkipManifestCompletenessCheck) {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
      throw '全国版のファイル一覧が見つかりません。'
    }
    $downloadManifest = Get-Content -Raw -LiteralPath $ManifestPath -Encoding UTF8 | ConvertFrom-Json
    $expectedNames = @($downloadManifest.files | ForEach-Object { [string]$_.filename })
    $actualNames = @($sourceFiles | Where-Object Extension -eq '.zip' | ForEach-Object Name)
    $actualSet = @{}
    foreach ($name in $actualNames) { $actualSet[$name.ToLowerInvariant()] = $true }
    $missing = @($expectedNames | Where-Object { -not $actualSet.ContainsKey($_.ToLowerInvariant()) })
    if ($missing.Count -gt 0 -and -not (Test-ReplacementArchives $archiveCanonical $missing)) {
      throw "全国分のZIPが揃っていません（$($actualNames.Count)/$($expectedNames.Count)件）。"
    }
  }

  New-Item -ItemType Directory -Path $outputCanonical -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
  $header = "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] conversion started"
  [System.IO.File]::WriteAllText($LogPath, "$header`r`n", (New-Object System.Text.UTF8Encoding($false)))

  $sizeByPath = @{}
  [Int64]$totalBytes = 0
  foreach ($file in $sourceFiles) {
    $canonical = Resolve-FullPath $file.FullName
    $sizeByPath[$canonical.ToLowerInvariant()] = [Int64]$file.Length
    $totalBytes += [Int64]$file.Length
  }
  [Int64]$completedBytes = 0
  [string]$activePath = $null

  & node --experimental-strip-types $ConverterPath --input $archiveCanonical --output $outputCanonical 2>&1 |
    ForEach-Object {
      $line = [string]$_
      Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
      if ($line.StartsWith('input: ', [StringComparison]::Ordinal)) {
        if ($null -ne $activePath) {
          $previousKey = $activePath.ToLowerInvariant()
          if ($sizeByPath.ContainsKey($previousKey)) { $completedBytes += $sizeByPath[$previousKey] }
        }
        $activePath = Resolve-FullPath $line.Substring(7).Trim()
        $percent = if ($totalBytes -gt 0) {
          [int][Math]::Floor(($completedBytes * 100.0) / $totalBytes)
        } else { 0 }
        Write-ConversionProgress -Status running -Percent $percent -Message '変換中'
      }
    }
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "DEM変換プログラムがエラーで停止しました（終了コード $exitCode）。"
  }

  Write-ConversionProgress -Status running -Percent 99 -Message '完成検査中'
  & node $FinalizerPath `
    "--archive-root=$archiveCanonical" `
    "--output-root=$outputCanonical" `
    "--download-manifest=$ManifestPath" 2>&1 |
    ForEach-Object { Add-Content -LiteralPath $LogPath -Value ([string]$_) -Encoding UTF8 }
  if ($LASTEXITCODE -ne 0) {
    throw "全国DEM完成検査がエラーで停止しました（終了コード $LASTEXITCODE）。"
  }

  Write-ConversionProgress -Status completed -Percent 100 -Message '終了'
  Add-Content -LiteralPath $LogPath -Value "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] conversion completed" -Encoding UTF8
}
catch {
  $message = if ($_.Exception.Message) { $_.Exception.Message } else { '不明なエラーです。' }
  try {
    Write-ConversionProgress -Status failed -Percent 0 -Message $message
    Add-Content -LiteralPath $LogPath -Value "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] ERROR: $message" -Encoding UTF8
  }
  catch {
    # There is no further recovery if the progress location itself is unusable.
  }
  exit 1
}
finally {
  if ($null -ne $script:temporaryProgressPath) {
    Remove-Item -LiteralPath $script:temporaryProgressPath -Force -ErrorAction SilentlyContinue
  }
}
