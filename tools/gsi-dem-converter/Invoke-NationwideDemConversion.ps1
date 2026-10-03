[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArchiveRoot,
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [Parameter(Mandatory = $true)][string]$ConverterPath,
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

try {
  Write-ConversionProgress -Status running -Percent 0 -Message '準備中'

  if (-not (Test-Path -LiteralPath $ArchiveRoot -PathType Container)) {
    throw '国土地理院ZIPの保存フォルダが見つかりません。'
  }
  if (-not (Test-Path -LiteralPath $ConverterPath -PathType Leaf)) {
    throw '既存のDEM変換プログラムが見つかりません。'
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
    if ($missing.Count -gt 0) {
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

