param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$DataRoot = 'E:\AstroSight-GSI-data-20260926',
  [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'evidence\gsi-data-integrity-audit-20260926.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Gib([long]$Bytes) {
  return [Math]::Round($Bytes / 1GB, 3)
}

function Get-ZipAudit([string]$Path, [string]$Scope) {
  $item = Get-Item -LiteralPath $Path
  $result = [ordered]@{
    scope = $Scope
    path = $item.FullName
    bytes = [long]$item.Length
    lastWrite = $item.LastWriteTime.ToString('o')
    centralDirectoryReadable = $false
    entryCount = $null
    compressedBytesInEntries = $null
    uncompressedBytesInEntries = $null
    duplicateEntryNameCount = $null
    firstEntry = $null
    lastEntry = $null
    sampledPayloadHeadersReadable = $false
    error = $null
  }

  $fileStream = $null
  $archive = $null
  try {
    $fileStream = [System.IO.File]::Open(
      $item.FullName,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    $archive = [System.IO.Compression.ZipArchive]::new(
      $fileStream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $false
    )

    [long]$compressed = 0
    [long]$uncompressed = 0
    $entryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    [int]$duplicateNames = 0
    $first = $null
    $last = $null
    foreach ($entry in $archive.Entries) {
      if ($null -eq $first) { $first = $entry }
      $last = $entry
      $compressed += [long]$entry.CompressedLength
      $uncompressed += [long]$entry.Length
      if (-not $entryNames.Add($entry.FullName)) { $duplicateNames += 1 }
    }

    $result.centralDirectoryReadable = $true
    $result.entryCount = [int]$archive.Entries.Count
    $result.compressedBytesInEntries = $compressed
    $result.uncompressedBytesInEntries = $uncompressed
    $result.duplicateEntryNameCount = $duplicateNames
    if ($null -ne $first) { $result.firstEntry = $first.FullName }
    if ($null -ne $last) { $result.lastEntry = $last.FullName }

    # Reading one byte from the first and last non-empty entries confirms that
    # their local headers and the beginning of their compressed streams are usable.
    # It deliberately does not expand the archive or perform a full CRC pass.
    $payloadCandidates = @($archive.Entries | Where-Object { $_.Length -gt 0 })
    $samples = @()
    if ($payloadCandidates.Count -gt 0) {
      $samples += $payloadCandidates[0]
      if ($payloadCandidates.Count -gt 1) { $samples += $payloadCandidates[-1] }
    }
    $sampleOk = $true
    foreach ($sample in $samples) {
      $payload = $null
      try {
        $payload = $sample.Open()
        [void]$payload.ReadByte()
      } finally {
        if ($null -ne $payload) { $payload.Dispose() }
      }
    }
    $result.sampledPayloadHeadersReadable = $sampleOk
  } catch {
    $result.error = $_.Exception.Message
  } finally {
    if ($null -ne $archive) { $archive.Dispose() }
    if ($null -ne $fileStream) { $fileStream.Dispose() }
  }
  return [pscustomobject]$result
}

function Get-ManifestByType($Files, [string]$SizeProperty) {
  return @($Files | Group-Object type | Sort-Object Name | ForEach-Object {
    $bytes = [long](($_.Group | Measure-Object -Property $SizeProperty -Sum).Sum)
    [ordered]@{
      type = $_.Name
      files = [int]$_.Count
      bytes = $bytes
      gib = Get-Gib $bytes
    }
  })
}

function Get-LandmarkManifestAudit([System.IO.FileInfo]$Item) {
  $manifest = Get-Content -Raw -LiteralPath $Item.FullName | ConvertFrom-Json
  $files = @($manifest.files)
  $meshCodes = @($manifest.meshCodes)
  $landmarkNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($property in $manifest.landmarksByMesh.PSObject.Properties) {
    foreach ($name in @($property.Value)) { [void]$landmarkNames.Add([string]$name) }
  }

  $ids = @($files | ForEach-Object { [string]$_.id })
  $fileNames = @($files | ForEach-Object { [string]$_.fileName })
  [long]$calculatedBytes = ($files | Measure-Object -Property estimatedBytes -Sum).Sum
  $csvPath = [System.IO.Path]::ChangeExtension($Item.FullName, '.csv')
  $csvRows = if (Test-Path -LiteralPath $csvPath) {
    [Math]::Max(0, @((Get-Content -LiteralPath $csvPath)).Count - 1)
  } else { $null }

  $errors = [System.Collections.Generic.List[string]]::new()
  if ([int]$manifest.meshCount -ne $meshCodes.Count) { $errors.Add('meshCount does not equal meshCodes length') }
  if ([int]$manifest.landmarkCount -ne $landmarkNames.Count) { $errors.Add('landmarkCount does not equal distinct landmark names') }
  if ([int]$manifest.summary.files -ne $files.Count) { $errors.Add('summary.files does not equal files length') }
  if ([long]$manifest.summary.estimatedBytes -ne $calculatedBytes) { $errors.Add('summary.estimatedBytes does not equal file sum') }
  if (($ids | Sort-Object -Unique).Count -ne $ids.Count) { $errors.Add('duplicate download id') }
  if (($fileNames | Sort-Object -Unique).Count -ne $fileNames.Count) { $errors.Add('duplicate fileName') }
  if ($null -ne $csvRows -and $csvRows -ne $files.Count) { $errors.Add('CSV row count does not equal JSON files length') }

  return [ordered]@{
    jsonPath = $Item.FullName
    csvPath = if (Test-Path -LiteralPath $csvPath) { $csvPath } else { $null }
    landmarkSource = $manifest.landmarkSource
    landmarkCountDeclared = [int]$manifest.landmarkCount
    landmarkCountDistinctInMeshMap = [int]$landmarkNames.Count
    radiusMeters = [int]$manifest.radiusMeters
    meshCountDeclared = [int]$manifest.meshCount
    meshCodeCount = [int]$meshCodes.Count
    fileCountDeclared = [int]$manifest.summary.files
    fileCountActual = [int]$files.Count
    csvDataRowCount = $csvRows
    estimatedBytesDeclared = [long]$manifest.summary.estimatedBytes
    estimatedBytesCalculated = $calculatedBytes
    estimatedGiB = Get-Gib $calculatedBytes
    uniqueIds = (($ids | Sort-Object -Unique).Count -eq $ids.Count)
    uniqueFileNames = (($fileNames | Sort-Object -Unique).Count -eq $fileNames.Count)
    internalConsistencyPass = ($errors.Count -eq 0)
    errors = @($errors)
  }
}

$capturedAt = (Get-Date).ToString('o')
$geoidRoot = Join-Path $RepoRoot 'geoid'
$repoDemRoot = Join-Path $RepoRoot 'dem'
$externalDemRoot = Join-Path $DataRoot 'dem\official-archive'
$downloadManifestPath = Join-Path $repoDemRoot 'gsi-dem-download-manifest.json'
$statePath = Join-Path $DataRoot 'dem-download-state.json'

$expectedPrefectures = @(
  'aichi','akita','aomori','chiba','ehime','fukui','fukuoka','fukushima','gifu','gunma',
  'hiroshima','hokkaido','hyogo','ibaraki','ishikawa','iwate','kagawa','kagoshima','kanagawa',
  'kochi','kumamoto','kyoto','mie','miyagi','miyazaki','nagano','nagasaki','nara','niigata',
  'oita','okayama','okinawa','osaka','saga','saitama','shiga','shimane','shizuoka','tochigi',
  'tokushima','tokyo','tottori','toyama','wakayama','yamagata','yamaguchi','yamanashi'
)

$geoidPrefectureZips = @(Get-ChildItem -LiteralPath $geoidRoot -File -Filter 'GMLdata2024_*.zip' | Sort-Object Name)
$foundPrefectures = @($geoidPrefectureZips | ForEach-Object { $_.BaseName -replace '^GMLdata2024_', '' })
$geoidNationalZip = Get-Item -LiteralPath (Join-Path $geoidRoot 'JPGEO2024_isg.zip')
$geoidOfficialZips = @($geoidPrefectureZips) + @($geoidNationalZip)
$geoidDerived = @(Get-ChildItem -LiteralPath $geoidRoot -File -Filter '*.gz' | Sort-Object Name)

$downloadManifest = Get-Content -Raw -LiteralPath $downloadManifestPath | ConvertFrom-Json
$expectedDemFiles = @($downloadManifest.files)
$expectedDemByName = @{}
foreach ($file in $expectedDemFiles) { $expectedDemByName[[string]$file.filename] = $file }

$externalDemZips = @(Get-ChildItem -LiteralPath $externalDemRoot -Recurse -File -Filter '*.zip' | Sort-Object Name)
$externalNames = @($externalDemZips | ForEach-Object { $_.Name })
$completed = @($externalDemZips | Where-Object { $expectedDemByName.ContainsKey($_.Name) } | ForEach-Object {
  $manifestFile = $expectedDemByName[$_.Name]
  [pscustomobject][ordered]@{
    id = [int]$manifestFile.id
    filename = $_.Name
    type = [string]$manifestFile.type
    regionCode = [string]$manifestFile.regionCode
    actualBytes = [long]$_.Length
    estimatedBytes = [long]$manifestFile.estimatedBytes
    deltaBytes = [long]$_.Length - [long]$manifestFile.estimatedBytes
    path = $_.FullName
  }
})
$completedNameSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in $externalNames) { [void]$completedNameSet.Add($name) }
$missing = @($expectedDemFiles | Where-Object { -not $completedNameSet.Contains([string]$_.filename) } | ForEach-Object {
  [pscustomobject][ordered]@{
    id = [int]$_.id
    filename = [string]$_.filename
    type = [string]$_.type
    regionCode = [string]$_.regionCode
    regionName = [string]$_.regionName
    estimatedBytes = [long]$_.estimatedBytes
    downloadPath = [string]$_.downloadPath
  }
})
$unexpected = @($externalDemZips | Where-Object { -not $expectedDemByName.ContainsKey($_.Name) } | ForEach-Object {
  [pscustomobject][ordered]@{ filename = $_.Name; bytes = [long]$_.Length; path = $_.FullName }
})

