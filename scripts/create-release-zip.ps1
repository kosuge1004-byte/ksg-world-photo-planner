[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.zip$')]
  [string]$ArchiveName = ("AstroSight-source-{0}.zip" -f (Get-Date -Format 'yyyyMMdd')),
  [string]$OutputDirectory = '',
  [switch]$Force,
  [switch]$ListOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not ('AstroSight.Release.Crc32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;

namespace AstroSight.Release
{
    public static class Crc32
    {
        private static readonly uint[] Table = BuildTable();

        private static uint[] BuildTable()
        {
            var table = new uint[256];
            for (uint i = 0; i < table.Length; i++)
            {
                uint value = i;
                for (var bit = 0; bit < 8; bit++)
                    value = (value & 1) == 1 ? 0xEDB88320U ^ (value >> 1) : value >> 1;
                table[i] = value;
            }
            return table;
        }

        public static uint Compute(Stream input)
        {
            var buffer = new byte[128 * 1024];
            uint crc = UInt32.MaxValue;
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (var i = 0; i < read; i++)
                    crc = Table[(crc ^ buffer[i]) & 0xFF] ^ (crc >> 8);
            }
            return crc ^ UInt32.MaxValue;
        }
    }
}
'@
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$repoPrefix = $repoRoot + [System.IO.Path]::DirectorySeparatorChar
$archiveRoot = 'AstroSight'
$fixedEntryWallClock = [DateTime]::new(2000, 1, 1, 0, 0, 0, [DateTimeKind]::Unspecified)
# ZIP stores a DOS wall-clock timestamp without a time-zone offset. Use the
# local offset for both writing and read-back verification so .NET does not
# shift the fixed clock by the machine's UTC offset.
$fixedEntryTimestamp = [DateTimeOffset]::new(
  $fixedEntryWallClock,
  [TimeZoneInfo]::Local.GetUtcOffset($fixedEntryWallClock)
)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$destination = $OutputDirectory
if ([string]::IsNullOrWhiteSpace($destination)) {
  $destination = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
  if ([string]::IsNullOrWhiteSpace($destination)) {
    throw 'Windows のデスクトップフォルダーを特定できません。'
  }
} elseif (-not [System.IO.Path]::IsPathRooted($destination)) {
  $destination = Join-Path $repoRoot $destination
}
$destination = [System.IO.Path]::GetFullPath($destination).TrimEnd('\', '/')
if (-not [System.IO.Directory]::Exists($destination)) {
  [System.IO.Directory]::CreateDirectory($destination) | Out-Null
}
$outputPath = Join-Path $destination $ArchiveName
$shaPath = $outputPath + '.sha256'
$integrityPath = $outputPath + '.integrity.json'

function Get-RelativePath([string]$fullPath) {
  $resolved = [System.IO.Path]::GetFullPath($fullPath)
  if (-not $resolved.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Repository boundary violation: $resolved"
  }
  return $resolved.Substring($repoPrefix.Length).Replace('\', '/')
}

function Test-IsExampleFile([string]$leafName) {
  $lower = $leafName.ToLowerInvariant()
  return $lower.EndsWith('.example') -or $lower.Contains('.example.')
}

function Get-ExclusionReason([string]$relativePath, [bool]$isDirectory) {
  $path = $relativePath.Replace('\', '/').Trim('/')
  $lower = $path.ToLowerInvariant()
  $segments = $lower.Split('/')
  $leaf = if ($segments.Length -gt 0) { $segments[$segments.Length - 1] } else { '' }

  foreach ($segment in $segments) {
    if ($segment -eq '.git') { return 'git-metadata' }
    if ($segment -eq 'node_modules') { return 'dependencies' }
    if ($segment.StartsWith('.wrangler', [StringComparison]::Ordinal)) { return 'wrangler-state' }
    if ($segment -eq '.cloudflared') { return 'cloudflared-credentials' }
    if ($segment -eq 'evidence') { return 'verification-evidence' }
    if ($segment -eq 'coverage') { return 'coverage-output' }
    if ($segment -eq '.gradle') { return 'android-build-state' }
    if ($segment -eq 'pods') { return 'ios-dependencies' }
    if ($segment -eq '__pycache__') { return 'tool-cache' }
    if ($segment -eq '.cache') { return 'tool-cache' }
    if ($segment -eq 'tmp' -or $segment -eq 'temp' -or $segment.StartsWith('.tmp', [StringComparison]::Ordinal)) {
      return 'temporary-output'
    }
  }

  # Gradle can create build directories in every Android module (including
  # generated Capacitor/Cordova modules), not only android/build and
  # android/app/build. Keep all module build output out of the source archive.
  if ($segments.Length -gt 1 -and $segments[0] -eq 'android' -and $segments -contains 'build') {
    return 'generated-android-asset'
  }

  if ($lower -eq 'public/__astro_internal_geo_tz' -or $lower.StartsWith('public/__astro_internal_geo_tz/')) {
    return 'generated-web-asset'
  }
  if ($lower -eq 'android/build' -or $lower.StartsWith('android/build/') -or
      $lower -eq 'android/app/build' -or $lower.StartsWith('android/app/build/') -or
      $lower -eq 'android/app/src/main/assets/public' -or $lower.StartsWith('android/app/src/main/assets/public/')) {
    return 'generated-android-asset'
  }
  if ($lower -eq 'ios/app/app/public' -or $lower.StartsWith('ios/app/app/public/')) {
    return 'generated-ios-asset'
  }

  # Official GSI downloads live outside the release. The compact runtime model in
  # server/generated and DEM manifests remain included.
  if ($lower -eq 'geoid' -or $lower.StartsWith('geoid/')) { return 'official-geoid-data' }
  if ($lower -eq 'dem/r2-local' -or $lower.StartsWith('dem/r2-local/') -or
      $lower -eq 'dem/r2-ready' -or $lower.StartsWith('dem/r2-ready/') -or
      $lower -eq 'dem/official-archive' -or $lower.StartsWith('dem/official-archive/')) {
    return 'prepared-dem-data'
  }
  if ($lower.StartsWith('dem/') -and
      ($lower.EndsWith('.zip') -or $lower.EndsWith('.7z') -or $lower.EndsWith('.rar') -or
       $lower.EndsWith('.tar') -or $lower.EndsWith('.gz') -or $lower.EndsWith('.xml') -or
       $lower.EndsWith('.gml') -or $lower.EndsWith('.crdownload') -or $lower.EndsWith('.part'))) {
    return 'official-dem-data'
  }

  if (-not $isDirectory) {
    if ($leaf -eq '.env.example' -and $lower -eq '.env.example') {
      # A placeholder-only template is part of the source release.
    } elseif ($leaf -eq '.env' -or $leaf.StartsWith('.env.', [StringComparison]::Ordinal)) {
      return 'environment-secret'
    }
    if ($leaf -eq '.dev.vars' -or $leaf.StartsWith('.dev.vars.', [StringComparison]::Ordinal)) {
      return 'worker-secret'
    }
    if ($leaf -eq '.npmrc' -or $leaf -eq '.netrc' -or $leaf -eq '_netrc' -or
        $leaf -eq '.pypirc' -or $leaf.StartsWith('.secrets', [StringComparison]::Ordinal)) {
      return 'credential-file'
    }
    if ($leaf.EndsWith('.log') -or $leaf.EndsWith('.tmp') -or $leaf.EndsWith('.bak') -or $leaf.EndsWith('.swp')) {
      return 'log-or-temporary-file'
    }
    if ($leaf.EndsWith('_verification_result.json') -or $leaf.EndsWith('-verification-result.json')) {
      return 'verification-evidence'
    }
    if (-not (Test-IsExampleFile $leaf)) {
      if ($leaf -eq 'cert.pem' -or $leaf.EndsWith('.key') -or $leaf.EndsWith('.pfx') -or
          $leaf.EndsWith('.p12') -or $leaf.EndsWith('.jks') -or $leaf.EndsWith('.keystore') -or
          $leaf.EndsWith('.mobileprovision') -or $leaf.EndsWith('.cer') -or $leaf.EndsWith('.pem')) {
        return 'private-key-or-signing-file'
      }
      if ($leaf -match '(?:^|[-_.])(tunnel[-_.]?credentials?|credentials?|service[-_.]?account|client[-_.]?secret)(?:[-_.]|$).*\.json$') {
        return 'credential-json'
      }
    }
  }

  return $null
}

function Get-ReleaseFiles {
  $pending = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
  $pending.Push((Get-Item -LiteralPath $repoRoot -Force))
  $pathMap = New-Object 'System.Collections.Generic.Dictionary[string,System.IO.FileInfo]' ([StringComparer]::Ordinal)
  $excludedCounts = New-Object 'System.Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal)

  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in $directory.GetFileSystemInfos()) {
      $relative = Get-RelativePath $item.FullName
      $isDirectory = ($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0
      $reason = Get-ExclusionReason $relative $isDirectory
      if ($reason) {
        if (-not $excludedCounts.ContainsKey($reason)) { $excludedCounts[$reason] = 0 }
        $excludedCounts[$reason] += 1
        continue
      }
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        if (-not $excludedCounts.ContainsKey('reparse-point')) { $excludedCounts['reparse-point'] = 0 }
        $excludedCounts['reparse-point'] += 1
        continue
      }
      if ($isDirectory) {
        $pending.Push([System.IO.DirectoryInfo]$item)
      } else {
        if ($pathMap.ContainsKey($relative)) { throw "Duplicate source path: $relative" }
        $pathMap.Add($relative, [System.IO.FileInfo]$item)
      }
    }
  }

  $paths = New-Object 'System.Collections.Generic.List[string]'
  foreach ($path in $pathMap.Keys) { $paths.Add($path) }
  $paths.Sort([StringComparer]::Ordinal)

  $records = New-Object 'System.Collections.Generic.List[object]'
  foreach ($path in $paths) {
    $file = $pathMap[$path]
    $records.Add([pscustomobject]@{
      RelativePath = $path
      FullName = $file.FullName
      Length = [int64]$file.Length
      LastWriteTimeUtcTicks = [int64]$file.LastWriteTimeUtc.Ticks
    })
  }

  return [pscustomobject]@{ Files = $records; ExcludedCounts = $excludedCounts }
}

function Assert-RequiredContents($records) {
  $selected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($record in $records) { [void]$selected.Add($record.RelativePath) }

  $requiredFiles = @(
    'package.json',
    'package-lock.json',
    'vite.config.ts',
    'tsconfig.json',
    '.env.example',
    'wrangler.jsonc',
    'src/App.tsx',
    'server/gsiElevation.ts',
    'functions/api/gsi-elevation.ts',
    'workers/spot-search-consumer.ts',
    'tools/local-dem-server/server.ts',
    'scripts/create-release-zip.ps1'
  )
  foreach ($required in $requiredFiles) {
    if (-not $selected.Contains($required)) { throw "Required release file is missing: $required" }
  }

  foreach ($prefix in @('src/', 'server/', 'functions/', 'workers/', 'docs/', 'tools/local-dem-server/', 'tests/', 'dist/')) {
    $found = $false
    foreach ($record in $records) {
      if ($record.RelativePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        $found = $true
        break
      }
    }
    if (-not $found) { throw "Required release section is empty: $prefix" }
  }
}

function Test-IsTextEntry([string]$relativePath) {
  $leaf = [System.IO.Path]::GetFileName($relativePath).ToLowerInvariant()
  if ($leaf -in @('.gitignore', '.gitattributes', '.editorconfig', 'dockerfile')) { return $true }
  $extension = [System.IO.Path]::GetExtension($leaf)
  return $extension -in @(
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.txt',
    '.yml', '.yaml', '.toml', '.xml', '.html', '.css', '.scss', '.less', '.svg',
    '.csv', '.properties', '.gradle', '.kts', '.java', '.kt', '.sh', '.ps1', '.py',
    '.webmanifest', '.conf', '.config', '.ini'
  )
}

function Get-StringSha256([string]$value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $utf8NoBom.GetBytes($value)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Test-IsPlaceholderValue([string]$value) {
  $candidate = $value.Trim()
  if ([string]::IsNullOrWhiteSpace($candidate)) { return $true }
  if ($candidate.StartsWith('<') -or $candidate.StartsWith('${') -or $candidate.StartsWith('$env:')) { return $true }
  $lower = $candidate.ToLowerInvariant()
  return $lower.Contains('placeholder') -or $lower.Contains('replace-me') -or
    $lower.Contains('replace_me') -or $lower.Contains('your-') -or $lower.Contains('your_') -or
    $lower.Contains('example') -or $lower.Contains('for-tests') -or $lower.Contains('test-') -or
    $lower.Contains('dummy') -or $lower.Contains('fixture') -or $lower.Contains('process.env') -or
    $lower.Contains('import.meta.env')
}

function Find-SecretsInText([string]$relativePath, [string]$text) {
  $findings = New-Object 'System.Collections.Generic.List[string]'
  $allowedVendorJwtCount = 0
  $jwtPattern = 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'
  $allowedCesiumVendorJwtSha256 = 'd7f2994e9c528046e6e31f86a636fb18204e9b5385717fb2bf2fed2aa13357f4'
  foreach ($match in [regex]::Matches($text, $jwtPattern)) {
    $hash = Get-StringSha256 $match.Value
    $isCesiumVendorPath = $relativePath.Replace('\', '/').EndsWith('/cesium/Cesium.js', [StringComparison]::OrdinalIgnoreCase) -or
      $relativePath.Replace('\', '/').Equals('dist/cesium/Cesium.js', [StringComparison]::OrdinalIgnoreCase)
    if ($isCesiumVendorPath -and $hash -eq $allowedCesiumVendorJwtSha256) {
      $allowedVendorJwtCount += 1
    } else {
      $findings.Add('JWT/access token')
    }
  }

  $literalRules = [ordered]@{
    'private key' = '-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'
    'Cloudflare token' = 'cfast_[A-Za-z0-9_-]{16,}'
    'GitHub token' = '(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'
    'OpenAI token' = '(?:sk-proj-|sk-)[A-Za-z0-9_-]{20,}'
    'Slack token' = 'xox[baprs]-[A-Za-z0-9-]{16,}'
    'AWS access key' = '(?:AKIA|ASIA)[A-Z0-9]{16}'
    'Google API key' = 'AIza[0-9A-Za-z_-]{35}'
    'Cloudflare Access client id' = '(?i)[a-f0-9]{32}\.access'
    'literal bearer credential' = '(?i)Bearer[ \t]+[A-Za-z0-9._~+/-]{20,}'
  }
  foreach ($name in $literalRules.Keys) {
    if ([regex]::IsMatch($text, $literalRules[$name])) { $findings.Add($name) }
  }

  $secretNamePattern = '(?i)LOCAL_DEM_ORIGIN_TOKEN|LOCAL_DEM_ACCESS_CLIENT_SECRET|CF_ACCESS_CLIENT_SECRET|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|TUNNEL_TOKEN|tunnelSecret|api[_-]?secret|client[_-]?secret'
  $quotedValuePattern = "[=:][ \t]*[`"'](?<value>[^`"'\r\n]{16,})[`"']"
  foreach ($line in ($text -split "`r?`n")) {
    $nameMatch = [regex]::Match($line, $secretNamePattern)
    if (-not $nameMatch.Success) { continue }
    $valueMatch = [regex]::Match($line.Substring($nameMatch.Index + $nameMatch.Length), $quotedValuePattern)
    if ($valueMatch.Success -and -not (Test-IsPlaceholderValue $valueMatch.Groups['value'].Value)) {
      $findings.Add("literal value for $($nameMatch.Value)")
    }
  }

  return [pscustomobject]@{
    Findings = @($findings | Select-Object -Unique)
    AllowedVendorJwtCount = $allowedVendorJwtCount
  }
}

function Scan-SourceSecrets($records) {
  $findings = New-Object 'System.Collections.Generic.List[string]'
  $allowedVendorJwtCount = 0
  foreach ($record in $records) {
    if (-not (Test-IsTextEntry $record.RelativePath)) { continue }
    if ($record.Length -gt 64MB) {
      $findings.Add("$($record.RelativePath): text file exceeds 64 MiB scan limit")
      continue
    }
    $text = [System.IO.File]::ReadAllText($record.FullName, $utf8NoBom)
    $result = Find-SecretsInText $record.RelativePath $text
    $allowedVendorJwtCount += $result.AllowedVendorJwtCount
    foreach ($finding in $result.Findings) { $findings.Add("$($record.RelativePath): $finding") }
  }
  return [pscustomobject]@{ Findings = $findings; AllowedVendorJwtCount = $allowedVendorJwtCount }
}

function New-DeterministicZip([string]$temporaryPath, $records) {
  $fileStream = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create, $true, $utf8NoBom)
    try {
      foreach ($record in $records) {
        $current = Get-Item -LiteralPath $record.FullName -Force
        if ($current.Length -ne $record.Length -or $current.LastWriteTimeUtc.Ticks -ne $record.LastWriteTimeUtcTicks) {
          throw "Source changed while packaging: $($record.RelativePath)"
        }
        $entryName = "$archiveRoot/$($record.RelativePath)"
        $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $fixedEntryTimestamp
        $entry.ExternalAttributes = 0
        $input = [System.IO.File]::Open($record.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        try {
          $output = $entry.Open()
          try { $input.CopyTo($output, 128 * 1024) } finally { $output.Dispose() }
        } finally {
          $input.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $fileStream.Dispose()
  }
}

function Get-CentralDirectoryCrcMap([string]$zipPath) {
  $map = New-Object 'System.Collections.Generic.Dictionary[string,uint32]' ([StringComparer]::Ordinal)
  $stream = [System.IO.File]::OpenRead($zipPath)
  try {
    $tailLength = [Math]::Min([int64]65557, $stream.Length)
    [void]$stream.Seek(-$tailLength, [System.IO.SeekOrigin]::End)
    $tail = New-Object byte[] ([int]$tailLength)
    $offset = 0
    while ($offset -lt $tail.Length) {
      $read = $stream.Read($tail, $offset, $tail.Length - $offset)
      if ($read -eq 0) { throw 'Unexpected EOF while reading ZIP end record.' }
      $offset += $read
    }
    $eocd = -1
    for ($i = $tail.Length - 22; $i -ge 0; $i--) {
      if ($tail[$i] -eq 0x50 -and $tail[$i + 1] -eq 0x4b -and $tail[$i + 2] -eq 0x05 -and $tail[$i + 3] -eq 0x06) {
        $eocd = $i
        break
      }
    }
    if ($eocd -lt 0) { throw 'ZIP end-of-central-directory record not found.' }
    $entryCount = [BitConverter]::ToUInt16($tail, $eocd + 10)
    $centralOffset = [BitConverter]::ToUInt32($tail, $eocd + 16)
    if ($entryCount -eq 0xffff -or $centralOffset -eq 0xffffffff) { throw 'ZIP64 archives are not expected for this source release.' }
    [void]$stream.Seek($centralOffset, [System.IO.SeekOrigin]::Begin)
    $reader = New-Object System.IO.BinaryReader($stream, $utf8NoBom, $true)
    try {
      for ($entryIndex = 0; $entryIndex -lt $entryCount; $entryIndex++) {
        $header = $reader.ReadBytes(46)
        if ($header.Length -ne 46 -or [BitConverter]::ToUInt32($header, 0) -ne 0x02014b50) {
          throw "Invalid ZIP central-directory record at entry $entryIndex."
        }
        $flags = [BitConverter]::ToUInt16($header, 8)
        $crc = [BitConverter]::ToUInt32($header, 16)
        $nameLength = [BitConverter]::ToUInt16($header, 28)
        $extraLength = [BitConverter]::ToUInt16($header, 30)
        $commentLength = [BitConverter]::ToUInt16($header, 32)
        $nameBytes = $reader.ReadBytes($nameLength)
        if ($nameBytes.Length -ne $nameLength) { throw 'Unexpected EOF in ZIP entry name.' }
        $encoding = if (($flags -band 0x0800) -ne 0) { $utf8NoBom } else { $utf8NoBom }
        $name = $encoding.GetString($nameBytes)
        if ($map.ContainsKey($name)) { throw "Duplicate ZIP central-directory entry: $name" }
        $map.Add($name, $crc)
        if ($extraLength + $commentLength -gt 0) {
          [void]$stream.Seek($extraLength + $commentLength, [System.IO.SeekOrigin]::Current)
        }
      }
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  return $map
}

function Test-ReleaseZip([string]$zipPath, $records) {
  $expected = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  foreach ($record in $records) { $expected.Add("$archiveRoot/$($record.RelativePath)", $record) }
  $centralCrc = Get-CentralDirectoryCrcMap $zipPath
  $seenInsensitive = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $secretFindings = New-Object 'System.Collections.Generic.List[string]'
  $allowedVendorJwtCount = 0
  [int64]$uncompressedBytes = 0

  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    if ($archive.Entries.Count -ne $records.Count) {
      throw "ZIP entry count mismatch: expected $($records.Count), got $($archive.Entries.Count)"
    }
    foreach ($entry in $archive.Entries) {
      if (-not $seenInsensitive.Add($entry.FullName)) { throw "Duplicate ZIP entry (case-insensitive): $($entry.FullName)" }
      if ($entry.FullName.Contains('\\') -or $entry.FullName.StartsWith('/') -or $entry.FullName.Contains('../')) {
        throw "Unsafe ZIP entry path: $($entry.FullName)"
      }
      if (-not $expected.ContainsKey($entry.FullName)) { throw "Unexpected ZIP entry: $($entry.FullName)" }
      if (-not $centralCrc.ContainsKey($entry.FullName)) { throw "Missing ZIP CRC record: $($entry.FullName)" }
      $record = $expected[$entry.FullName]
      if ($entry.Length -ne $record.Length) { throw "ZIP length mismatch: $($entry.FullName)" }
      if ($entry.LastWriteTime.UtcDateTime -ne $fixedEntryTimestamp.UtcDateTime) {
        throw "Non-deterministic ZIP timestamp: $($entry.FullName)"
      }
      $input = $entry.Open()
      try { $actualCrc = [AstroSight.Release.Crc32]::Compute($input) } finally { $input.Dispose() }
      if ([uint32]$actualCrc -ne [uint32]$centralCrc[$entry.FullName]) {
        throw "ZIP CRC mismatch: $($entry.FullName)"
      }
      $uncompressedBytes += $entry.Length

      if (Test-IsTextEntry $record.RelativePath) {
        if ($entry.Length -gt 64MB) {
          $secretFindings.Add("$($record.RelativePath): text file exceeds 64 MiB scan limit")
        } else {
          $textStream = $entry.Open()
          try {
            $reader = New-Object System.IO.StreamReader($textStream, $utf8NoBom, $true)
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
          } finally {
            $textStream.Dispose()
          }
          $scan = Find-SecretsInText $record.RelativePath $text
          $allowedVendorJwtCount += $scan.AllowedVendorJwtCount
          foreach ($finding in $scan.Findings) { $secretFindings.Add("$($record.RelativePath): $finding") }
        }
      }
    }
  } finally {
    $archive.Dispose()
  }

  if ($centralCrc.Count -ne $records.Count) { throw 'ZIP central-directory entry count mismatch.' }
  if ($secretFindings.Count -gt 0) {
    throw ("Secret scan failed (values are intentionally hidden):`n - " + ($secretFindings -join "`n - "))
  }
  return [pscustomobject]@{
    EntryCount = $records.Count
    UncompressedBytes = $uncompressedBytes
    AllowedCesiumVendorJwtCount = $allowedVendorJwtCount
  }
}

function Write-Utf8NoBom([string]$path, [string]$content) {
  [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

$selection = Get-ReleaseFiles
$records = $selection.Files
Assert-RequiredContents $records
$sourceScan = Scan-SourceSecrets $records
if ($sourceScan.Findings.Count -gt 0) {
  throw ("Source secret scan failed (values are intentionally hidden):`n - " + ($sourceScan.Findings -join "`n - "))
}

[int64]$selectedBytes = 0
foreach ($record in $records) { $selectedBytes += $record.Length }

if ($ListOnly) {
  foreach ($record in $records) { Write-Output $record.RelativePath }
  Write-Output ("LIST ONLY: {0} files, {1:N0} bytes, secret scan passed, {2} audited Cesium vendor JWT occurrence(s)." -f $records.Count, $selectedBytes, $sourceScan.AllowedVendorJwtCount)
  Write-Output 'No archive or sidecar was created.'
  exit 0
}

$artifacts = @($outputPath, $shaPath, $integrityPath)
foreach ($artifact in $artifacts) {
  $parent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($artifact)).TrimEnd('\', '/')
  if (-not $parent.Equals($destination, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release artifacts must stay directly in the selected output directory: $artifact"
  }
  if ([System.IO.File]::Exists($artifact) -and -not $Force) {
    throw "Release artifact already exists. Use -Force to replace it: $artifact"
  }
}

$temporaryPath = Join-Path $destination (".{0}.{1}.partial" -f $ArchiveName, [Guid]::NewGuid().ToString('N'))
try {
  New-DeterministicZip $temporaryPath $records
  $verification = Test-ReleaseZip $temporaryPath $records
  $zipHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $zipLength = (Get-Item -LiteralPath $temporaryPath).Length

  foreach ($artifact in $artifacts) {
    if ([System.IO.File]::Exists($artifact)) { [System.IO.File]::Delete($artifact) }
  }
  [System.IO.File]::Move($temporaryPath, $outputPath)

  Write-Utf8NoBom $shaPath ("{0} *{1}`n" -f $zipHash, $ArchiveName)
  $excluded = [ordered]@{}
  $excludedKeys = New-Object 'System.Collections.Generic.List[string]'
  foreach ($key in $selection.ExcludedCounts.Keys) { $excludedKeys.Add($key) }
  $excludedKeys.Sort([StringComparer]::Ordinal)
  foreach ($key in $excludedKeys) { $excluded[$key] = $selection.ExcludedCounts[$key] }

  $integrity = [ordered]@{
    schemaVersion = 1
    archiveName = $ArchiveName
    archiveRoot = $archiveRoot
    sha256 = $zipHash
    bytes = $zipLength
    entryCount = $verification.EntryCount
    uncompressedBytes = $verification.UncompressedBytes
    verification = [ordered]@{
      duplicateEntries = 0
      everyEntryReadable = $true
      everyEntryCrc32Verified = $true
      safeEntryPaths = $true
      secretScanPassed = $true
      allowedCesiumVendorJwtSha256 = 'd7f2994e9c528046e6e31f86a636fb18204e9b5385717fb2bf2fed2aa13357f4'
      allowedCesiumVendorJwtOccurrences = $verification.AllowedCesiumVendorJwtCount
    }
    deterministicArchive = [ordered]@{
      entryOrder = 'ordinal'
      entryTimestampZipWallClock = $fixedEntryWallClock.ToString('yyyy-MM-ddTHH:mm:ss')
      compression = 'optimal'
    }
    excludedItemCounts = $excluded
  }
  Write-Utf8NoBom $integrityPath (($integrity | ConvertTo-Json -Depth 8) + "`n")

  Write-Output "Release ZIP: $outputPath"
  Write-Output "SHA-256:    $zipHash"
  Write-Output "Sidecar:    $shaPath"
  Write-Output "Integrity:  $integrityPath"
  Write-Output ("Verified {0} entries; CRC/readability and secret scan passed." -f $verification.EntryCount)
} finally {
  if ([System.IO.File]::Exists($temporaryPath)) { [System.IO.File]::Delete($temporaryPath) }
}
