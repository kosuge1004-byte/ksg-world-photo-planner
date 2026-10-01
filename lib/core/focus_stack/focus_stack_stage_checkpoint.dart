import 'package:crypto/crypto.dart';
import '../background/durable_decoded_frame_cache.dart';
import 'dart:convert';
import 'dart:io';

import '../registration/affine_sampling_transform.dart';
import 'file_backed_focus_winner_map.dart';

/// Durable, resumable checkpoint for the focus-stack work that runs after
/// per-frame RAW decode and before the final blend: per-frame geometric
/// alignment, the modified-Laplacian focus-measure files, winner selection,
/// and the two-pass regularization.
///
/// `DurableFocusFrameCache` already makes decode durable. Everything this
/// store covers previously lived only under `Directory.systemTemp` and was
/// unconditionally deleted in `runFocusStackPipeline`'s `finally` block, so a
/// process death or job kill during this phase always restarted it from the
/// first frame even when every decoded frame was already safely cached.
///
/// This module changes none of the alignment, focus-measure, selection, or
/// regularization algorithms and computes nothing itself. It only gives
/// their existing file outputs a durable home (`directory`, used directly as
/// the pipeline's `measureDirectory`) and a manifest to validate them
/// against on restart.
///
/// [identity] is treated as an opaque string the caller must already have
/// derived from everything that affects these outputs byte-for-byte: the
/// selected/decoded frame identities, the reference index, the alignment
/// tile size, and the alignment/measure/selection/regularization algorithm
/// revision. This store never derives, widens, or infers that identity
/// itself, and a manifest whose stored identity does not match exactly is
/// always treated as "nothing to resume" — the whole checkpoint directory is
/// wiped and rebuilt from scratch — rather than partially reused. Reusing a
/// mismatched intermediate file (e.g. after a settings change) would risk
/// silently blending stale alignment or focus-measure data into the final
/// image, which is strictly worse than recomputing it.
final class FocusStackStageCheckpointStore {
  FocusStackStageCheckpointStore({
    required this.directory,
    required this.identity,
  });

  static const int _version = 2;

  /// The durable directory this checkpoint owns. The pipeline uses it
  /// directly as `measureDirectory`, so every measure/winner file it already
  /// writes lands here with no extra copying.
  final Directory directory;
  final String identity;

  String get _manifestPath =>
      '${directory.path}${Platform.pathSeparator}focus_stage_checkpoint_v1.json';

  Map<String, dynamic>? _manifest;

  Future<Map<String, dynamic>> _ensureLoaded() async {
    final Map<String, dynamic>? loaded = _manifest;
    if (loaded != null) return loaded;
    final File file = File(_manifestPath);
    Map<String, dynamic>? matched;
    try {
      if (await file.exists()) {
        final Object? decoded = jsonDecode(await file.readAsString());
        if (decoded is Map &&
            decoded['version'] == _version &&
            decoded['identity'] == identity &&
            decoded['integritySha256'] == _manifestHash(decoded)) {
          matched = decoded.cast<String, dynamic>();
        }
      }
    } on Object {
      matched = null;
    }
    if (matched != null) {
      return _manifest = matched;
    }
    // No manifest, an unreadable one, or one for a different identity: any
    // of these means nothing already on disk here can be trusted, so start
    // this checkpoint over completely rather than mixing generations.
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
    await directory.create(recursive: true);
    return _manifest = <String, dynamic>{
      'version': _version,
      'identity': identity,
      'transforms': <String, dynamic>{},
      'measureFiles': <String, dynamic>{},
      'winners': null,
    };
  }

  static String _manifestHash(Map value) => sha256
      .convert(utf8.encode(jsonEncode({
        for (final entry in value.entries)
          if (entry.key != 'integritySha256') entry.key: entry.value,
      })))
      .toString();

  Future<void> _persist() async {
    final Map<String, dynamic> manifest = _manifest!;
    await directory.create(recursive: true);
    final File destination = File(_manifestPath);
    final File temp = File(
      '$_manifestPath.tmp.${pid.toString()}.${DateTime.now().microsecondsSinceEpoch}',
    );
    manifest['integritySha256'] = _manifestHash(manifest);
    await temp.writeAsString(jsonEncode(manifest), flush: true);
    await temp.rename(destination.path);
  }