$repoDemZips = @(Get-ChildItem -LiteralPath $repoDemRoot -File -Filter 'FG-GML-*.zip' | Sort-Object Name)
$repoDemCopies = @($repoDemZips | ForEach-Object {
  $manifestFile = $expectedDemByName[$_.Name]
  $externalCopy = @($externalDemZips | Where-Object Name -eq $_.Name | Select-Object -First 1)
  [pscustomobject][ordered]@{
    filename = $_.Name
    bytes = [long]$_.Length
    inDownloadManifest = ($null -ne $manifestFile)
    externalArchiveCopyPresent = ($externalCopy.Count -eq 1)
    externalArchiveCopySameLength = ($externalCopy.Count -eq 1 -and [long]$externalCopy[0].Length -eq [long]$_.Length)
  }
})

$state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { $null }
$downloadFolderFiles = @(Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE 'Downloads') -File | Where-Object {
  $_.Name -like 'FG-GML-*.zip' -or $_.Name -like '*.crdownload'
} | Sort-Object Name | ForEach-Object {
  [ordered]@{
    filename = $_.Name
    bytes = [long]$_.Length
    lastWrite = $_.LastWriteTime.ToString('o')
    exactRegionalManifestMatch = $expectedDemByName.ContainsKey($_.Name)
    duplicateOfExternalArchiveByNameAndLength = (@($externalDemZips | Where-Object {
      $_.Name -eq $item.Name -and $_.Length -eq $item.Length
    }).Count -gt 0)
  }
})

