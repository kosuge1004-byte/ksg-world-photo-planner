param(
  [Parameter(Mandatory = $true)][string]$OriginalZip,
  [string]$Output = "evidence/source-diff-inventory-20260926.json"
)

$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$zipPath = (Resolve-Path -LiteralPath $OriginalZip).Path
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $root $Output))
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-StreamSha256([System.IO.Stream]$Stream) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([Convert]::ToHexString($sha.ComputeHash($Stream))).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Is-Excluded([string]$RelativePath) {
  return $RelativePath -match '^(?:node_modules|\.wrangler(?:-dry-run-prewarm|-final-20260926)?)(?:/|$)' -or
    $RelativePath -match '(?:^|/)\.DS_Store$' -or
    $RelativePath -match '\.tsbuildinfo$'
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $original = @{}
  $modified = [System.Collections.Generic.List[object]]::new()
  $missing = [System.Collections.Generic.List[object]]::new()
  $unchanged = 0
  foreach ($entry in $archive.Entries) {
    $relative = $entry.FullName.Replace('\', '/').TrimStart('/')
    if (-not $relative -or $relative.EndsWith('/') -or (Is-Excluded $relative)) { continue }
    $original[$relative] = $true
    $localPath = Join-Path $root ($relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
      $missing.Add([pscustomobject]@{ path = $relative; originalBytes = $entry.Length })
      continue
    }
    $entryStream = $entry.Open()
    try { $archiveHash = Get-StreamSha256 $entryStream } finally { $entryStream.Dispose() }
    $localHash = (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveHash -eq $localHash) {
      $unchanged += 1
    } else {
      $modified.Add([pscustomobject]@{
        path = $relative
        originalBytes = $entry.Length
        currentBytes = (Get-Item -LiteralPath $localPath).Length
        originalSha256 = $archiveHash
        currentSha256 = $localHash
      })
    }
  }

  $newFiles = [System.Collections.Generic.List[object]]::new()
  $relativeFiles = & rg --files --hidden --no-ignore `
    -g '!node_modules/**' `
    -g '!.wrangler/**' `
    -g '!.wrangler-dry-run-prewarm/**' `
    -g '!.wrangler-final-20260926/**'
  foreach ($relativeNative in $relativeFiles) {
    $relative = $relativeNative.Replace('\', '/')
    if ((Is-Excluded $relative) -or $original.ContainsKey($relative)) { continue }
    $item = Get-Item -LiteralPath (Join-Path $root $relativeNative)
    $newFiles.Add([pscustomobject]@{ path = $relative; bytes = $item.Length })
  }

  $report = [ordered]@{
    generatedAt = [DateTime]::UtcNow.ToString('o')
    originalZip = $zipPath
    originalZipSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    unchangedFiles = $unchanged
    modifiedFiles = @($modified | Sort-Object path)
    missingFiles = @($missing | Sort-Object path)
    newFiles = @($newFiles | Sort-Object path)
  }
  $directory = Split-Path -Parent $outputPath
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $outputPath -Encoding utf8
  [pscustomobject]@{
    Unchanged = $unchanged
    Modified = $modified.Count
    Missing = $missing.Count
    New = $newFiles.Count
    Report = $outputPath
  } | ConvertTo-Json
} finally {
  $archive.Dispose()
}