  /// The recorded sampling transform for frame [index], or null if none is
  /// recorded. Never returns a transform for a different identity: identity
  /// mismatch is handled by wiping the whole manifest in [_ensureLoaded]
  /// before this can be reached.
  Future<AffineSamplingTransform?> restoreTransform(int index) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    final Map<String, dynamic> transforms =
        (manifest['transforms'] as Map).cast<String, dynamic>();
    final List<dynamic>? values = transforms['$index'] as List<dynamic>?;
    if (values == null || values.length != 6) return null;
    try {
      final List<double> m = values
          .map((dynamic v) => (v as num).toDouble())
          .toList(growable: false);
      return AffineSamplingTransform(
        m00: m[0],
        m01: m[1],
        m02: m[2],
        m10: m[3],
        m11: m[4],
        m12: m[5],
      );
    } on Object {
      // A corrupt/truncated entry for this one frame must not take down the
      // rest of the checkpoint; the caller simply recomputes this frame.
      return null;
    }
  }

  Future<void> recordTransform(int index, AffineSamplingTransform t) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    final Map<String, dynamic> transforms =
        (manifest['transforms'] as Map).cast<String, dynamic>();
    transforms['$index'] = <double>[t.m00, t.m01, t.m02, t.m10, t.m11, t.m12];
    manifest['transforms'] = transforms;
    await _persist();
  }

  /// The recorded, still-valid focus-measure file for frame [index], or null
  /// if nothing is recorded or the file no longer matches its recorded
  /// length (deleted, truncated, or overwritten out from under us).
  Future<File?> restoreMeasureFile(int index) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    final Map<String, dynamic> files =
        (manifest['measureFiles'] as Map).cast<String, dynamic>();
    final Map<String, dynamic>? entry =
        (files['$index'] as Map?)?.cast<String, dynamic>();
    if (entry == null) return null;
    final String? path = entry['path'] as String?;
    final int? bytes = (entry['bytes'] as num?)?.toInt();
    if (path == null || bytes == null) return null;
    final File file = File(path);
    if (!await file.exists()) return null;
    if (await file.length() != bytes ||
        await DurableDecodedFrameCache.fileHash(file) != entry['sha256']) {
      return null;
    }
    return file;
  }

  Future<void> recordMeasureFile(int index, File file) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    final Map<String, dynamic> files =
        (manifest['measureFiles'] as Map).cast<String, dynamic>();
    files['$index'] = <String, dynamic>{
      'path': file.path,
      'bytes': await file.length(),
      'sha256': await DurableDecodedFrameCache.fileHash(file),
    };
    manifest['measureFiles'] = files;
    await _persist();
  }

  /// Reopens the durable regularized winner map recorded for this identity
  /// and [width]/[height], or null if nothing valid is recorded. The
  /// returned map's files live inside [directory]; the caller must not
  /// dispose (delete) them except by calling [clear] on this whole
  /// checkpoint, since disposal here would also destroy files a future
  /// restart needs.
  Future<FileBackedFocusWinnerMap?> restoreWinners({
    required int width,
    required int height,
  }) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    final Map<String, dynamic>? winners =
        (manifest['winners'] as Map?)?.cast<String, dynamic>();
    if (winners == null) return null;
    if ((winners['width'] as num?)?.toInt() != width ||
        (winners['height'] as num?)?.toInt() != height) {
      return null;
    }
    final String? prefix = winners['prefix'] as String?;
    final int? labelBytes = (winners['labelBytes'] as num?)?.toInt();
    final int? confidenceBytes = (winners['confidenceBytes'] as num?)?.toInt();
    if (prefix == null || labelBytes == null || confidenceBytes == null) {
      return null;
    }
    try {
      if (await DurableDecodedFrameCache.fileHash(File(
                  '${directory.path}${Platform.pathSeparator}$prefix.i32')) !=
              winners['labelSha256'] ||
          await DurableDecodedFrameCache.fileHash(File(
                  '${directory.path}${Platform.pathSeparator}$prefix.f32')) !=
              winners['confidenceSha256']) {
        return null;
      }
      return await FileBackedFocusWinnerMap.openExisting(
        directory: directory,
        width: width,
        height: height,
        prefix: prefix,
        expectedLabelBytes: labelBytes,
        expectedConfidenceBytes: confidenceBytes,
      );
    } on Object {
      // Missing/truncated/wrong-length files: treat exactly like "nothing
      // recorded" so the caller falls back to recomputing winner selection
      // and regularization from the (already durable) measure files.
      return null;
    }
  }

  Future<void> recordWinners(FileBackedFocusWinnerMap winners) async {
    final Map<String, dynamic> manifest = await _ensureLoaded();
    manifest['winners'] = <String, dynamic>{
      'width': winners.width,
      'height': winners.height,
      'prefix': winners.prefix,
      'labelBytes': await winners.labelsFile.length(),
      'confidenceBytes': await winners.confidenceFile.length(),
      'labelSha256':
          await DurableDecodedFrameCache.fileHash(winners.labelsFile),
      'confidenceSha256':
          await DurableDecodedFrameCache.fileHash(winners.confidenceFile),
    };
    await _persist();
  }

  /// Discards this checkpoint's manifest and every durable file inside
  /// [directory]. Callers invoke this once the pipeline result this
  /// checkpoint was for has itself been durably committed further downstream
  /// (e.g. exported, or captured by an outer checkpoint), or when
  /// deliberately starting over (e.g. the user changed alignment settings).
  Future<void> clear() async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
    _manifest = null;
  }
}
