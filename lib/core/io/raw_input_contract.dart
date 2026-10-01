import 'dart:typed_data';

import 'package:path/path.dart' as p;

import '../raw/raw_metadata_probe.dart';
import '../raw/raw_probe_result.dart';

class RawInputFile {
  const RawInputFile({
    required this.path,
    required this.byteLength,
    this.displayName,
    this.probe,
    this.metadata,
    this.thumbnailBytes,
  });

  final String path;
  final int byteLength;
  final String? displayName;
  final RawProbeResult? probe;
  final RawMetadataProbeResult? metadata;
  final Uint8List? thumbnailBytes;

  String get name => displayName ?? p.basename(path);
}

class RawInputRejection {
  const RawInputRejection({
    required this.path,
    required this.reason,
    this.displayName,
  });

  final String path;
  final String reason;
  final String? displayName;

  String get name => displayName ?? p.basename(path);
}

class RawSelectionResult {
  const RawSelectionResult({
    required this.files,
    required this.rejected,
  });

  const RawSelectionResult.empty()
      : files = const <RawInputFile>[],
        rejected = const <RawInputRejection>[];

  final List<RawInputFile> files;
  final List<RawInputRejection> rejected;
}

abstract interface class RawInputReader {
  Future<RawSelectionResult> selectRawFiles();
}