$zipAudits = [System.Collections.Generic.List[object]]::new()
foreach ($zip in $geoidOfficialZips) { $zipAudits.Add((Get-ZipAudit $zip.FullName 'repo-geoid-official')) }
foreach ($zip in $repoDemZips) { $zipAudits.Add((Get-ZipAudit $zip.FullName 'repo-dem-sample')) }
foreach ($zip in $externalDemZips) { $zipAudits.Add((Get-ZipAudit $zip.FullName 'external-dem-official-archive')) }

$landmarkAudits = @(Get-ChildItem -LiteralPath $repoDemRoot -File -Filter 'gsi-landmark-dem-*-manifest.json' |
  Sort-Object Name | ForEach-Object { Get-LandmarkManifestAudit $_ })

[long]$actualCompletedBytes = ($completed | Measure-Object -Property actualBytes -Sum).Sum
[long]$estimatedCompletedBytes = ($completed | Measure-Object -Property estimatedBytes -Sum).Sum
[long]$estimatedMissingBytes = ($missing | Measure-Object -Property estimatedBytes -Sum).Sum
[long]$geoidOfficialBytes = ($geoidOfficialZips | Measure-Object -Property Length -Sum).Sum
[long]$geoidDerivedBytes = ($geoidDerived | Measure-Object -Property Length -Sum).Sum
[long]$repoDemBytes = ($repoDemZips | Measure-Object -Property Length -Sum).Sum

$zipFailures = @($zipAudits | Where-Object { -not $_.centralDirectoryReadable -or -not $_.sampledPayloadHeadersReadable })
$manifestDuplicateIds = @($expectedDemFiles | Group-Object id | Where-Object Count -gt 1)
$manifestDuplicateNames = @($expectedDemFiles | Group-Object filename | Where-Object Count -gt 1)
[long]$manifestCalculatedBytes = ($expectedDemFiles | Measure-Object -Property estimatedBytes -Sum).Sum

$drives = @('C','E') | ForEach-Object {
  $drive = Get-PSDrive -Name $_ -PSProvider FileSystem
  [ordered]@{ drive = $_; usedBytes = [long]$drive.Used; freeBytes = [long]$drive.Free; freeGiB = Get-Gib ([long]$drive.Free) }
}

$output = [ordered]@{
  schemaVersion = 1
  capturedAt = $capturedAt
  auditMethod = [ordered]@{
    zipValidation = 'Parse ZIP EOCD/central directory, enumerate all entries, and read one byte from first/last non-empty entry. No extraction and no full CRC/decompression pass.'
    manifestValidation = 'Parse JSON, recompute counts/byte totals/uniqueness, compare actual archive basenames to the authoritative regional manifest.'
  }
  paths = [ordered]@{
    repoRoot = $RepoRoot
    dataRoot = $DataRoot
    downloadManifest = $downloadManifestPath
    downloadState = $statePath
  }
  geoid = [ordered]@{
    expectedPrefectureCount = 47
    foundPrefectureCount = $geoidPrefectureZips.Count
    missingPrefectures = @($expectedPrefectures | Where-Object { $_ -notin $foundPrefectures })
    unexpectedPrefectures = @($foundPrefectures | Where-Object { $_ -notin $expectedPrefectures })
    nationalGridPresent = ($null -ne $geoidNationalZip)
    officialZipCount = $geoidOfficialZips.Count
    officialZipBytes = $geoidOfficialBytes
    officialZipGiB = Get-Gib $geoidOfficialBytes
    derivedGzipCount = $geoidDerived.Count
    derivedGzipBytes = $geoidDerivedBytes
    derivedFiles = @($geoidDerived | ForEach-Object { [ordered]@{ filename=$_.Name; bytes=[long]$_.Length } })
  }
  nationwideDemManifest = [ordered]@{
    schemaVersion = [int]$downloadManifest.schemaVersion
    source = [string]$downloadManifest.source
    capturedAt = [string]$downloadManifest.capturedAt
    declaredFileCount = [int]$downloadManifest.summary.files
    actualManifestFileCount = $expectedDemFiles.Count
    declaredEstimatedBytes = [long]$downloadManifest.summary.estimatedBytes
    calculatedEstimatedBytes = $manifestCalculatedBytes
    calculatedEstimatedGiB = Get-Gib $manifestCalculatedBytes
    uniqueIds = ($manifestDuplicateIds.Count -eq 0)
    uniqueFilenames = ($manifestDuplicateNames.Count -eq 0)
    byType = Get-ManifestByType $expectedDemFiles 'estimatedBytes'
    internalConsistencyPass = (
      [int]$downloadManifest.summary.files -eq $expectedDemFiles.Count -and
      [long]$downloadManifest.summary.estimatedBytes -eq $manifestCalculatedBytes -and
      $manifestDuplicateIds.Count -eq 0 -and
      $manifestDuplicateNames.Count -eq 0
    )
  }
  nationwideDemDownload = [ordered]@{
    expectedFiles = $expectedDemFiles.Count
    completedFilesFromDiskScan = $completed.Count
    remainingFiles = $missing.Count
    completionByFilePercent = [Math]::Round(100 * $completed.Count / $expectedDemFiles.Count, 3)
    actualCompletedBytes = $actualCompletedBytes
    actualCompletedGiB = Get-Gib $actualCompletedBytes
    estimatedCompletedBytes = $estimatedCompletedBytes
    estimatedRemainingBytes = $estimatedMissingBytes
    estimatedRemainingGiB = Get-Gib $estimatedMissingBytes
    byTypeCompleted = @($completed | Group-Object type | Sort-Object Name | ForEach-Object {
      [long]$bytes = ($_.Group | Measure-Object -Property actualBytes -Sum).Sum
      [ordered]@{ type=$_.Name; files=[int]$_.Count; bytes=$bytes; gib=Get-Gib $bytes }
    })
    completed = $completed
    missing = $missing
    unexpected = $unexpected
  }
  stateFileComparison = if ($null -eq $state) { $null } else { [ordered]@{
    stateUpdatedAt = [string]$state.updatedAt
    stateCompletedFiles = [int]$state.completedFiles
    diskScanCompletedFiles = $completed.Count
    lagFilesAtCapture = $completed.Count - [int]$state.completedFiles
    stateCompletedBytes = [long]$state.completedBytes
    diskScanCompletedBytes = $actualCompletedBytes
  }}
  repoDemSamples = [ordered]@{
    count = $repoDemZips.Count
    bytes = $repoDemBytes
    gib = Get-Gib $repoDemBytes
    files = $repoDemCopies
  }
  landmarkManifests = $landmarkAudits
  downloadsFolderSnapshot = $downloadFolderFiles
  zipIntegrity = [ordered]@{
    auditedZipCount = $zipAudits.Count
    passedZipCount = $zipAudits.Count - $zipFailures.Count
    failedZipCount = $zipFailures.Count
    allPassed = ($zipFailures.Count -eq 0)
    archives = @($zipAudits)
  }
  diskCapacity = $drives
}

$outputDirectory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  [void](New-Item -ItemType Directory -Path $outputDirectory -Force)
}
$output | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output "Wrote $OutputPath"
Write-Output ("ZIP integrity: {0}/{1} passed" -f ($zipAudits.Count - $zipFailures.Count), $zipAudits.Count)
Write-Output ("Geoid prefectures: {0}/47; official ZIPs: {1}" -f $geoidPrefectureZips.Count, $geoidOfficialZips.Count)
Write-Output ("DEM regional archives: {0}/{1}; remaining: {2}" -f $completed.Count, $expectedDemFiles.Count, $missing.Count)
