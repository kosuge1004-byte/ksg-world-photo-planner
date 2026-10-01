import '../raw/raw_decoder_contract.dart';
import '../image/cfa_pattern.dart';
import 'durable_milky_way_frame_cache.dart';
import '../session/milky_way_tile_combine_checkpoint.dart';
import 'synthetic_gap_mask.dart';
import 'durable_decoded_frame_cache.dart';
import '../stacking/foreground_region.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../diagnostics/diagnostic_log.dart';
import '../engine/adaptive_resource_controller.dart';
import '../engine/concurrency_policy.dart';
import '../engine/default_resource_reader.dart';
import '../engine/job_scheduler.dart';
import '../engine/memory_admission_controller.dart';
import '../engine/phase2_validated_job_executor.dart';
import '../engine/prepare_master_calibration_frame.dart';
import '../engine/processing_job.dart';
import '../export/dng_final_render_profile.dart';
import '../export/export_result.dart'
    show
        ExportCancelled,
        estimateFixedToneBaselineFromReferenceFrame,
        exportTileStoreToImage;
import '../export/lightroom_storage_preset.dart';
import '../export/tone_map.dart' show AutoToneParameters;
import '../export/output_image_format.dart';
import '../export/reference_render_profile_selection.dart';
import '../image/downscale_linear_rgb_store.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/float64_rgb_tile_store.dart';
import '../image/linear_contribution_tile_store.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import '../models/processing_mode.dart';
import '../quality/processing_quality_level.dart';
import '../raw/native_raw_decoder_factory.dart';
import '../raw/raw_decoder_registry.dart';
import '../raw/raw_metadata_probe.dart';
import '../session/export_pipeline_result.dart';
import '../session/meteor_pipeline.dart';
import '../session/milky_way_pipeline.dart';
import '../session/star_trail_pipeline.dart';
import '../stacking/star_trail_edge_fade.dart';
import '../registration/star_detector.dart' show DetectedStar;
import '../registration/star_psf_quality.dart';
import '../registration/flat_sky_noise_quality.dart';
import '../meteor/streak_candidate_detector.dart' show StreakCandidate;
import '../meteor/streak_shape.dart' show StreakShape;
import '../stacking/star_trail_gap_fill_drawer.dart';
import '../stacking/star_trail_gap_fill.dart';
import '../stacking/tiled_weighted_average_combiner.dart';
import '../stacking/tiled_kappa_sigma_combiner.dart'
    show TiledStackingCancelled;
import '../tiles/overlapped_tile_plan.dart';
import 'external_stall_watchdog.dart';
import 'completion_attempt_history.dart';
import 'post_decode_pipeline_checkpoint_store.dart';
import 'rolling_weighted_average_checkpoint_store.dart';
import 'stack_job_reporter.dart';
import 'stack_operation_journal.dart';
import '../stacking/star_trail_hot_pixels.dart';
import '../stacking/star_trail_mean_background.dart';

const String standardStackBackgroundTask = 'standard_stack_background';

/// Work355: per-frame stationary-point candidates for star-trail hot-pixel
/// removal, bound to the source file like the compact features.
final class _StarTrailHotCandidateStore {
  _StarTrailHotCandidateStore({
    required String statusPath,
    required this.sourcePaths,
  }) : _directory = Directory(
          '${File(statusPath).parent.path}${Platform.pathSeparator}'
          'star_trail_hot_candidates_v1',
        );

  final Directory _directory;
  final List<String> sourcePaths;

  String _pathFor(int index) =>
      '${_directory.path}${Platform.pathSeparator}frame_$index.json';

  Future<Int32List?> restore(int index, {required int width}) async {
    try {
      final File file = File(_pathFor(index));
      if (!await file.exists()) return null;
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map) return null;
      final Map<String, dynamic> m = decoded.cast<String, dynamic>();
      final FileStat stat = await File(sourcePaths[index]).stat();
      if ((m['version'] as num?)?.toInt() != 1 ||
          m['sourcePath'] != sourcePaths[index] ||
          (m['sourceBytes'] as num?)?.toInt() != stat.size ||
          (m['sourceModifiedEpochMs'] as num?)?.toInt() !=
              stat.modified.millisecondsSinceEpoch ||
          (m['width'] as num?)?.toInt() != width) {
        return null;
      }
      return Int32List.fromList(<int>[
        for (final Object? v in (m['candidates'] as List)) (v as num).toInt(),
      ]);
    } on Object {
      return null;
    }
  }

  Future<void> save(int index, int width, Int32List candidates) async {
    await _directory.create(recursive: true);
    final FileStat stat = await File(sourcePaths[index]).stat();
    final File destination = File(_pathFor(index));
    final File temp = File(
        '${destination.path}.tmp.$pid.${DateTime.now().microsecondsSinceEpoch}');
    await temp.writeAsString(
      jsonEncode(<String, Object?>{
        'version': 1,
        'sourcePath': sourcePaths[index],
        'sourceBytes': stat.size,
        'sourceModifiedEpochMs': stat.modified.millisecondsSinceEpoch,
        'width': width,
        'candidates': candidates,
      }),
      flush: true,
    );
    try {
      await temp.rename(destination.path);
    } on FileSystemException {
      if (await destination.exists()) await destination.delete();
      await temp.rename(destination.path);
    }
  }

  Future<void> cleanupAll() async {
    if (await _directory.exists()) await _directory.delete(recursive: true);
  }
}

final class _StarTrailCompactFeatureCheckpointStore {
  _StarTrailCompactFeatureCheckpointStore({
    required String statusPath,
    required this.sourcePaths,
  }) : _directory = Directory(
          '${File(statusPath).parent.path}${Platform.pathSeparator}'
          'star_trail_compact_features_v1',
        );

  final Directory _directory;
  final List<String> sourcePaths;

  String _pathFor(int index) =>
      '${_directory.path}${Platform.pathSeparator}frame_$index.json';

  Future<MeteorCompactFrameFeatures?> restore(int index) async {
    try {
      final File file = File(_pathFor(index));
      if (!await file.exists()) return null;
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map) return null;
      final Map<String, dynamic> m = decoded.cast<String, dynamic>();
      if ((m['version'] as num?)?.toInt() != 1) return null;
      final File source = File(sourcePaths[index]);
      final FileStat stat = await source.stat();
      if (m['sourcePath'] != sourcePaths[index] ||
          (m['sourceBytes'] as num?)?.toInt() != stat.size ||
          (m['sourceModifiedEpochMs'] as num?)?.toInt() !=
              stat.modified.millisecondsSinceEpoch) {
        return null;
      }
      final List<StreakCandidate> streaks = <StreakCandidate>[
        for (final Object? raw in (m['streaks'] as List? ?? const <Object?>[]))
          _streakFromJson((raw as Map).cast<String, dynamic>()),
      ];
      final List<DetectedStar> stars = <DetectedStar>[
        for (final Object? raw in (m['stars'] as List? ?? const <Object?>[]))
          _starFromJson((raw as Map).cast<String, dynamic>()),
      ];
      final List<bool> blinking = <bool>[
        for (final Object? v
            in (m['likelyBlinking'] as List? ?? const <Object?>[]))
          v == true,
      ];
      final List<bool> sufficient = <bool>[
        for (final Object? v
            in (m['sufficientSamples'] as List? ?? const <Object?>[]))
          v == true,
      ];
      if (blinking.length != streaks.length ||
          sufficient.length != streaks.length) {
        return null;
      }
      final Object? rawSegmentCounts = m['brightSegmentCounts'];
      final List<int>? segmentCounts = rawSegmentCounts is List &&
              rawSegmentCounts.length == streaks.length
          ? <int>[for (final Object? v in rawSegmentCounts) (v as num).toInt()]
          : null;
      final int? width = (m['width'] as num?)?.toInt();
      final int? height = (m['height'] as num?)?.toInt();
      if (width == null || height == null || width <= 0 || height <= 0) {
        return null;
      }
      return MeteorCompactFrameFeatures(
        sourcePath: sourcePaths[index],
        width: width,
        height: height,
        streaks: streaks,
        stars: stars,
        likelyBlinkingByStreak: blinking,
        brightSegmentCountByStreak: segmentCounts,
        sufficientBrightnessSamplesByStreak: sufficient,
      );
    } on Object {
      return null;
    }
  }

  Future<void> save(int index, MeteorCompactFrameFeatures features) async {
    await _directory.create(recursive: true);
    final FileStat stat = await File(sourcePaths[index]).stat();
    final File destination = File(_pathFor(index));
    final File temp = File(
        '${destination.path}.tmp.$pid.${DateTime.now().microsecondsSinceEpoch}');
    final Map<String, Object?> payload = <String, Object?>{
      'version': 1,
      'sourcePath': sourcePaths[index],
      'sourceBytes': stat.size,
      'sourceModifiedEpochMs': stat.modified.millisecondsSinceEpoch,
      'width': features.width,
      'height': features.height,
      'streaks': <Object?>[
        for (final StreakCandidate v in features.streaks) _streakToJson(v)
      ],
      'stars': <Object?>[
        for (final DetectedStar v in features.stars) _starToJson(v)
      ],
      'likelyBlinking': features.likelyBlinkingByStreak,
      // Work356: optional (absent in older checkpoints).
      if (features.brightSegmentCountByStreak != null)
        'brightSegmentCounts': features.brightSegmentCountByStreak,
      'sufficientSamples': features.sufficientBrightnessSamplesByStreak,
    };
    await temp.writeAsString(jsonEncode(payload), flush: true);
    try {
      await temp.rename(destination.path);
    } on FileSystemException {
      if (await destination.exists()) await destination.delete();
      await temp.rename(destination.path);
    }
  }

  Map<String, Object?> _streakToJson(StreakCandidate s) => <String, Object?>{
        'centroidX': s.centroidX,
        'centroidY': s.centroidY,
        'angleRadians': s.angleRadians,
        'length': s.length,
        'width': s.width,
        'elongation': s.elongation,
        'flux': s.flux,
        'pixelCount': s.pixelCount,
        'endpoints': <Object?>[
          for (final p in s.endpoints) <String, Object?>{'x': p.x, 'y': p.y}
        ],
      };

  StreakCandidate _streakFromJson(Map<String, dynamic> m) => StreakCandidate(
        centroidX: (m['centroidX'] as num).toDouble(),
        centroidY: (m['centroidY'] as num).toDouble(),
        angleRadians: (m['angleRadians'] as num).toDouble(),
        length: (m['length'] as num).toDouble(),
        width: (m['width'] as num).toDouble(),
        elongation: (m['elongation'] as num).toDouble(),
        flux: (m['flux'] as num).toDouble(),
        pixelCount: (m['pixelCount'] as num).toInt(),
        endpoints: <({double x, double y})>[
          for (final Object? raw in (m['endpoints'] as List))
            (
              x: ((raw as Map)['x'] as num).toDouble(),
              y: ((raw)['y'] as num).toDouble()
            ),
        ],
      );

  Map<String, Object?> _starToJson(DetectedStar s) => <String, Object?>{
        'x': s.x,
        'y': s.y,
        'flux': s.flux,
        'peakValue': s.peakValue,
        'roundness': s.roundness,
        'sharpness': s.sharpness,
        if (s.psfFwhmPx != null) 'psfFwhmPx': s.psfFwhmPx,
      };

  DetectedStar _starFromJson(Map<String, dynamic> m) => DetectedStar(
        x: (m['x'] as num).toDouble(),
        y: (m['y'] as num).toDouble(),
        flux: (m['flux'] as num).toDouble(),
        peakValue: (m['peakValue'] as num).toDouble(),
        roundness: (m['roundness'] as num).toDouble(),
        sharpness: (m['sharpness'] as num).toDouble(),
        psfFwhmPx: (m['psfFwhmPx'] as num?)?.toDouble(),
      );

  Future<void> cleanupAll() async {
    if (await _directory.exists()) await _directory.delete(recursive: true);
  }
}

final class _MilkyWayCompactFrameFeatures {
  const _MilkyWayCompactFrameFeatures({
    required this.sourcePath,
    required this.width,
    required this.height,
    required this.stars,
  });

  final String sourcePath;
  final int width;
  final int height;
  final List<DetectedStar> stars;
}

final class _MilkyWayCompactFeatureCheckpointStore {
  _MilkyWayCompactFeatureCheckpointStore({
    required String statusPath,
    required this.sourcePaths,
    required this.identity,
  }) : _directory = Directory(
          '${File(statusPath).parent.path}${Platform.pathSeparator}'
          'milky_way_compact_features_v1',
        );

  final Directory _directory;
  final List<String> sourcePaths;
  final String identity;

  String _pathFor(int index) =>
      '${_directory.path}${Platform.pathSeparator}frame_$index.json';

  Future<_MilkyWayCompactFrameFeatures?> restore(int index) async {
    try {
      final File file = File(_pathFor(index));
      if (!await file.exists()) return null;
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map) return null;
      final Map<String, dynamic> data = decoded.cast<String, dynamic>();
      final FileStat stat = await File(sourcePaths[index]).stat();
      if ((data['version'] as num?) != 1 ||
          data['identity'] != identity ||
          data['sourcePath'] != sourcePaths[index] ||
          (data['sourceBytes'] as num?)?.toInt() != stat.size ||
          (data['sourceModifiedEpochMs'] as num?)?.toInt() !=
              stat.modified.millisecondsSinceEpoch) {
        return null;
      }
      final int? width = (data['width'] as num?)?.toInt();
      final int? height = (data['height'] as num?)?.toInt();
      if (width == null || height == null || width <= 0 || height <= 0) {
        return null;
      }
      return _MilkyWayCompactFrameFeatures(
        sourcePath: sourcePaths[index],
        width: width,
        height: height,
        stars: <DetectedStar>[
          for (final Object? raw
              in (data['stars'] as List? ?? const <Object?>[]))
            _starFromJson((raw as Map).cast<String, dynamic>()),
        ],
      );
    } on Object {
      return null;
    }
  }

  Future<void> save(
    int index,
    _MilkyWayCompactFrameFeatures features,
  ) async {
    await _directory.create(recursive: true);
    final FileStat stat = await File(sourcePaths[index]).stat();
    final File destination = File(_pathFor(index));
    final File temp = File(
      '${destination.path}.tmp.$pid.${DateTime.now().microsecondsSinceEpoch}',
    );
    await temp.writeAsString(
      jsonEncode(<String, Object?>{
        'version': 1,
        'identity': identity,
        'sourcePath': sourcePaths[index],
        'sourceBytes': stat.size,
        'sourceModifiedEpochMs': stat.modified.millisecondsSinceEpoch,
        'width': features.width,
        'height': features.height,
        'stars': <Object?>[
          for (final DetectedStar star in features.stars)
            <String, Object?>{
              'x': star.x,
              'y': star.y,
              'flux': star.flux,
              'peakValue': star.peakValue,
              'roundness': star.roundness,
              'sharpness': star.sharpness,
              if (star.psfFwhmPx != null) 'psfFwhmPx': star.psfFwhmPx,
            },
        ],
      }),
      flush: true,
    );
    try {
      await temp.rename(destination.path);
    } on FileSystemException {
      if (await destination.exists()) await destination.delete();
      await temp.rename(destination.path);
    }
  }

  DetectedStar _starFromJson(Map<String, dynamic> data) => DetectedStar(
        x: (data['x'] as num).toDouble(),
        y: (data['y'] as num).toDouble(),
        flux: (data['flux'] as num).toDouble(),
        peakValue: (data['peakValue'] as num).toDouble(),
        roundness: (data['roundness'] as num).toDouble(),
        sharpness: (data['sharpness'] as num).toDouble(),
        psfFwhmPx: (data['psfFwhmPx'] as num?)?.toDouble(),
      );

  Future<void> cleanupAll() async {
    if (await _directory.exists()) await _directory.delete(recursive: true);
  }
}

final class _StorageCapacityException implements Exception {
  const _StorageCapacityException({
    required this.message,
    this.requiredBytes,
    this.availableBytes,
  });

  final String message;
  final int? requiredBytes;
  final int? availableBytes;

  static String _formatBytes(int? bytes) {
    if (bytes == null || bytes < 0) return '取得できません';
    final double gib = bytes / (1024 * 1024 * 1024);
    if (gib >= 1) return '${gib.toStringAsFixed(1)} GB';
    final double mib = bytes / (1024 * 1024);
    return '${mib.toStringAsFixed(0)} MB';
  }

  @override
  String toString() {
    final StringBuffer text = StringBuffer(message);
    if (requiredBytes != null || availableBytes != null) {
      text
        ..write('\n必要な空き容量: ${_formatBytes(requiredBytes)}')
        ..write('\n現在の空き容量: ${_formatBytes(availableBytes)}');
    }
    text.write('\n空き容量を確保した後、「保存済み地点から再開」を押してください。');
    return text.toString();
  }
}

bool _isNoSpaceError(Object error) {
  if (error is FileSystemException && error.osError?.errorCode == 28) {
    return true;
  }
  final String text = error.toString().toLowerCase();
  return text.contains('no space left on device') ||
      text.contains('errno = 28') ||
      text.contains('errno=28');
}

/// Removes RGB temp directories left behind by a processor that died before
/// `dispose()` could run. Android maps Directory.systemTemp into the app's
/// cache/code_cache partition; abandoned full-frame FP32 stores there can be
/// hundreds of MiB each and otherwise survive into the next retry.
Future<void> _cleanupOrphanedLinearRgbTempDirectories() async {
  final Directory root = Directory.systemTemp;
  try {
    if (!await root.exists()) return;
    await for (final FileSystemEntity entity in root.list(followLinks: false)) {
      if (entity is! Directory) continue;
      final String name =
          entity.uri.pathSegments.where((String part) => part.isNotEmpty).last;
      if (!name.startsWith('mobile-stack-linear-rgb-')) continue;
      try {
        await entity.delete(recursive: true);
      } on Object catch (error) {
        await DiagnosticLog.log(
            'orphan RGB temp cleanup skipped $name: $error');
      }
    }
  } on Object catch (error) {
    await DiagnosticLog.log('orphan RGB temp scan failed: $error');
  }
}

/// Process-death-safe per-frame checkpoint storage for the long star-trail
/// RAW decode/demosaic phase.
///
/// A frame becomes reusable only after both conditions hold:
/// 1. FileBackedLinearRgbTileStore.commit() has flushed the complete FP32 RGB
///    plane to disk, and
/// 2. an atomic JSON sidecar has been published for that exact source index.
///
/// Partial files left by a killed process never have a valid sidecar and are
/// deleted before that frame is decoded again. The checkpoint directory lives
/// beside status.json, which is the durable per-job directory used by the
/// Android background-job recovery path; therefore it survives Activity and
/// worker-process death but cannot collide with another job.
final class _StarTrailDecodeCheckpointStore {
  _StarTrailDecodeCheckpointStore({
    required this.statusPath,
    required this.sourcePaths,
  }) : directory = Directory(
          '${File(statusPath).parent.path}${Platform.pathSeparator}'
          'star_trail_decode_checkpoints_v1',
        );

  static const int _version = 1;

  final String statusPath;
  final List<String> sourcePaths;
  final Directory directory;

  String _dataPath(int index) =>
      '${directory.path}${Platform.pathSeparator}frame_$index.f32';
  String _manifestPath(int index) =>
      '${directory.path}${Platform.pathSeparator}frame_$index.json';

  Future<LinearRgbTileStore?> restoreFrame(int index) async {
    final File manifestFile = File(_manifestPath(index));
    final File dataFile = File(_dataPath(index));
    try {
      if (!await manifestFile.exists() || !await dataFile.exists()) {
        await _deleteFrameFiles(index);
        return null;
      }
      final Object? decoded = jsonDecode(await manifestFile.readAsString());
      if (decoded is! Map<String, dynamic>) {
        await _deleteFrameFiles(index);
        return null;
      }
      final int? version = (decoded['version'] as num?)?.toInt();
      final int? storedIndex = (decoded['index'] as num?)?.toInt();
      final String? sourcePath = decoded['sourcePath'] as String?;
      final int? width = (decoded['width'] as num?)?.toInt();
      final int? height = (decoded['height'] as num?)?.toInt();
      final int? byteLength = (decoded['byteLength'] as num?)?.toInt();
      final int? sourceByteLength =
          (decoded['sourceByteLength'] as num?)?.toInt();
      final int? sourceModifiedMs =
          (decoded['sourceModifiedMs'] as num?)?.toInt();
      final FileStat sourceStat = await File(sourcePaths[index]).stat();
      if (version != _version ||
          storedIndex != index ||
          sourcePath != sourcePaths[index] ||
          sourceByteLength != sourceStat.size ||
          sourceModifiedMs != sourceStat.modified.millisecondsSinceEpoch ||
          width == null ||
          height == null ||
          width <= 0 ||
          height <= 0 ||
          byteLength == null ||
          byteLength !=
              width * height * FileBackedLinearRgbTileStore.bytesPerPixel ||
          await dataFile.length() != byteLength) {
        await _deleteFrameFiles(index);
        return null;
      }
      return await FileBackedLinearRgbTileStore.openCommitted(
        path: dataFile.path,
        width: width,
        height: height,
      );
    } on Object {
      await _deleteFrameFiles(index);
      return null;
    }
  }

  Future<LinearRgbTileStore> createStore({
    required int index,
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    await directory.create(recursive: true);
    // Any previous data without a valid restored sidecar is incomplete/stale.
    // Remove it before using File.create(exclusive: true).
    await _deleteFrameFiles(index);
    return FileBackedLinearRgbTileStore.create(
      path: _dataPath(index),
      width: width,
      height: height,
      plan: plan,
    );
  }

  Future<void> publishCommittedFrame(
    int index,
    LinearRgbTileStore store,
  ) async {
    if (store is! FileBackedLinearRgbTileStore || !store.isCommitted) {
      throw StateError(
        'Star-trail checkpoint requires a committed file-backed RGB store.',
      );
    }
    await directory.create(recursive: true);
    final File manifest = File(_manifestPath(index));
    final File temporary = File('${manifest.path}.tmp');
    final FileStat sourceStat = await File(sourcePaths[index]).stat();
    final Map<String, Object?> payload = <String, Object?>{
      'version': _version,
      'index': index,
      'sourcePath': sourcePaths[index],
      'sourceByteLength': sourceStat.size,
      'sourceModifiedMs': sourceStat.modified.millisecondsSinceEpoch,
      'width': store.width,
      'height': store.height,
      'byteLength': store.persistentByteLength,
    };
    if (await temporary.exists()) await temporary.delete();
    await temporary.writeAsString(jsonEncode(payload), flush: true);
    if (await manifest.exists()) await manifest.delete();
    await temporary.rename(manifest.path);
  }

  bool ownsStore(LinearRgbTileStore store) =>
      store is FileBackedLinearRgbTileStore &&
      store.path.startsWith('${directory.path}${Platform.pathSeparator}');

  Future<void> closeRetainingCheckpoint(LinearRgbTileStore store) async {
    if (ownsStore(store) && store is FileBackedLinearRgbTileStore) {
      await store.closeRetainingFile();
    } else {
      await store.dispose();
    }
  }

  Future<void> _deleteFrameFiles(int index) async {
    final File manifest = File(_manifestPath(index));
    final File temporary = File('${manifest.path}.tmp');
    final File data = File(_dataPath(index));
    for (final File file in <File>[temporary, manifest, data]) {
      try {
        if (await file.exists()) await file.delete();
      } on Object {
        // Invalid checkpoint cleanup is best effort. A subsequent create/open
        // will fail explicitly rather than silently accepting bad pixels.
      }
    }
  }

  Future<void> cleanupAll() async {
    try {
      if (await directory.exists()) await directory.delete(recursive: true);
    } on Object {
      // Terminal cleanup is best effort; correctness never relies on deletion.
    }
  }
}

T _enumByName<T extends Enum>(List<T> values, Object? raw, T fallback) {
  final String? name = raw as String?;
  if (name == null) return fallback;
  for (final T value in values) {
    if (value.name == name) return value;
  }
  return fallback;
}

Future<String> _buildPostDecodeCheckpointIdentity({
  required Map<String, dynamic> input,
  required ProcessingMode mode,
  required List<String> sourcePaths,
  required List<String> darkFramePaths,
  required List<String> flatFramePaths,
}) async {
  Future<List<Map<String, Object?>>> fingerprints(List<String> paths) async {
    final List<Map<String, Object?>> result = <Map<String, Object?>>[];
    for (final String path in paths) {
      final FileStat stat = await File(path).stat();
      result.add(<String, Object?>{
        'path': path,
        'bytes': stat.size,
        'modifiedEpochMs': stat.modified.millisecondsSinceEpoch,
        'sha256': await DurableDecodedFrameCache.fileHash(File(path)),
      });
    }
    return result;
  }

  const Set<String> excluded = <String>{
    'statusPath',
    'outputPath',
  };
  final Map<String, dynamic> processingOptions = <String, dynamic>{};
  final List<String> keys = input.keys
      .where((String key) => !excluded.contains(key))
      .toList(growable: false)
    ..sort();
  for (final String key in keys) {
    final dynamic value = input[key];
    if (value is num || value is bool || value is String || value == null) {
      processingOptions[key] = value;
    }
  }
  return jsonEncode(<String, Object?>{
    'version': 1,
    'architecture': mode == ProcessingMode.starTrail
        ? 'rolling-star-trail-v1'
        : (mode == ProcessingMode.milkyWay &&
                input['automaticMovingObjectRemoval'] == false)
            ? 'rolling-milky-way-v1'
            : 'classic-stack-v1',
    'options': processingOptions,
    'algorithmRevision': 349,
    'foregroundRegion': input['foregroundRegion'],
    'sources': await fingerprints(sourcePaths),
    'darkFrames': await fingerprints(darkFramePaths),
    'flatFrames': await fingerprints(flatFramePaths),
  });
}

Future<void> _ensurePostDecodeStorageHeadroom({
  required LinearRgbTileStore referenceStore,
  required ProcessingMode mode,
}) async {
  final int pixels = referenceStore.width * referenceStore.height;
  final int checkpointBytes =
      pixels * FileBackedLinearRgbTileStore.bytesPerPixel +
          (mode == ProcessingMode.milkyWay ? pixels * 6 : 0);
  // Reserve room for one output-sized working generation plus 512 MiB for
  // filesystem/encoder overhead. This never lowers image quality; if the
  // device cannot safely hold the durable checkpoint, fail recoverably before
  // starting the expensive stack rather than dying after hours of work.
  final int reserveBytes =
      (pixels * FileBackedLinearRgbTileStore.bytesPerPixel) +
          (512 * 1024 * 1024);
  final int requiredBytes = checkpointBytes + reserveBytes;
  final snapshot = await readDefaultResourceSnapshot();
  final int? available = snapshot.availableStorageBytes;
  if (available != null && available < requiredBytes) {
    throw _StorageCapacityException(
      message: '合成後の再開用データを安全に保存するための空き容量が不足しています。',
      requiredBytes: requiredBytes,
      availableBytes: available,
    );
  }
}

Future<void> _ensureStarTrailDecodeStorageHeadroom({
  required LinearRgbTileStore dimensionSource,
  required int totalFrames,
  required int committedFrames,
}) async {
  final int frameBytes = dimensionSource.width *
      dimensionSource.height *
      FileBackedLinearRgbTileStore.bytesPerPixel;
  final int remainingFrames =
      (totalFrames - committedFrames).clamp(0, totalFrames).toInt();

  // Current star-trail architecture keeps every decoded FP32 source until the
  // final lighten-blend analysis. Account for every remaining source plus a
  // conservative post-decode/output reserve. This intentionally stops before
  // ENOSPC rather than filling the device and corrupting unrelated app/cache
  // writes. It does not lower precision or output quality.
  final int postDecodeAndExportReserve = frameBytes * 3 + 512 * 1024 * 1024;
  final int requiredBytes =
      remainingFrames * frameBytes + postDecodeAndExportReserve;
  final snapshot = await readDefaultResourceSnapshot();
  final int? available = snapshot.availableStorageBytes;
  if (available != null && available < requiredBytes) {
    throw _StorageCapacityException(
      message: '端末の空き容量が不足しています。星の軌跡のRAW展開を安全に続行できないため、ストレージを使い切る前に停止しました。',
      requiredBytes: requiredBytes,
      availableBytes: available,
    );
  }
}

Future<
    ({
      LinearRgbTileStore store,
      DngFinalRenderProfile? profile,
      RawSaturationMask? saturationMask,
    })> _decodeStarTrailFrameForRolling({
  required int index,
  required String sourcePath,
  ProcessingMode mode = ProcessingMode.starTrail,
  required RawDecoderRegistry decoderRegistry,
  required RawMetadataProbe metadataProbe,
  required FileBackedLinearRawMosaicStore? masterDarkStore,
  required FileBackedLinearRawMosaicStore? masterFlatStore,
  required bool Function() isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  final ProcessingJob job = ProcessingJob(
    id: 'rolling-startrail#$index',
    mode: mode,
    sourcePath: sourcePath,
  )..state = ProcessingJobState.running;
  LinearRgbTileStore? store;
  DngFinalRenderProfile? profile;
  RawSaturationMask? saturationMask;
  try {
    await runPhase2ValidatedJob(
      job,
      reportProgress ?? (_) {},
      metadataProbe: metadataProbe,
      decoderRegistry: decoderRegistry,
      masterDarkStore: masterDarkStore,
      masterFlatStore: masterFlatStore,
      fileBackRawBeforeDemosaic: true,
      preferStreamedRawCalibration: true,
      onRenderMetadataReady: (metadata, cfaPattern) {
        profile = DngFinalRenderProfile.fromMetadata(
          sourceId: sourcePath,
          metadata: metadata,
          cfaPattern: cfaPattern,
        );
      },
      onTileStoreReady: (LinearRgbTileStore ready) {
        store = ready;
      },
      onSaturationMaskReady: (RawSaturationMask? ready) {
        saturationMask = ready;
      },
    );
    if (isCancelled()) throw const StackJobCancelledException();
    final LinearRgbTileStore? ready = store;
    if (ready == null) {
      throw StateError('RAW処理結果がありません: $sourcePath');
    }
    job.state = ProcessingJobState.completed;
    return (
      store: ready,
      profile: profile,
      saturationMask: saturationMask,
    );
  } on Object catch (error, stackTrace) {
    final LinearRgbTileStore? owned = store;
    if (owned != null) {
      try {
        await owned.dispose();
      } on Object {
        // Preserve the original processing failure; disposal is best-effort.
      }
    }
    job
      ..state = ProcessingJobState.failed
      ..error = error
      ..errorStackTrace = stackTrace;
    rethrow;
  }
}

Future<void> _ensureRollingStarTrailStorageHeadroom({
  required int width,
  required int height,
  // Work356: the optional rolling sum (FP32 RGB + uint16 count) also keeps
  // previous/new generations during publication: +36 bytes/pixel.
  bool includeRollingSum = false,
}) async {
  final int pixels = width * height;
  // One source frame + old/new RGB generations + old/new validity generations
  // + finalization/export reserve. This is independent of frame count.
  // Peak durable state can briefly contain current + previous + newly
  // written rolling generations, plus the current decoded frame and a final
  // transformation generation. Reserve 84 bytes/pixel so publication never
  // has to sacrifice the previous known-good generation to make room.
  final int requiredBytes = pixels * 84 + 768 * 1024 * 1024 +
      (includeRollingSum ? pixels * 36 : 0);
  final snapshot = await readDefaultResourceSnapshot();
  final int? available = snapshot.availableStorageBytes;
  if (available != null && available < requiredBytes) {
    throw _StorageCapacityException(
      message: '最高画質の比較明合成を安全に継続するための作業領域が不足しています。',
      requiredBytes: requiredBytes,
      availableBytes: available,
    );
  }
}

Future<void> _ensureRollingMilkyWayStorageHeadroom({
  required int width,
  required int height,
}) async {
  final int pixels = width * height;
  // Three durable FP64 accumulator generations can briefly coexist during an
  // atomic publish (current, previous, new): each generation contains a
  // 24-byte weighted sum and 24-byte weight sum per pixel. Add the retained
  // reference, current decoded frame, finalized RGB/validity sidecar, and
  // encoder/filesystem reserve. The bound is independent of frame count.
  final int requiredBytes = pixels * 186 + 768 * 1024 * 1024;
  final snapshot = await readDefaultResourceSnapshot();
  final int? available = snapshot.availableStorageBytes;
  if (available != null && available < requiredBytes) {
    throw _StorageCapacityException(
      message: '最高画質の天の川ローリング合成を安全に継続するための作業領域が不足しています。',
      requiredBytes: requiredBytes,
      availableBytes: available,
    );
  }
}

Future<void> _logContributionStatistics(
  LinearContributionTileStore contributions, {
  required String label,
}) async {
  const int rowsPerStrip = 128;
  const List<String> channelNames = <String>['R', 'G', 'B'];
  final List<int> minByChannel = List<int>.filled(3, 0xFFFF);
  final List<int> maxByChannel = List<int>.filled(3, 0);
  final List<int> sumByChannel = List<int>.filled(3, 0);
  int rgbMismatchPixels = 0;
  int pixelsWithAnyChannelBelowTwo = 0;
  int pixelsWithAnyChannelZero = 0;
  final int pixelCount = contributions.width * contributions.height;
  for (int y = 0; y < contributions.height; y += rowsPerStrip) {
    final int remaining = contributions.height - y;
    final int stripHeight = remaining < rowsPerStrip ? remaining : rowsPerStrip;
    final strip = await contributions.readRegion(
      x: 0,
      y: y,
      width: contributions.width,
      height: stripHeight,
    );
    for (int localY = 0; localY < stripHeight; localY++) {
      for (int localX = 0; localX < contributions.width; localX++) {
        final List<int> counts = <int>[
          for (int channel = 0; channel < 3; channel++)
            strip.channelCountAt(localX, localY, channel),
        ];
        for (int channel = 0; channel < 3; channel++) {
          final int count = counts[channel];
          if (count < minByChannel[channel]) minByChannel[channel] = count;
          if (count > maxByChannel[channel]) maxByChannel[channel] = count;
          sumByChannel[channel] += count;
        }
        if (counts[0] != counts[1] || counts[1] != counts[2]) {
          rgbMismatchPixels++;
        }
        final int minimumCount =
            math.min(counts[0], math.min(counts[1], counts[2]));
        if (minimumCount < 2) pixelsWithAnyChannelBelowTwo++;
        if (minimumCount == 0) pixelsWithAnyChannelZero++;
      }
    }
  }
  final List<double> meanByChannel = <double>[
    for (int channel = 0; channel < 3; channel++)
      pixelCount == 0 ? 0 : sumByChannel[channel] / pixelCount,
  ];
  final String summary = <String>[
    for (int channel = 0; channel < 3; channel++)
      '${channelNames[channel]}: min=${minByChannel[channel]} '
          'mean=${meanByChannel[channel].toStringAsFixed(2)} '
          'max=${maxByChannel[channel]}',
  ].join(', ');
  final double denominator = pixelCount == 0 ? 1 : pixelCount.toDouble();
  await DiagnosticLog.log(
    'Milky Way exact contribution counts ($label): $summary; '
    'rgbCountMismatchPixels=$rgbMismatchPixels '
    '(${(rgbMismatchPixels * 100 / denominator).toStringAsFixed(3)}%); '
    'pixelsAnyChannelBelow2=$pixelsWithAnyChannelBelowTwo '
    '(${(pixelsWithAnyChannelBelowTwo * 100 / denominator).toStringAsFixed(3)}%); '
    'pixelsAnyChannelZero=$pixelsWithAnyChannelZero '
    '(${(pixelsWithAnyChannelZero * 100 / denominator).toStringAsFixed(3)}%)',
  );
}

/// Rolling weighted-average export currently stores a 0/1 validity sidecar,
/// not an exact observation count. Log it as coverage only so diagnostics do
/// not claim that a value of one means exactly one contributing frame.
Future<void> _logContributionValidityStatistics(
  LinearContributionTileStore contributions, {
  required String label,
}) async {
  const int rowsPerStrip = 128;
  final List<int> validByChannel = List<int>.filled(3, 0);
  final int pixelCount = contributions.width * contributions.height;
  for (int y = 0; y < contributions.height; y += rowsPerStrip) {
    final int remaining = contributions.height - y;
    final int stripHeight = remaining < rowsPerStrip ? remaining : rowsPerStrip;
    final strip = await contributions.readRegion(
      x: 0,
      y: y,
      width: contributions.width,
      height: stripHeight,
    );
    for (int localY = 0; localY < stripHeight; localY++) {
      for (int localX = 0; localX < contributions.width; localX++) {
        for (int channel = 0; channel < 3; channel++) {
          final int value = strip.channelCountAt(localX, localY, channel);
          if (value > 1) {
            throw StateError(
              'Rolling contribution validity sidecar unexpectedly contains '
              'an exact count > 1.',
            );
          }
          if (value == 1) validByChannel[channel]++;
        }
      }
    }
  }
  final List<double> coverage = <double>[
    for (int channel = 0; channel < 3; channel++)
      pixelCount == 0 ? 0 : validByChannel[channel] / pixelCount,
  ];
  await DiagnosticLog.log(
    'Milky Way rolling validity coverage ($label; 0/1 presence, NOT frame '
    'counts): R=${(coverage[0] * 100).toStringAsFixed(2)}% '
    'G=${(coverage[1] * 100).toStringAsFixed(2)}% '
    'B=${(coverage[2] * 100).toStringAsFixed(2)}%',
  );
}

Future<bool> runStandardStackBackgroundTask(Map<String, dynamic> input) async {
  if (input['starTrailPureMaxReference'] == true) {
    if (input['mode'] != ProcessingMode.starTrail.name) {
      throw ArgumentError('比較明参照は星の軌跡用です。');
    }
    input = <String, dynamic>{
      ...input,
      'qualityLevel': ProcessingQualityLevel.maximum.name,
      'outputFormat': OutputImageFormat.linearDng.name,
      'automaticStarTrailAircraftRemoval': false,
      'automaticStarTrailForegroundProtection': false,
      'starTrailHotPixelRemoval': false,
      'starTrailMeteorProtection': false,
      'starTrailMeanBackground': false,
      'starTrailForegroundAverage': false,
      'starTrailGapFillMode': StarTrailGapFillMode.off.name,
      'starTrailFadeMode': StarTrailFadeMode.off.name,
    };
  }

  final List<String> sourcePaths =
      (input['sourcePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final List<String> darkFramePaths =
      (input['darkFramePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final List<String> flatFramePaths =
      (input['flatFramePaths'] as List<dynamic>? ?? const <dynamic>[])
          .cast<String>();
  final String outputPath = input['outputPath'] as String;
  final String statusPath = input['statusPath'] as String;
  final CompletionAttemptHistoryStore attemptHistoryStore =
      CompletionAttemptHistoryStore(historyPath: '$statusPath.attempts');
  final CompletionAttemptHistory attemptHistory =
      await attemptHistoryStore.load();
  bool criticalPressureHitThisAttempt = false;
  bool jobHandledSuccessfully = false;
  final ProcessingMode mode = _enumByName(
    ProcessingMode.values,
    input['mode'],
    ProcessingMode.milkyWay,
  );
  if (mode != ProcessingMode.milkyWay && mode != ProcessingMode.starTrail) {
    throw ArgumentError(
        'Standard background worker supports Milky Way/star trail only.');
  }
  final OutputImageFormat outputFormat = _enumByName(
    OutputImageFormat.values,
    input['outputFormat'],
    OutputImageFormat.linearDng,
  );
  final ProcessingQualityLevel quality = _enumByName(
    ProcessingQualityLevel.values,
    input['qualityLevel'],
    ProcessingQualityLevel.maximum,
  );
  // Tile size only changes how the (lossless, exactly-reassembled) image
  // is chopped up for processing — never resolution, precision, or
  // stacking math — so it is safe to shrink below `quality`'s own value
  // after repeated critical-memory-pressure attempts on this same job.
  // See `completion_attempt_history.dart`.
  final int effectiveTileSize =
      CompletionAttemptHistoryStore.recommendedTileSizeCeiling(
    baseTileSize: quality.processingTileSize,
    consecutiveCriticalAttempts: attemptHistory.consecutiveCriticalAttempts,
  );
  if (effectiveTileSize != quality.processingTileSize) {
    await DiagnosticLog.log(
      'tile size reduced to $effectiveTileSize (base '
      '${quality.processingTileSize}) after '
      '${attemptHistory.consecutiveCriticalAttempts} consecutive critical-'
      'pressure attempt(s), last cause: ${attemptHistory.lastCause}',
    );
  }
  final LightroomStoragePreset storagePreset = _enumByName(
    LightroomStoragePreset.values,
    input['storagePreset'],
    LightroomStoragePreset.maximum,
  );
  final int referenceIndex = (input['referenceIndex'] as num?)?.toInt() ?? 0;
  final bool automaticMovingObjectRemoval =
      input['automaticMovingObjectRemoval'] as bool? ?? true;
  // Work351: absent in payloads written before Work351 -> legacyRigid, so
  // resumed jobs keep the model they were started with.
  final MilkyWayRegistrationModel milkyWayRegistrationModel =
      milkyWayRegistrationModelFromName(
    input['milkyWayRegistrationModel'] as String?,
  );
  final bool automaticStarTrailAircraftRemoval =
      input['automaticStarTrailAircraftRemoval'] as bool? ?? true;
  final foregroundRegion = input['foregroundRegion'] == null
      ? null
      : ForegroundRegion.fromJson(input['foregroundRegion']!);
  final bool automaticStarTrailForegroundProtection =
      input['automaticStarTrailForegroundProtection'] as bool? ?? false;
  // Work355: absent in older payloads => false (unchanged behaviour).
  final bool starTrailHotPixelRemoval =
      input['starTrailHotPixelRemoval'] as bool? ?? false;
  // Work356: absent in older payloads => false (unchanged behaviour).
  final bool starTrailMeteorProtection =
      input['starTrailMeteorProtection'] as bool? ?? false;
  final bool starTrailMeanBackground =
      input['starTrailMeanBackground'] as bool? ?? false;
  final bool starTrailForegroundAverage =
      input['starTrailForegroundAverage'] as bool? ?? false;
  final StarTrailGapFillMode starTrailGapFillMode = _enumByName(
    StarTrailGapFillMode.values,
    input['starTrailGapFillMode'],
    StarTrailGapFillMode.off,
  );
  final StarTrailFadeSettings starTrailFadeSettings = StarTrailFadeSettings(
    mode: _enumByName(
      StarTrailFadeMode.values,
      input['starTrailFadeMode'],
      StarTrailFadeMode.off,
    ),
    curve: _enumByName(
      StarTrailFadeCurve.values,
      input['starTrailFadeCurve'],
      StarTrailFadeCurve.ease,
    ),
    fadeLengthFraction:
        (input['starTrailFadeLengthFraction'] as num?)?.toDouble() ?? 0.1,
    minWeight: (input['starTrailFadeMinWeight'] as num?)?.toDouble() ?? 0.0,
  );
  final String jobLabel = input['starTrailPureMaxReference'] == true
      ? '比較明参照DNG'
      : mode == ProcessingMode.starTrail
          ? '星の軌跡'
          : '天の川スタック';
  final bool useRollingStarTrail = mode == ProcessingMode.starTrail;
  final bool useRollingMilkyWay =
      mode == ProcessingMode.milkyWay && !automaticMovingObjectRemoval;
  final bool useRollingPipeline = useRollingStarTrail || useRollingMilkyWay;
  // Computed once up front (order matches sourcePaths / frame index) so
  // every frame — whether merged into the rolling accumulator below or
  // combined via the non-rolling `combineDecodedFrames` fallback path —
  // sees the exact same weight for its position in the sequence.
  final List<double> starTrailFadeWeights = computeStarTrailFadeWeights(
    frameCount: sourcePaths.length,
    settings: starTrailFadeSettings,
  );

  if (sourcePaths.length < 2) {
    throw ArgumentError('Background stack requires at least two RAW frames.');
  }
  if (referenceIndex < 0 || referenceIndex >= sourcePaths.length) {
    throw RangeError.index(referenceIndex, sourcePaths, 'referenceIndex');
  }

  final StackJobReporter reporter = StackJobReporter(
    statusPath: statusPath,
    outputPath: outputPath,
    totalItems: sourcePaths.length,
    jobLabel: jobLabel,
  );
  final _StarTrailDecodeCheckpointStore? decodeCheckpoints =
      mode == ProcessingMode.starTrail
          ? _StarTrailDecodeCheckpointStore(
              statusPath: statusPath,
              sourcePaths: sourcePaths,
            )
          : null;
  final _StarTrailCompactFeatureCheckpointStore? compactFeatureCheckpoints =
      useRollingStarTrail
          ? _StarTrailCompactFeatureCheckpointStore(
              statusPath: statusPath,
              sourcePaths: sourcePaths,
            )
          : null;
  final _StarTrailHotCandidateStore hotCandidateStore =
      _StarTrailHotCandidateStore(
    statusPath: statusPath,
    sourcePaths: sourcePaths,
  );
  bool cleanupCompactFeatureCheckpointsOnExit = false;
  bool cleanupMilkyWayCompactFeaturesOnExit = false;
  bool cleanupRollingWeightedAverageOnExit = false;
  final List<LinearRgbTileStore?> frameStores =
      List<LinearRgbTileStore?>.filled(sourcePaths.length, null);
  final List<RawSaturationMask?> saturationMasks =
      List<RawSaturationMask?>.filled(sourcePaths.length, null);
  final List<DngFinalRenderProfile?> renderProfiles =
      List<DngFinalRenderProfile?>.filled(sourcePaths.length, null);
  final StackOperationJournal operationJournal =
      StackOperationJournal(statusPath);
  final Set<int> committedCheckpointIndices = <int>{};
  int rollingRecoverableItems = 0;
  bool cleanupDecodeCheckpointsOnExit = false;
  bool cleanupPostDecodeCheckpointOnExit = false;
  PostDecodePipelineCheckpointStore? postDecodeCheckpoints;
  _MilkyWayCompactFeatureCheckpointStore? milkyWayCompactFeatureCheckpoints;
  RollingWeightedAverageCheckpointStore? rollingWeightedAverageCheckpoints;
  PostDecodePipelineCheckpoint? restoredPostDecode;
  bool postDecodeCheckpointAvailable = false;
  LinearRgbTileStore? activePostDecodeRgb;
  LinearContributionTileStore? activePostDecodeContribution;
  Float64RgbTileStore? activeRollingWeightedSum;
  Float64RgbTileStore? activeRollingWeightSum;
  final decodedMetadata =
      List<RawFrameMetadata?>.filled(sourcePaths.length, null);
  final decodedCfaPatterns = List<CfaPattern?>.filled(sourcePaths.length, null);
  DurableMilkyWayFrameCache? milkyDecodedCache;
  MilkyWayTileCombineCheckpointStore? milkyTileCheckpoint;
  JobScheduler? scheduler;
  FileBackedLinearRawMosaicStore? masterDarkStore;
  FileBackedLinearRawMosaicStore? masterFlatStore;

  Future<void> disposeStores() async {
    final Set<LinearRgbTileStore> disposed = <LinearRgbTileStore>{};
    for (final LinearRgbTileStore? store in frameStores) {
      if (store == null || !disposed.add(store)) continue;
      try {
        if (milkyDecodedCache != null &&
            store is FileBackedLinearRgbTileStore &&
            store.path.startsWith(
                '${milkyDecodedCache!.cache.directory.path}${Platform.pathSeparator}')) {
          await milkyDecodedCache!
              .release(store, discard: cleanupDecodeCheckpointsOnExit);
        } else if (!cleanupDecodeCheckpointsOnExit &&
            decodeCheckpoints != null &&
            decodeCheckpoints.ownsStore(store)) {
          // Recoverable failure: close only the file handle. Deleting this
          // committed store here would silently destroy the checkpoint even
          // if cleanupAll() is skipped below.
          await decodeCheckpoints.closeRetainingCheckpoint(store);
        } else {
          await store.dispose();
        }
      } on Object {
        // Best-effort cleanup. The terminal state must still be persisted.
      }
    }
  }

  Future<void> bestEffortCleanup(Future<void> Function() action) async {
    try {
      await action().timeout(const Duration(seconds: 10));
    } on Object {
      // Cleanup must never replace a completed/failed/recoverable status with
      // a secondary MethodChannel error after the durable outcome was saved.
    }
  }

  return runWithExternalStallWatchdog(
    statusPath: statusPath,
    jobLabel: jobLabel,
    body: () async {
      try {
        await operationJournal.enter(
          operation: 'standardStackJob',
          stage: 'start',
          committedItems: committedCheckpointIndices.length,
        );
        if (!await reporter.start()) {
          // Already completed/failed/cancelled — most likely a
          // START_REDELIVER_INTENT redelivery after the service
          // process was killed just after finishing. Do not redo
          // the work or touch the existing terminal status.
          return true;
        }
        if (mode == ProcessingMode.starTrail &&
            automaticStarTrailForegroundProtection &&
            foregroundRegion == null) {
          await reporter.pauseRecoverable(
            StateError('地上光抑制の対象領域が未指定です。設定画面で基準RAWの地上領域を指定し、新しい処理を開始してください。'),
            checkpointItems: 0,
            stage: '地上領域の指定が必要',
          );
          return true;
        }
        await _cleanupOrphanedLinearRgbTempDirectories();
        await DiagnosticLog.startRun(
          'standardStack mode=$mode frames=${sourcePaths.length} quality=$quality',
        );
        final String postDecodeIdentity =
            await _buildPostDecodeCheckpointIdentity(
          input: input,
          mode: mode,
          sourcePaths: sourcePaths,
          darkFramePaths: darkFramePaths,
          flatFramePaths: flatFramePaths,
        );
        postDecodeCheckpoints = PostDecodePipelineCheckpointStore(
          statusPath: statusPath,
          identity: postDecodeIdentity,
        );
        if (useRollingMilkyWay) {
          milkyWayCompactFeatureCheckpoints =
              _MilkyWayCompactFeatureCheckpointStore(
            statusPath: statusPath,
            sourcePaths: sourcePaths,
            identity: postDecodeIdentity,
          );
          rollingWeightedAverageCheckpoints =
              RollingWeightedAverageCheckpointStore(
            statusPath: statusPath,
            identity: postDecodeIdentity,
          );
        }
        if (await postDecodeCheckpoints!.hasValidExportReceipt(outputPath) &&
            (mode != ProcessingMode.starTrail ||
                starTrailGapFillMode == StarTrailGapFillMode.off ||
                await SyntheticGapMask.hasValidReceipt(
                    outputPath, postDecodeIdentity))) {
          await DiagnosticLog.log(
            'verified export receipt restored; heavy processing skipped',
          );
          cleanupDecodeCheckpointsOnExit = true;
          cleanupCompactFeatureCheckpointsOnExit = true;
          cleanupMilkyWayCompactFeaturesOnExit = true;
          cleanupRollingWeightedAverageOnExit = true;
          cleanupPostDecodeCheckpointOnExit = true;
          await operationJournal.complete(
            operation: 'standardStackJob',
            stage: 'completedFromExportReceipt',
            committedItems: sourcePaths.length,
          );
          jobHandledSuccessfully = true;
          await reporter.complete();
          return true;
        }
        if (mode == ProcessingMode.milkyWay && !useRollingMilkyWay) {
          milkyDecodedCache = DurableMilkyWayFrameCache(
              DurableDecodedFrameCache(
                  statusPath: statusPath, identity: postDecodeIdentity));
          milkyTileCheckpoint = MilkyWayTileCombineCheckpointStore(
              directory: Directory(
                  '${File(statusPath).parent.path}${Platform.pathSeparator}milky_tiles_v2'),
              identity: postDecodeIdentity);
        }
        restoredPostDecode = await postDecodeCheckpoints!.restore();
        if (restoredPostDecode != null) {
          postDecodeCheckpointAvailable = true;
          activePostDecodeRgb = restoredPostDecode!.rgbStore;
          activePostDecodeContribution = restoredPostDecode!.contributionStore;
          await DiagnosticLog.log(
            'post-decode checkpoint restored generation='
            '${restoredPostDecode!.generation}',
          );
        }
        // A committed post-decode result already contains the expensive stack.
        // For Milky Way, and for star trails when gap-fill is disabled, only
        // the selected reference RAW must be decoded again so deterministic
        // render metadata/tone can be reconstructed. Re-decoding every source
        // frame would defeat the recovery checkpoint and can add hours after a
        // failure that happened during final export.
        final bool referenceOnlyPostDecodeRecovery =
            restoredPostDecode != null &&
                (mode == ProcessingMode.milkyWay ||
                    (mode == ProcessingMode.starTrail &&
                        starTrailGapFillMode == StarTrailGapFillMode.off));
        int restoredFrameCount = 0;
        if (milkyDecodedCache != null && !referenceOnlyPostDecodeRecovery) {
          for (int index = 0; index < sourcePaths.length; index++) {
            if (index == referenceIndex) {
              continue; // rebuild reference render metadata
            }
            final cached = await milkyDecodedCache!.restore(index);
            if (cached == null) continue;
            renderProfiles[index] = DngFinalRenderProfile.fromMetadata(
                sourceId: sourcePaths[index],
                metadata: cached.metadata,
                cfaPattern: cached.cfaPattern);
            frameStores[index] = cached.store;
            saturationMasks[index] = cached.saturationMask;
            committedCheckpointIndices.add(index);
            restoredFrameCount++;
          }
        }
        if (decodeCheckpoints != null &&
            !useRollingStarTrail &&
            !referenceOnlyPostDecodeRecovery) {
          for (int index = 0; index < sourcePaths.length; index++) {
            // Re-decode the selected reference frame after process death. Its
            // render metadata is required for deterministic final colour/tone
            // export, while the expensive RGB decode of every other frame can
            // be restored directly from its committed checkpoint.
            if (index == referenceIndex) continue;
            final LinearRgbTileStore? restored =
                await decodeCheckpoints.restoreFrame(index);
            if (restored == null) continue;
            frameStores[index] = restored;
            committedCheckpointIndices.add(index);
            restoredFrameCount++;
          }
          if (restoredFrameCount > 0) {
            await DiagnosticLog.log(
              'starTrail checkpoint restored $restoredFrameCount/'
              '${sourcePaths.length} decoded frames',
            );
          }
        }
        await reporter.update(
          progress: sourcePaths.isEmpty
              ? 0
              : (restoredFrameCount / sourcePaths.length) * 0.55,
          stage: 'RAW解析・較正',
          currentItem: restoredFrameCount,
        );
        final decoderRegistry =
            createProductionBackgroundNativeRawDecoderRegistry();
        final metadataProbe = createProductionNativeRawMetadataProbe();
        await operationJournal.enter(
          operation: 'masterCalibration',
          stage: 'prepare',
          committedItems: committedCheckpointIndices.length,
        );
        masterDarkStore = darkFramePaths.isEmpty
            ? null
            : await prepareMasterDarkStore(
                sourcePaths: darkFramePaths,
                decoderRegistry: decoderRegistry,
              );
        masterFlatStore = flatFramePaths.isEmpty
            ? null
            : await prepareMasterFlatStore(
                sourcePaths: flatFramePaths,
                decoderRegistry: decoderRegistry,
                darkStoreToSubtract: masterDarkStore,
              );
        await operationJournal.complete(
          operation: 'masterCalibration',
          stage: 'prepare',
          committedItems: committedCheckpointIndices.length,
        );

        final AdaptiveResourceController adaptiveResources =
            AdaptiveResourceController(
          resourceReader: readDefaultResourceSnapshot,
        );
        // Thin wrapper so every call site's decision is also checked
        // against the completion-attempt ladder (see
        // `completion_attempt_history.dart`): the first time this
        // attempt genuinely reaches critical pressure, remember it for
        // the `finally` block below, regardless of which of the three
        // call sites below observed it.
        Future<AdaptiveResourceDecision> waitSafeToStartNextFrame({
          FutureOr<void> Function(AdaptiveResourceDecision decision)?
              onDecision,
        }) async {
          final AdaptiveResourceDecision decision =
              await adaptiveResources.waitUntilSafeToStartNextFrame(
            onDecision: onDecision,
          );
          if (decision.state == AdaptiveResourceState.critical &&
              !criticalPressureHitThisAttempt) {
            criticalPressureHitThisAttempt = true;
            // Written immediately (not deferred to the `finally` block
            // below) because critical memory pressure is exactly the
            // condition under which the OS may kill this whole process
            // outright before any Dart `finally` gets a chance to run —
            // the entire scenario this history exists to survive.
            unawaited(
              attemptHistoryStore.recordCriticalPressureHit(cause: 'memory'),
            );
          }
          return decision;
        }

        final MemoryAdmissionController memoryAdmission =
            MemoryAdmissionController(
          resourceReader: readDefaultResourceSnapshot,
        );

        if (useRollingMilkyWay) {
          await DiagnosticLog.log(
            'rolling Milky Way pipeline enabled: compact registration + '
            'exact durable FP64 weighted average',
          );
          final _MilkyWayCompactFeatureCheckpointStore compactStore =
              milkyWayCompactFeatureCheckpoints!;
          RollingWeightedAverageCheckpointStore accumulatorStore =
              rollingWeightedAverageCheckpoints!;
          MilkyWayRegistrationPlan? registrationPlan;
          List<DetectedStar>? rollingReferenceQualityStars;
          int? expectedWidth;
          int? expectedHeight;

          if (restoredPostDecode == null) {
            final List<_MilkyWayCompactFrameFeatures?> compact =
                List<_MilkyWayCompactFrameFeatures?>.filled(
              sourcePaths.length,
              null,
            );
            final Map<int, Object?> decodeFailures = <int, Object?>{};
            final Map<int, Object?> detectionFailures = <int, Object?>{};
            int restoredCompactCount = 0;
            for (int index = 0; index < sourcePaths.length; index++) {
              final _MilkyWayCompactFrameFeatures? restored =
                  await compactStore.restore(index);
              if (restored == null) continue;
              compact[index] = restored;
              committedCheckpointIndices.add(index);
              restoredCompactCount++;
            }
            rollingRecoverableItems = restoredCompactCount;
            await reporter.update(
              progress: (restoredCompactCount / sourcePaths.length) * 0.30,
              stage: '星検出 1/2',
              currentItem: restoredCompactCount,
            );

            for (final _MilkyWayCompactFrameFeatures? restored in compact) {
              if (restored == null) continue;
              expectedWidth ??= restored.width;
              expectedHeight ??= restored.height;
              if (restored.width != expectedWidth ||
                  restored.height != expectedHeight) {
                throw StateError(
                  'Decoded frame dimension mismatch in Milky Way compact '
                  'checkpoint.',
                );
              }
            }

            for (int index = 0; index < sourcePaths.length; index++) {
              if (reporter.cancellationRequested) {
                throw const StackJobCancelledException();
              }
              if (compact[index] != null) continue;
              if (expectedWidth != null && expectedHeight != null) {
                await _ensureRollingMilkyWayStorageHeadroom(
                  width: expectedWidth,
                  height: expectedHeight,
                );
                final MemoryAdmissionDecision admission =
                    await memoryAdmission.waitUntilAdmitted(
                  requiredAdditionalBytes: MemoryAdmissionController
                      .estimateFullFrameAdditionalBytes(
                    width: expectedWidth,
                    height: expectedHeight,
                  ),
                  checkpointAvailable: committedCheckpointIndices.isNotEmpty,
                );
                if (admission.shouldRecycleProcessor) {
                  throw ProcessorMaintenanceRestartRequested(admission.reason);
                }
                if (!admission.safeToStart) {
                  throw StateError(
                    '次の天の川RAW解析に必要なメモリ余裕を確保できませんでした。 '
                    '${admission.reason}',
                  );
                }
              }

              ({
                LinearRgbTileStore store,
                DngFinalRenderProfile? profile,
                RawSaturationMask? saturationMask,
              })? decoded;
              LinearRgbTileStore? analysisStore;
              try {
                decoded = await _decodeStarTrailFrameForRolling(
                  index: index,
                  sourcePath: sourcePaths[index],
                  mode: ProcessingMode.milkyWay,
                  decoderRegistry: decoderRegistry,
                  metadataProbe: metadataProbe,
                  masterDarkStore: masterDarkStore,
                  masterFlatStore: masterFlatStore,
                  isCancelled: () => reporter.cancellationRequested,
                  reportProgress: (double frameProgress) {
                    reporter.updateBestEffort(
                      progress:
                          ((index + frameProgress) / sourcePaths.length) * 0.30,
                      stage: '星検出 1/2',
                      currentItem: index,
                    );
                  },
                );
                analysisStore = decoded.store;
                RawSaturationMask? analysisMask = decoded.saturationMask;
                if (quality.linearScale < 1) {
                  analysisStore = await downscaleLinearRgbStore(
                    source: decoded.store,
                    linearScale: quality.linearScale,
                    outputStoreFactory:
                        FileBackedLinearRgbTileStore.createTemporary,
                  );
                  analysisMask = null;
                }
                final List<DetectedStar> stars =
                    await detectMilkyWayRegistrationStars(
                  analysisStore,
                  saturationInfluenceMask: analysisMask,
                  isCancelled: () => reporter.cancellationRequested,
                  registrationModel: milkyWayRegistrationModel,
                );
                final _MilkyWayCompactFrameFeatures features =
                    _MilkyWayCompactFrameFeatures(
                  sourcePath: sourcePaths[index],
                  width: analysisStore.width,
                  height: analysisStore.height,
                  stars: stars,
                );
                expectedWidth ??= features.width;
                expectedHeight ??= features.height;
                await compactStore.save(index, features);
                compact[index] = features;
                committedCheckpointIndices.add(index);
                rollingRecoverableItems = committedCheckpointIndices.length;
              } on TiledStackingCancelled {
                throw const StackJobCancelledException();
              } on ProcessorMaintenanceRestartRequested {
                rethrow;
              } on _StorageCapacityException {
                rethrow;
              } on Object catch (error) {
                if (decoded == null) {
                  decodeFailures[index] = error;
                } else {
                  detectionFailures[index] = error;
                }
                await DiagnosticLog.log(
                  'Milky Way compact analysis excluded frame=$index: $error',
                );
              } finally {
                final LinearRgbTileStore? processed = analysisStore;
                final LinearRgbTileStore? original = decoded?.store;
                if (processed != null && processed != original) {
                  await processed.dispose();
                }
                await original?.dispose();
              }
              await reporter.update(
                progress: ((index + 1) / sourcePaths.length) * 0.30,
                stage: '星検出 1/2',
                currentItem: index + 1,
              );
              if (sourcePaths.length >= 8 && index < sourcePaths.length - 1) {
                await waitSafeToStartNextFrame();
              }
            }

            int? geometryReferenceIndex;
            for (int index = 0; index < compact.length; index++) {
              final _MilkyWayCompactFrameFeatures? features = compact[index];
              if (features == null) continue;
              geometryReferenceIndex ??= index;
              if (features.width != expectedWidth ||
                  features.height != expectedHeight) {
                throw StateError(
                  'Decoded frame dimension mismatch: frame $index is '
                  '${features.width}x${features.height}, while frame '
                  '$geometryReferenceIndex is '
                  '${expectedWidth}x$expectedHeight.',
                );
              }
            }
            final Map<int, List<DetectedStar>> starsByFrame =
                <int, List<DetectedStar>>{
              for (int index = 0; index < compact.length; index++)
                if (compact[index] != null) index: compact[index]!.stars,
            };
            registrationPlan = buildMilkyWayRegistrationPlan(
              sourcePaths: sourcePaths,
              detectedStarsByFrame: starsByFrame,
              decodeFailures: decodeFailures,
              starDetectionFailures: detectionFailures,
              referenceIndex: referenceIndex,
              enableLocalRegistration: quality.enableLocalRegistration,
              imageWidth: expectedWidth,
              imageHeight: expectedHeight,
              registrationModel: milkyWayRegistrationModel,
            );
            rollingReferenceQualityStars =
                starsByFrame[registrationPlan.referenceIndex]!;
            expectedWidth ??= compact[registrationPlan.referenceIndex]!.width;
            expectedHeight ??= compact[registrationPlan.referenceIndex]!.height;

            for (final MilkyWayFrameDiagnostics diagnostic
                in registrationPlan.diagnostics) {
              await DiagnosticLog.log(
                'Milky Way registration diagnostics: '
                'source=${diagnostic.sourcePath} '
                'included=${diagnostic.included} '
                'excludedReason=${diagnostic.excludedReason} '
                'detectedStars=${diagnostic.detectedStarCount} '
                'matchedStars=${diagnostic.matchedStarCount} '
                'rotationDeg=${diagnostic.rotationDegrees} '
                'offsetX=${diagnostic.sourceOffsetX} '
                'offsetY=${diagnostic.sourceOffsetY} '
                'rmsResidualPx=${diagnostic.rmsResidual} '
                'globalRmsResidualPx=${diagnostic.globalRmsResidual} '
                'residualP95Px=${diagnostic.residualP95} '
                'residualMaxPx=${diagnostic.residualMax} '
                'residualDirectionalCoherence='
                '${diagnostic.residualDirectionalCoherence} '
                'registrationRmsLimitPx=${diagnostic.registrationRmsLimit} '
                'matchSpanX=${diagnostic.matchSpanXFraction} '
                'matchSpanY=${diagnostic.matchSpanYFraction} '
                'matchQuadrants=${diagnostic.matchOccupiedQuadrants} '
                'localCorrectionApplied=${diagnostic.localCorrectionApplied} '
                'weight=${diagnostic.registrationWeight}',
              );
            }
            for (final MilkyWayRegisteredFrame registered
                in registrationPlan.frames) {
              final correction = registered.localCorrection;
              await DiagnosticLog.log(
                'Milky Way local residual correction: '
                'frame=${registered.frameIndex} '
                'fitted=${correction?.fitted ?? false} '
                'maxCorrectionMagnitude='
                '${correction?.maximumCorrectionMagnitude}',
              );
            }

            // See WORK344 fix note above this block: the resolved frame
            // order is exactly what the rolling accumulator's stored
            // pixel data is relative to, so it must be part of the
            // checkpoint's identity, not just the static job config.
            final String frameCompositionFingerprint = registrationPlan.frames
                .map((MilkyWayRegisteredFrame frame) => frame.frameIndex)
                .join(',');
            rollingWeightedAverageCheckpoints =
                RollingWeightedAverageCheckpointStore(
              statusPath: statusPath,
              identity: '$postDecodeIdentity|frames='
                  '$frameCompositionFingerprint',
            );
            accumulatorStore = rollingWeightedAverageCheckpoints!;
          }

          await reporter.update(progress: 0.31, stage: '基準写真を準備');
          final decodedReference = await _decodeStarTrailFrameForRolling(
            index: referenceIndex,
            sourcePath: sourcePaths[referenceIndex],
            mode: ProcessingMode.milkyWay,
            decoderRegistry: decoderRegistry,
            metadataProbe: metadataProbe,
            masterDarkStore: masterDarkStore,
            masterFlatStore: masterFlatStore,
            isCancelled: () => reporter.cancellationRequested,
          );
          final DngFinalRenderProfile? renderProfile = decodedReference.profile;
          if (renderProfile == null ||
              renderProfile.sourceId != sourcePaths[referenceIndex]) {
            await decodedReference.store.dispose();
            throw StateError('基準写真の最終レンダープロファイルを再構築できませんでした。');
          }
          final AutoToneParameters fixedToneBaseline =
              await estimateFixedToneBaselineFromReferenceFrame(
            referenceStore: decodedReference.store,
            renderProfile: renderProfile,
          );
          LinearRgbTileStore referenceProcessingStore = decodedReference.store;
          RawSaturationMask? referenceSaturationMask =
              decodedReference.saturationMask;
          if (quality.linearScale < 1) {
            referenceProcessingStore = await downscaleLinearRgbStore(
              source: decodedReference.store,
              linearScale: quality.linearScale,
              outputStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
            );
            referenceSaturationMask = null;
          }

          try {
            LinearRgbTileStore finalStore;
            LinearContributionTileStore? finalContributions;
            if (restoredPostDecode != null) {
              finalStore = restoredPostDecode!.rgbStore;
              finalContributions = restoredPostDecode!.contributionStore;
              activePostDecodeRgb = finalStore;
              activePostDecodeContribution = finalContributions;
              rollingRecoverableItems = sourcePaths.length;
            } else {
              final MilkyWayRegistrationPlan plan = registrationPlan!;
              if (plan.referenceIndex != referenceIndex) {
                throw StateError(
                    'Milky Way reference plan changed unexpectedly.');
              }
              if (referenceProcessingStore.width != expectedWidth ||
                  referenceProcessingStore.height != expectedHeight) {
                throw StateError(
                    'Milky Way reference dimensions changed between passes.');
              }
              final double maximumFrameWeight = plan.frames
                  .map((MilkyWayRegisteredFrame frame) => frame.weight)
                  .reduce((double a, double b) => a > b ? a : b);
              await _ensureRollingMilkyWayStorageHeadroom(
                width: referenceProcessingStore.width,
                height: referenceProcessingStore.height,
              );

              Float64RgbTileStore? rollingWeightedSum;
              Float64RgbTileStore? rollingWeightSum;
              int rollingItems = 0;
              final RollingWeightedAverageCheckpoint? restoredAccumulator =
                  await accumulatorStore.restore();
              if (restoredAccumulator != null &&
                  restoredAccumulator.committedItems <= plan.frames.length &&
                  restoredAccumulator.weightedSum.width ==
                      referenceProcessingStore.width &&
                  restoredAccumulator.weightedSum.height ==
                      referenceProcessingStore.height) {
                rollingWeightedSum = restoredAccumulator.weightedSum;
                rollingWeightSum = restoredAccumulator.weightSum;
                rollingItems = restoredAccumulator.committedItems;
                activeRollingWeightedSum = rollingWeightedSum;
                activeRollingWeightSum = rollingWeightSum;
                rollingRecoverableItems = rollingItems;
              } else if (restoredAccumulator != null) {
                await restoredAccumulator.weightedSum.closeRetainingFile();
                await restoredAccumulator.weightSum.closeRetainingFile();
                await accumulatorStore.cleanupAll();
              }

              for (int position = rollingItems;
                  position < plan.frames.length;
                  position++) {
                if (reporter.cancellationRequested) {
                  throw const StackJobCancelledException();
                }
                final MilkyWayRegisteredFrame registered =
                    plan.frames[position];
                final bool isReference =
                    registered.frameIndex == plan.referenceIndex;
                ({
                  LinearRgbTileStore store,
                  DngFinalRenderProfile? profile,
                  RawSaturationMask? saturationMask,
                })? decodedCurrent;
                LinearRgbTileStore currentStore = referenceProcessingStore;
                RawSaturationMask? currentMask = referenceSaturationMask;
                if (!isReference) {
                  final MemoryAdmissionDecision admission =
                      await memoryAdmission.waitUntilAdmitted(
                    requiredAdditionalBytes: MemoryAdmissionController
                        .estimateFullFrameAdditionalBytes(
                      width: referenceProcessingStore.width,
                      height: referenceProcessingStore.height,
                    ),
                    checkpointAvailable: rollingItems > 0,
                  );
                  if (admission.shouldRecycleProcessor) {
                    throw ProcessorMaintenanceRestartRequested(
                      admission.reason,
                    );
                  }
                  if (!admission.safeToStart) {
                    throw StateError(
                      '次の天の川合成RAWに必要なメモリ余裕を確保できませんでした。 '
                      '${admission.reason}',
                    );
                  }
                  decodedCurrent = await _decodeStarTrailFrameForRolling(
                    index: registered.frameIndex,
                    sourcePath: sourcePaths[registered.frameIndex],
                    mode: ProcessingMode.milkyWay,
                    decoderRegistry: decoderRegistry,
                    metadataProbe: metadataProbe,
                    masterDarkStore: masterDarkStore,
                    masterFlatStore: masterFlatStore,
                    isCancelled: () => reporter.cancellationRequested,
                  );
                  currentStore = decodedCurrent.store;
                  currentMask = decodedCurrent.saturationMask;
                  if (quality.linearScale < 1) {
                    currentStore = await downscaleLinearRgbStore(
                      source: decodedCurrent.store,
                      linearScale: quality.linearScale,
                      outputStoreFactory:
                          FileBackedLinearRgbTileStore.createTemporary,
                    );
                    currentMask = null;
                  }
                }
                try {
                  if (currentStore.width != referenceProcessingStore.width ||
                      currentStore.height != referenceProcessingStore.height) {
                    throw StateError(
                      'Decoded frame dimension mismatch during Milky Way '
                      'rolling combination.',
                    );
                  }
                  final MilkyWayRegisteredFrameSampler sampler =
                      MilkyWayRegisteredFrameSampler(
                    frame: registered,
                    referenceIndex: plan.referenceIndex,
                    referenceStore: referenceProcessingStore,
                    sourceStore: currentStore,
                    referenceInvalidMask: referenceSaturationMask,
                    sourceInvalidMask: currentMask,
                    outputImageWidth: referenceProcessingStore.width,
                    outputImageHeight: referenceProcessingStore.height,
                    interpolation: quality.interpolation,
                    preserveStaticForeground: quality.preserveStaticForeground,
                    isCancelled: () => reporter.cancellationRequested,
                  );
                  final merged =
                      await mergeIntoRollingWeightedAverageAccumulator(
                    width: referenceProcessingStore.width,
                    height: referenceProcessingStore.height,
                    readFrame: sampler.sampleTile,
                    frameWeight: registered.weight / maximumFrameWeight,
                    outputWeightedSumStoreFactory:
                        accumulatorStore.createWeightedSumStore,
                    outputWeightSumStoreFactory:
                        accumulatorStore.createWeightSumStore,
                    previousWeightedSum: rollingWeightedSum,
                    previousWeightSum: rollingWeightSum,
                    tileSize: effectiveTileSize,
                    isCancelled: () => reporter.cancellationRequested,
                  );
                  final Float64RgbTileStore? oldWeightedSum =
                      rollingWeightedSum;
                  final Float64RgbTileStore? oldWeightSum = rollingWeightSum;
                  if (oldWeightedSum != null) {
                    await accumulatorStore.closeRetainingStore(oldWeightedSum);
                  }
                  if (oldWeightSum != null) {
                    await accumulatorStore.closeRetainingStore(oldWeightSum);
                  }
                  await accumulatorStore.publishCommitted(
                    weightedSum: merged.weightedSum,
                    weightSum: merged.weightSum,
                    committedItems: position + 1,
                  );
                  rollingWeightedSum = merged.weightedSum;
                  rollingWeightSum = merged.weightSum;
                  activeRollingWeightedSum = rollingWeightedSum;
                  activeRollingWeightSum = rollingWeightSum;
                  rollingItems = position + 1;
                  rollingRecoverableItems = rollingItems;
                } finally {
                  if (!isReference) {
                    if (currentStore != decodedCurrent!.store) {
                      await currentStore.dispose();
                    }
                    await decodedCurrent.store.dispose();
                  }
                }
                await reporter.update(
                  progress: 0.30 + ((position + 1) / plan.frames.length) * 0.55,
                  stage: '位置合わせ・スタック 2/2',
                  currentItem: position + 1,
                );
                if (plan.frames.length >= 8 &&
                    position < plan.frames.length - 1) {
                  await waitSafeToStartNextFrame();
                }
              }
              if (rollingWeightedSum == null || rollingWeightSum == null) {
                throw StateError('天の川FP64累積Checkpointが生成されませんでした。');
              }

              await reporter.update(progress: 0.88, stage: 'FP64合成を確定');
              final RollingWeightedAverageFinalized finalized =
                  await finalizeRollingWeightedAverageWithContributions(
                weightedSum: rollingWeightedSum,
                weightSum: rollingWeightSum,
                outputStoreFactory: postDecodeCheckpoints!.createRgbStore,
                contributionStoreFactory:
                    postDecodeCheckpoints!.createContributionStore,
                tileSize: effectiveTileSize,
                isCancelled: () => reporter.cancellationRequested,
              );
              // WORK347: do not publish a resumable "finalized" checkpoint
              // until the final stack has passed the same PSF-preservation
              // gate as the classic kappa-sigma path. A failed quality result
              // must not become a reusable successful checkpoint.
              try {
                final List<DetectedStar> finalStackStars =
                    await detectMilkyWayRegistrationStars(
                  finalized.rgb,
                  isCancelled: () => reporter.cancellationRequested,
                  registrationModel: milkyWayRegistrationModel,
                );
                final List<DetectedStar> referenceQualityStars =
                    rollingReferenceQualityStars!;
                final StarPsfQualityComparison psfComparison =
                    compareRegisteredStarPsf(
                  referenceStars: referenceQualityStars,
                  finalStars: finalStackStars,
                );
                final StarPsfQualityGateResult psfGate =
                    evaluateStarPsfQualityGate(comparison: psfComparison);
                await DiagnosticLog.log(
                  'Milky Way final PSF quality (rolling): '
                  'referenceStars=${psfComparison.referenceStarCount} '
                  'finalStars=${psfComparison.finalStarCount} '
                  'referenceMeasured=${psfComparison.referenceMeasuredStarCount} '
                  'finalMeasured=${psfComparison.finalMeasuredStarCount} '
                  'positionMatched=${psfComparison.positionMatchedCount} '
                  'measuredPairs=${psfComparison.measuredPairCount} '
                  'medianFwhmRatio=${psfComparison.medianFwhmRatio} '
                  'p90FwhmRatio=${psfComparison.p90FwhmRatio} '
                  'medianRoundnessDelta=${psfComparison.medianRoundnessDelta} '
                  'passed=${psfGate.passed} '
                  'reasons=${psfGate.reasons.join(" | ")}',
                );
                if (!psfGate.passed) {
                  throw MilkyWayStackQualityFailed(psfGate);
                }
                final FlatSkyNoiseQualityComparison noiseComparison =
                    await compareFlatSkyNoise(
                  referenceStore: referenceProcessingStore,
                  finalStore: finalized.rgb,
                  referenceStars: referenceQualityStars,
                );
                final FlatSkyNoiseQualityGateResult noiseGate =
                    evaluateFlatSkyNoiseQualityGate(
                  comparison: noiseComparison,
                );
                await DiagnosticLog.log(
                  'Milky Way flat-sky noise quality (rolling): '
                  'candidateTiles=${noiseComparison.candidateTileCount} '
                  'selectedTiles=${noiseComparison.selectedTileCount} '
                  'coefficients=${noiseComparison.sampledCoefficientCount} '
                  'referenceSigma=${noiseComparison.referenceSigma} '
                  'finalSigma=${noiseComparison.finalSigma} '
                  'noiseRatio=${noiseComparison.noiseRatio} '
                  'verified=${noiseGate.hasEnoughMeasurements} '
                  'passed=${noiseGate.passed} '
                  'reasons=${noiseGate.reasons.join(" | ")}',
                );
                if (!noiseGate.passed) {
                  throw MilkyWayNoiseQualityFailed(noiseGate);
                }
              } on Object {
                final LinearContributionTileStore? failedContributions =
                    finalized.contributions;
                if (failedContributions != null) {
                  try {
                    await failedContributions.abort();
                  } on Object {
                    // Preserve the original quality/detection failure.
                  }
                }
                try {
                  await finalized.rgb.abort();
                } on Object {
                  // Preserve the original quality/detection failure.
                }
                rethrow;
              }
              await postDecodeCheckpoints!.publishCommitted(
                rgbStore: finalized.rgb,
                contributionStore: finalized.contributions,
                committedItems: sourcePaths.length,
                checkpointStage: 'finalized',
              );
              final LinearContributionTileStore? contributionsForLogging =
                  finalized.contributions;
              if (contributionsForLogging != null) {
                await _logContributionValidityStatistics(
                  contributionsForLogging,
                  label: 'milkyWayRolling',
                );
              }
              finalStore = finalized.rgb;
              finalContributions = finalized.contributions;
              activePostDecodeRgb = finalStore;
              activePostDecodeContribution = finalContributions;
              postDecodeCheckpointAvailable = true;
              rollingRecoverableItems = sourcePaths.length;
              await accumulatorStore.closeRetainingStore(rollingWeightedSum);
              await accumulatorStore.closeRetainingStore(rollingWeightSum);
              activeRollingWeightedSum = null;
              activeRollingWeightSum = null;
              cleanupRollingWeightedAverageOnExit = true;
              cleanupMilkyWayCompactFeaturesOnExit = true;
            }

            await File(outputPath).parent.create(recursive: true);
            await reporter.update(progress: 0.94, stage: '最終画像エンコード');
            final bool bakesToneAdjustments =
                outputFormat != OutputImageFormat.linearDng;
            // Keep preview/final rendering on the same fixed reference-frame
            // tone baseline. Re-estimating tone from the stack changes the
            // rendered contrast and can hide or exaggerate noise independently
            // of the stacking arithmetic, which makes A/B quality diagnosis
            // unreliable and contradicts estimateFixedToneBaselineFromReferenceFrame.
            await DiagnosticLog.log(
              'Milky Way tone baseline (fixed reference, WORK345): '
              'exposureScale=${fixedToneBaseline.exposureScale} '
              'whitePoint=${fixedToneBaseline.whitePoint}',
            );
            await exportTileStoreToImage(
              tileStore: finalStore,
              outputPath: outputPath,
              format: outputFormat,
              linearDngCompression: storagePreset.dngCompression,
              exposureScale:
                  bakesToneAdjustments ? fixedToneBaseline.exposureScale : null,
              whitePoint:
                  bakesToneAdjustments ? fixedToneBaseline.whitePoint : null,
              renderProfile: renderProfile,
              contributionStore: finalContributions,
              isCancelled: () => reporter.cancellationRequested,
            );
            await postDecodeCheckpoints!.publishExportReceipt(outputPath);
          } finally {
            if (referenceProcessingStore != decodedReference.store) {
              await referenceProcessingStore.dispose();
            }
            await decodedReference.store.dispose();
          }

          cleanupMilkyWayCompactFeaturesOnExit = true;
          cleanupRollingWeightedAverageOnExit = true;
          cleanupPostDecodeCheckpointOnExit = true;
          await operationJournal.complete(
            operation: 'standardStackJob',
            stage: 'completedRollingMilkyWay',
            committedItems: sourcePaths.length,
          );
          jobHandledSuccessfully = true;
          await reporter.complete();
          return true;
        }

        if (useRollingStarTrail) {
          // Work324 no longer consumes the legacy one-FP32-file-per-frame
          // checkpoints. Delete them before the first pass so an upgrade from
          // Work323 immediately recovers that space; compact feature sidecars
          // and the rolling accumulator are the new recovery authority.
          await decodeCheckpoints?.cleanupAll();
          cleanupDecodeCheckpointsOnExit = true;
          if (restoredPostDecode == null) {
            await postDecodeCheckpoints?.cleanupAll();
          }
          await DiagnosticLog.log(
            'rolling star-trail pipeline enabled: compact analysis + exact durable rolling max',
          );
          final List<MeteorCompactFrameFeatures?> compact =
              List<MeteorCompactFrameFeatures?>.filled(
                  sourcePaths.length, null);
          int restoredCompactCount = 0;
          for (int index = 0; index < sourcePaths.length; index++) {
            final MeteorCompactFrameFeatures? restored =
                await compactFeatureCheckpoints!.restore(index);
            if (restored == null) continue;
            compact[index] = restored;
            committedCheckpointIndices.add(index);
            restoredCompactCount++;
          }
          rollingRecoverableItems = restoredCompactCount;
          await reporter.update(
            progress: sourcePaths.isEmpty
                ? 0
                : (restoredCompactCount / sourcePaths.length) * 0.30,
            stage: '軌跡解析 1/2',
            currentItem: restoredCompactCount,
            recoverableCheckpointItems: restoredCompactCount,
          );

          // Work364: fused star-trail path. Frames that cannot receive any
          // streak exclusion (no streak candidates, or aircraft removal off)
          // are merged into the comparison-light maximum already during the
          // analysis pass, so the second pass decodes only the remaining
          // frames. The maximum is order-independent except for +0.0/-0.0
          // ties, which the merge reports; on such a tie the job falls back
          // to the historical in-order second pass (identical output).
          // Not used with features that need every frame in order or all
          // frames first (hot-pixel map, rolling float sums).
          final File fusedDisabledMarker = File(
            '${File(statusPath).parent.path}${Platform.pathSeparator}'
            'star_trail_fused_disabled_v1',
          );
          bool fusedStarTrail = starTrailFusedPremergeEnabled &&
              !starTrailHotPixelRemoval &&
              !starTrailMeanBackground &&
              !(starTrailForegroundAverage &&
                  automaticStarTrailForegroundProtection) &&
              !await fusedDisabledMarker.exists();
          bool mayReceiveExclusions(MeteorCompactFrameFeatures features) =>
              automaticStarTrailAircraftRemoval && features.streaks.isNotEmpty;
          LinearRgbTileStore? premergeRgb;
          LinearContributionTileStore? premergeValidity;
          int premergeItems = 0;
          if (fusedStarTrail) {
            final PostDecodePipelineCheckpoint? restored = restoredPostDecode;
            final String? restoredStage = restored?.checkpointStage;
            if (restoredStage == 'rolling') {
              // An in-order second pass is already under way (job started
              // before Work364 or after a fallback): keep it.
              fusedStarTrail = false;
            } else if (restoredStage == 'fusedRolling' ||
                restoredStage == 'finalized') {
              // The analysis pass and its premerge are complete.
              premergeItems = sourcePaths.length;
            } else if (restored != null &&
                restoredStage == 'premerge' &&
                restored.contributionStore != null) {
              premergeRgb = restored.rgbStore;
              premergeValidity = restored.contributionStore;
              premergeItems = restored.committedItems ?? 0;
            }
            await DiagnosticLog.log(
              'starTrail fused path enabled premergeItems=$premergeItems',
            );
          }

          int? knownWidth;
          int? knownHeight;
          for (final MeteorCompactFrameFeatures? restored in compact) {
            if (restored != null) {
              knownWidth = restored.width;
              knownHeight = restored.height;
              break;
            }
          }
          for (int index = 0; index < sourcePaths.length; index++) {
            if (reporter.cancellationRequested) {
              throw const StackJobCancelledException();
            }
            final MeteorCompactFrameFeatures? alreadyAnalyzed = compact[index];
            if (alreadyAnalyzed != null &&
                !(fusedStarTrail &&
                    index >= premergeItems &&
                    !mayReceiveExclusions(alreadyAnalyzed))) {
              continue;
            }
            if (knownWidth != null && knownHeight != null) {
              await _ensureRollingStarTrailStorageHeadroom(
                width: knownWidth,
                height: knownHeight,
              );
              final MemoryAdmissionDecision admission =
                  await memoryAdmission.waitUntilAdmitted(
                requiredAdditionalBytes:
                    MemoryAdmissionController.estimateFullFrameAdditionalBytes(
                  width: knownWidth,
                  height: knownHeight,
                ),
                checkpointAvailable: committedCheckpointIndices.isNotEmpty,
              );
              if (admission.shouldRecycleProcessor) {
                throw ProcessorMaintenanceRestartRequested(admission.reason);
              }
              if (!admission.safeToStart) {
                throw StateError(
                  '次のRAW解析に必要なメモリ余裕を確保できませんでした。 ${admission.reason}',
                );
              }
            }

            final Stopwatch frameTimer = Stopwatch()..start();
            final Stopwatch decodeTimer = Stopwatch()..start();
            final decoded = await _decodeStarTrailFrameForRolling(
              index: index,
              sourcePath: sourcePaths[index],
              decoderRegistry: decoderRegistry,
              metadataProbe: metadataProbe,
              masterDarkStore: masterDarkStore,
              masterFlatStore: masterFlatStore,
              isCancelled: () => reporter.cancellationRequested,
              reportProgress: (double frameProgress) {
                final double overall =
                    (index + frameProgress) / sourcePaths.length;
                reporter.updateBestEffort(
                  progress: overall * 0.30,
                  stage: '軌跡解析 1/2',
                  currentItem: index,
                );
              },
            );
            decodeTimer.stop();
            // Historically labelled "decode", but this timer actually spans
            // the whole per-frame RAW pipeline call — native RAW decode plus
            // every calibration/demosaic stage. Renamed so it can't be
            // mistaken for native-decode-only time; see the more granular
            // `phase2 stage=<id> elapsedMs=...` lines (one per pipeline
            // stage, logged from `runPhase2ValidatedJob`) for the real
            // per-stage breakdown, e.g. how much of this total is demosaic.
            await DiagnosticLog.log(
              'starTrail profile frame=$index stage=raw-decode-and-pipeline '
              'elapsedMs=${decodeTimer.elapsedMilliseconds}',
            );
            LinearRgbTileStore analysisStore = decoded.store;
            if (quality.linearScale < 1) {
              analysisStore = await downscaleLinearRgbStore(
                source: decoded.store,
                linearScale: quality.linearScale,
                outputStoreFactory:
                    FileBackedLinearRgbTileStore.createTemporary,
              );
            }
            knownWidth = analysisStore.width;
            knownHeight = analysisStore.height;
            try {
              final Stopwatch featureTimer = Stopwatch()..start();
              final MeteorCompactFrameFeatures features =
                  await extractMeteorCompactFrameFeatures(
                sourcePath: sourcePaths[index],
                store: analysisStore,
                isCancelled: () => reporter.cancellationRequested,
                reportTiming: (String stage, Duration elapsed) {
                  unawaited(DiagnosticLog.log(
                    'starTrail profile frame=$index stage=$stage '
                    'elapsedMs=${elapsed.inMilliseconds}',
                  ));
                },
              );
              featureTimer.stop();
              await DiagnosticLog.log(
                'starTrail profile frame=$index stage=feature-total '
                'elapsedMs=${featureTimer.elapsedMilliseconds} '
                'streaks=${features.streaks.length} stars=${features.stars.length}',
              );
              if (starTrailHotPixelRemoval) {
                // Saved before the feature checkpoint so a restored frame
                // always has its candidates too.
                final Int32List candidates =
                    await detectStationaryPointCandidates(
                  analysisStore,
                  isCancelled: () => reporter.cancellationRequested,
                );
                await hotCandidateStore.save(
                  index,
                  analysisStore.width,
                  candidates,
                );
                await DiagnosticLog.log(
                  'starTrail hotPixel candidates frame=$index '
                  'count=${candidates.length}',
                );
              }
              final Stopwatch checkpointTimer = Stopwatch()..start();
              await compactFeatureCheckpoints!.save(index, features);
              checkpointTimer.stop();
              await DiagnosticLog.log(
                'starTrail profile frame=$index stage=checkpoint-save '
                'elapsedMs=${checkpointTimer.elapsedMilliseconds}',
              );
              compact[index] = features;
              committedCheckpointIndices.add(index);
              rollingRecoverableItems = committedCheckpointIndices.length;
              if (fusedStarTrail &&
                  index >= premergeItems &&
                  !mayReceiveExclusions(features)) {
                await _ensureRollingStarTrailStorageHeadroom(
                  width: analysisStore.width,
                  height: analysisStore.height,
                );
                // No exclusions are possible for this frame: the second
                // pass would merge it exactly like this.
                final premerged = await mergeStarTrailFrameIntoRollingAccumulator(
                  frameStore: analysisStore,
                  previousRgb: premergeRgb,
                  previousValidity: premergeValidity,
                  outputRgbStoreFactory: postDecodeCheckpoints!.createRgbStore,
                  outputValidityStoreFactory:
                      postDecodeCheckpoints!.createContributionStore,
                  tileSize: effectiveTileSize,
                  frameWeight: starTrailFadeWeights[index],
                  isCancelled: () => reporter.cancellationRequested,
                );
                final LinearContributionTileStore? oldValidity =
                    premergeValidity;
                if (oldValidity != null) {
                  await postDecodeCheckpoints!
                      .closeRetainingContribution(oldValidity);
                }
                final LinearRgbTileStore? oldRgb = premergeRgb;
                if (oldRgb != null) {
                  await postDecodeCheckpoints!.closeRetainingRgb(oldRgb);
                }
                await postDecodeCheckpoints!.publishCommitted(
                  rgbStore: premerged.rgb,
                  contributionStore: premerged.validity,
                  committedItems: index + 1,
                  checkpointStage: 'premerge',
                );
                premergeRgb = premerged.rgb;
                premergeValidity = premerged.validity;
                premergeItems = index + 1;
                // Same bookkeeping as the second pass: these stores are the
                // live post-decode checkpoint (closed-retaining on exit).
                activePostDecodeRgb = premerged.rgb;
                activePostDecodeContribution = premerged.validity;
                postDecodeCheckpointAvailable = true;
                await DiagnosticLog.log(
                  'starTrail fused premerge frame=$index',
                );
              }
              await reporter.update(
                progress: ((index + 1) / sourcePaths.length) * 0.30,
                stage: '軌跡解析 1/2',
                currentItem: index + 1,
                recoverableCheckpointItems: rollingRecoverableItems,
              );
            } finally {
              if (analysisStore != decoded.store) {
                await analysisStore.dispose();
              }
              await decoded.store.dispose();
            }
            final Stopwatch journalTimer = Stopwatch()..start();
            await operationJournal.complete(
              operation: 'starTrailCompactAnalysis',
              stage: '軌跡解析 1/2',
              frameIndex: index,
              committedItems: committedCheckpointIndices.length,
            );
            journalTimer.stop();
            await DiagnosticLog.log(
              'starTrail profile frame=$index stage=journal-save '
              'elapsedMs=${journalTimer.elapsedMilliseconds} '
              'committed=${committedCheckpointIndices.length}',
            );
            if (sourcePaths.length >= 8 && index < sourcePaths.length - 1) {
              final Stopwatch resourceWaitTimer = Stopwatch()..start();
              final AdaptiveResourceDecision waitDecision =
                  await waitSafeToStartNextFrame();
              resourceWaitTimer.stop();
              await DiagnosticLog.log(
                'starTrail profile frame=$index stage=resource-wait '
                'elapsedMs=${resourceWaitTimer.elapsedMilliseconds} '
                'state=${waitDecision.state.name}',
              );
            }
            frameTimer.stop();
            await DiagnosticLog.log(
              'starTrail profile frame=$index stage=frame-total '
              'elapsedMs=${frameTimer.elapsedMilliseconds}',
            );
          }

          final List<MeteorCompactFrameFeatures> features =
              compact.cast<MeteorCompactFrameFeatures>();
          // Work355: stationary hot-pixel map from the pass-1 candidates.
          Int32List hotPixelMap = Int32List(0);
          if (starTrailHotPixelRemoval && features.isNotEmpty) {
            final List<Int32List> candidateLists = <Int32List>[];
            for (int index = 0; index < features.length; index++) {
              final Int32List? restored = await hotCandidateStore.restore(
                index,
                width: features[index].width,
              );
              if (restored != null) candidateLists.add(restored);
            }
            hotPixelMap = buildStationaryHotPixelMap(candidateLists);
            await DiagnosticLog.log(
              'starTrail hotPixel map frames=${candidateLists.length}/'
              '${features.length} hotPixels=${hotPixelMap.length}',
            );
          }
          final List<List<StreakShape>> excludedStreaksByFrame =
              automaticStarTrailAircraftRemoval
                  ? classifyStarTrailNonSiderealCompactFeatures(
                      frames: features,
                      minimumBlinkSegmentsForIsolated:
                          starTrailMeteorProtection
                              ? starTrailMeteorProtectionMinimumBlinkSegments
                              : null,
                    )
                  : <List<StreakShape>>[
                      for (int i = 0; i < sourcePaths.length; i++)
                        <StreakShape>[],
                    ];
          final List<GapFillSegment> gapSegments = <GapFillSegment>[];
          if (starTrailGapFillMode != StarTrailGapFillMode.off) {
            for (int index = 1; index < features.length; index++) {
              gapSegments.addAll(computeGapFillSegments(
                starsBefore: features[index - 1].stars,
                starsAfter: features[index].stars,
                mode: starTrailGapFillMode,
                reportDiagnostic: (message) => unawaited(
                    DiagnosticLog.log('gapFill frame=$index: $message')),
              ));
            }
          }

          LinearRgbTileStore? rollingRgb;
          LinearContributionTileStore? rollingValidity;
          int rollingItems = 0;
          bool rollingFinalized = false;
          if (restoredPostDecode != null) {
            final int restoredItems = restoredPostDecode!.committedItems ?? 0;
            final String? stage = restoredPostDecode!.checkpointStage;
            if (restoredItems >= 0 && restoredItems <= sourcePaths.length) {
              if (stage == 'finalized' && restoredItems == sourcePaths.length) {
                rollingRgb = restoredPostDecode!.rgbStore;
                rollingItems = restoredItems;
                rollingRecoverableItems = restoredItems;
                rollingFinalized = true;
              } else if (stage == 'rolling' &&
                  restoredPostDecode!.contributionStore != null) {
                rollingRgb = restoredPostDecode!.rgbStore;
                rollingValidity = restoredPostDecode!.contributionStore;
                rollingItems = restoredItems;
                rollingRecoverableItems = restoredItems;
              }
            }
          }

          // Work356: optional rolling sum (mean background / averaged
          // foreground). Published right after the maximum; if a restart
          // finds the two out of step, the mean features are skipped for
          // this job (the result is then the plain Work350 maximum).
          final bool needRollingSum = starTrailMeanBackground ||
              (starTrailForegroundAverage &&
                  automaticStarTrailForegroundProtection);
          PostDecodePipelineCheckpointStore? sumCheckpoints;
          LinearRgbTileStore? rollingSum;
          LinearContributionTileStore? rollingCount;
          bool rollingSumAvailable = needRollingSum && !rollingFinalized;
          if (rollingSumAvailable) {
            sumCheckpoints = PostDecodePipelineCheckpointStore(
              statusPath: statusPath,
              identity: '$postDecodeIdentity|starTrailRollingSum',
              directoryName: 'star_trail_rolling_sum_v1',
            );
            if (rollingItems == 0) {
              await sumCheckpoints.cleanupAll();
            } else {
              final PostDecodePipelineCheckpoint? restoredSum =
                  await sumCheckpoints.restore();
              if (restoredSum != null &&
                  restoredSum.committedItems == rollingItems &&
                  restoredSum.contributionStore != null) {
                rollingSum = restoredSum.rgbStore;
                rollingCount = restoredSum.contributionStore;
              } else {
                rollingSumAvailable = false;
                await DiagnosticLog.log(
                  'starTrail rolling sum not in step with the maximum '
                  '(sum=${restoredSum?.committedItems} max=$rollingItems); '
                  'mean background / averaged foreground skipped for this job',
                );
              }
            }
          }

          // Work364: fused path — continue from the second-pass checkpoint,
          // or start the second pass from the analysis-pass premerge.
          if (fusedStarTrail && !rollingFinalized) {
            final PostDecodePipelineCheckpoint? restored = restoredPostDecode;
            if (restored != null &&
                restored.checkpointStage == 'fusedRolling' &&
                restored.contributionStore != null) {
              rollingRgb = restored.rgbStore;
              rollingValidity = restored.contributionStore;
              rollingItems = restored.committedItems ?? 0;
            } else {
              rollingRgb = premergeRgb;
              rollingValidity = premergeValidity;
              rollingItems = 0;
            }
            rollingRecoverableItems = rollingItems;
          }

          bool restartInOrder = false;
          do {
            if (restartInOrder) {
              // A +0.0/-0.0 tie made the fused result order-dependent: redo
              // the second pass in the historical order from scratch.
              restartInOrder = false;
              fusedStarTrail = false;
              final LinearContributionTileStore? staleValidity =
                  rollingValidity;
              if (staleValidity != null) {
                await postDecodeCheckpoints!
                    .closeRetainingContribution(staleValidity);
              }
              final LinearRgbTileStore? staleRgb = rollingRgb;
              if (staleRgb != null) {
                await postDecodeCheckpoints!.closeRetainingRgb(staleRgb);
              }
              rollingRgb = null;
              rollingValidity = null;
              rollingItems = 0;
              rollingRecoverableItems = 0;
            }
          if (!rollingFinalized) {
            for (int index = rollingItems;
                index < sourcePaths.length;
                index++) {
              if (reporter.cancellationRequested) {
                throw const StackJobCancelledException();
              }
              if (fusedStarTrail && !mayReceiveExclusions(features[index])) {
                // Already merged during the analysis pass (premerge).
                continue;
              }
              final int passWidth = features[index].width;
              final int passHeight = features[index].height;
              await _ensureRollingStarTrailStorageHeadroom(
                width: passWidth,
                height: passHeight,
                includeRollingSum: rollingSumAvailable,
              );
              final MemoryAdmissionDecision passAdmission =
                  await memoryAdmission.waitUntilAdmitted(
                requiredAdditionalBytes:
                    MemoryAdmissionController.estimateFullFrameAdditionalBytes(
                  width: passWidth,
                  height: passHeight,
                ),
                checkpointAvailable: rollingItems > 0,
              );
              if (passAdmission.shouldRecycleProcessor) {
                throw ProcessorMaintenanceRestartRequested(
                    passAdmission.reason);
              }
              if (!passAdmission.safeToStart) {
                throw StateError(
                  '次の比較明RAW処理に必要なメモリ余裕を確保できませんでした。 ${passAdmission.reason}',
                );
              }
              final decoded = await _decodeStarTrailFrameForRolling(
                index: index,
                sourcePath: sourcePaths[index],
                decoderRegistry: decoderRegistry,
                metadataProbe: metadataProbe,
                masterDarkStore: masterDarkStore,
                masterFlatStore: masterFlatStore,
                isCancelled: () => reporter.cancellationRequested,
                reportProgress: (double frameProgress) {
                  final double overall =
                      (index + frameProgress * 0.35) / sourcePaths.length;
                  reporter.updateBestEffort(
                    progress: 0.30 + overall * 0.55,
                    stage: '比較明合成 2/2',
                    currentItem: index,
                  );
                },
              );
              LinearRgbTileStore mergeStore = decoded.store;
              if (quality.linearScale < 1) {
                mergeStore = await downscaleLinearRgbStore(
                  source: decoded.store,
                  linearScale: quality.linearScale,
                  outputStoreFactory:
                      FileBackedLinearRgbTileStore.createTemporary,
                );
              }
              await _ensureRollingStarTrailStorageHeadroom(
                width: mergeStore.width,
                height: mergeStore.height,
              );
              final LinearRgbTileStore correctedMergeStore =
                  hotPixelMap.isEmpty
                      ? mergeStore
                      : HotPixelCorrectedRgbStore(mergeStore, hotPixelMap);
              try {
                final merged = await mergeStarTrailFrameIntoRollingAccumulator(
                  frameStore: correctedMergeStore,
                  previousRgb: rollingRgb,
                  previousValidity: rollingValidity,
                  excludedStreaks: excludedStreaksByFrame[index],
                  outputRgbStoreFactory: postDecodeCheckpoints!.createRgbStore,
                  outputValidityStoreFactory:
                      postDecodeCheckpoints!.createContributionStore,
                  tileSize: effectiveTileSize,
                  frameWeight: starTrailFadeWeights[index],
                  isCancelled: () => reporter.cancellationRequested,
                  onSignedZeroTie: fusedStarTrail
                      ? () {
                          restartInOrder = true;
                        }
                      : null,
                );
                if (restartInOrder) {
                  await fusedDisabledMarker.writeAsString('1', flush: true);
                  await DiagnosticLog.log(
                    'starTrail fused path: signed-zero tie at frame=$index; '
                    'restarting the second pass in order',
                  );
                  await merged.rgb.dispose();
                  await merged.validity.dispose();
                  break;
                }
                final LinearRgbTileStore? oldRgb = rollingRgb;
                final LinearContributionTileStore? oldValidity =
                    rollingValidity;
                if (oldValidity != null) {
                  await postDecodeCheckpoints!
                      .closeRetainingContribution(oldValidity);
                }
                if (oldRgb != null) {
                  await postDecodeCheckpoints!.closeRetainingRgb(oldRgb);
                }
                await postDecodeCheckpoints!.publishCommitted(
                  rgbStore: merged.rgb,
                  contributionStore: merged.validity,
                  committedItems: index + 1,
                  checkpointStage: fusedStarTrail ? 'fusedRolling' : 'rolling',
                );
                rollingRgb = merged.rgb;
                rollingValidity = merged.validity;
                activePostDecodeRgb = merged.rgb;
                activePostDecodeContribution = merged.validity;
                postDecodeCheckpointAvailable = true;
                if (rollingSumAvailable) {
                  final PostDecodePipelineCheckpointStore sums =
                      sumCheckpoints!;
                  final sumMerged = await mergeStarTrailFrameIntoRollingSum(
                    frameStore: correctedMergeStore,
                    previousSum: rollingSum,
                    previousCount: rollingCount,
                    excludedStreaks: excludedStreaksByFrame[index],
                    outputSumStoreFactory: sums.createRgbStore,
                    outputCountStoreFactory: sums.createContributionStore,
                    tileSize: effectiveTileSize,
                    isCancelled: () => reporter.cancellationRequested,
                  );
                  final LinearContributionTileStore? oldCount = rollingCount;
                  if (oldCount != null) {
                    await sums.closeRetainingContribution(oldCount);
                  }
                  final LinearRgbTileStore? oldSum = rollingSum;
                  if (oldSum != null) {
                    await sums.closeRetainingRgb(oldSum);
                  }
                  await sums.publishCommitted(
                    rgbStore: sumMerged.sum,
                    contributionStore: sumMerged.count,
                    committedItems: index + 1,
                    checkpointStage: 'rolling',
                  );
                  rollingSum = sumMerged.sum;
                  rollingCount = sumMerged.count;
                }
                rollingItems = index + 1;
                rollingRecoverableItems = rollingItems;
              } finally {
                if (mergeStore != decoded.store) {
                  await mergeStore.dispose();
                }
                await decoded.store.dispose();
              }
              await reporter.update(
                progress: 0.30 + ((index + 1) / sourcePaths.length) * 0.55,
                stage: '比較明合成 2/2',
                currentItem: index + 1,
                recoverableCheckpointItems: rollingRecoverableItems,
              );
              if (sourcePaths.length >= 8 && index < sourcePaths.length - 1) {
                await waitSafeToStartNextFrame();
              }
            }
          }
          } while (restartInOrder);
          if (fusedStarTrail) {
            rollingItems = sourcePaths.length;
            rollingRecoverableItems = rollingItems;
          }

          if (rollingRgb == null) {
            throw StateError('比較明累積Checkpointが生成されませんでした。');
          }

          await reporter.update(progress: 0.86, stage: '基準写真を再読込');
          await _ensureRollingStarTrailStorageHeadroom(
            width: features[referenceIndex].width,
            height: features[referenceIndex].height,
          );
          final MemoryAdmissionDecision referenceAdmission =
              await memoryAdmission.waitUntilAdmitted(
            requiredAdditionalBytes:
                MemoryAdmissionController.estimateFullFrameAdditionalBytes(
              width: features[referenceIndex].width,
              height: features[referenceIndex].height,
            ),
            checkpointAvailable: true,
          );
          if (referenceAdmission.shouldRecycleProcessor ||
              !referenceAdmission.safeToStart) {
            throw ProcessorMaintenanceRestartRequested(
                referenceAdmission.reason);
          }
          final referenceDecoded = await _decodeStarTrailFrameForRolling(
            index: referenceIndex,
            sourcePath: sourcePaths[referenceIndex],
            decoderRegistry: decoderRegistry,
            metadataProbe: metadataProbe,
            masterDarkStore: masterDarkStore,
            masterFlatStore: masterFlatStore,
            isCancelled: () => reporter.cancellationRequested,
          );
          final DngFinalRenderProfile? renderProfile = referenceDecoded.profile;
          if (renderProfile == null ||
              renderProfile.sourceId != sourcePaths[referenceIndex]) {
            await referenceDecoded.store.dispose();
            throw StateError('基準写真の最終レンダープロファイルを再構築できませんでした。');
          }

          final AutoToneParameters fixedToneBaseline =
              await estimateFixedToneBaselineFromReferenceFrame(
            referenceStore: referenceDecoded.store,
            renderProfile: renderProfile,
          );
          LinearRgbTileStore referenceProcessingStore = referenceDecoded.store;
          if (quality.linearScale < 1) {
            referenceProcessingStore = await downscaleLinearRgbStore(
              source: referenceDecoded.store,
              linearScale: quality.linearScale,
              outputStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
            );
          }
          // Work355: the reference also contributes pixels (foreground
          // protection); read it through the same hot-pixel correction.
          final LinearRgbTileStore referenceReadStore = hotPixelMap.isEmpty
              ? referenceProcessingStore
              : HotPixelCorrectedRgbStore(
                  referenceProcessingStore,
                  hotPixelMap,
                );

          if (rollingFinalized &&
              starTrailGapFillMode != StarTrailGapFillMode.off &&
              !await SyntheticGapMask.isValid(
                  outputPath: outputPath,
                  width: rollingRgb.width,
                  height: rollingRgb.height,
                  identity: postDecodeIdentity)) {
            throw StateError('gap補間maskが未確定または破損しています。保存済み合成を破棄して再処理してください。');
          }
          LinearRgbTileStore finalStore = rollingRgb;
          LinearRgbTileStore? temporaryForeground;
          // Work356: mean of all frames (from the rolling sum) and, when
          // enabled, the mean-background / maximum-trail combination.
          LinearRgbTileStore? meanStore;
          LinearRgbTileStore? meanCombined;
          try {
            final LinearRgbTileStore? sumForMean = rollingSum;
            final LinearContributionTileStore? countForMean = rollingCount;
            if (!rollingFinalized &&
                rollingSumAvailable &&
                sumForMean != null &&
                countForMean != null) {
              await reporter.update(progress: 0.87, stage: '背景の平均化');
              meanStore = await materializeStarTrailMeanStore(
                sum: sumForMean,
                count: countForMean,
                outputStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
                tileSize: effectiveTileSize,
                isCancelled: () => reporter.cancellationRequested,
              );
              if (starTrailMeanBackground) {
                meanCombined = await combineStarTrailMeanAndMax(
                  maxStore: finalStore,
                  meanStore: meanStore,
                  outputStoreFactory:
                      FileBackedLinearRgbTileStore.createTemporary,
                  tileSize: effectiveTileSize,
                  isCancelled: () => reporter.cancellationRequested,
                  log: (String message) {
                    unawaited(DiagnosticLog.log(message));
                  },
                );
              }
            }
            final LinearRgbTileStore combinedInput = meanCombined ?? finalStore;
            final LinearRgbTileStore? averagedForeground =
                starTrailForegroundAverage ? meanStore : null;
            if (!rollingFinalized && automaticStarTrailForegroundProtection) {
              await reporter.update(progress: 0.88, stage: '地上部保護');
              temporaryForeground =
                  await applyStarTrailReferenceForegroundToStore(
                combinedStore: combinedInput,
                referenceStore: averagedForeground ?? referenceReadStore,
                foregroundRegion: foregroundRegion ??
                    (throw StateError('地上光抑制の対象領域を指定して、処理を開始してください。')),
                outputStoreFactory:
                    starTrailGapFillMode == StarTrailGapFillMode.off
                        ? postDecodeCheckpoints!.createRgbStore
                        : FileBackedLinearRgbTileStore.createTemporary,
                tileSize: effectiveTileSize,
                isCancelled: () => reporter.cancellationRequested,
              );
              if (starTrailGapFillMode == StarTrailGapFillMode.off) {
                final LinearContributionTileStore? oldValidity =
                    rollingValidity;
                if (oldValidity != null) {
                  await postDecodeCheckpoints!
                      .closeRetainingContribution(oldValidity);
                }
                await postDecodeCheckpoints!.closeRetainingRgb(finalStore);
                await postDecodeCheckpoints!.publishCommitted(
                  rgbStore: temporaryForeground,
                  committedItems: sourcePaths.length,
                  checkpointStage: 'finalized',
                );
                finalStore = temporaryForeground;
                temporaryForeground = null;
                rollingValidity = null;
                activePostDecodeRgb = finalStore;
                activePostDecodeContribution = null;
                rollingFinalized = true;
                rollingRecoverableItems = sourcePaths.length;
              } else {
                finalStore = temporaryForeground;
              }
            }

            if (!rollingFinalized &&
                starTrailGapFillMode != StarTrailGapFillMode.off) {
              await reporter.update(progress: 0.90, stage: 'シャッター間の隙間を補間');
              final mask = await SyntheticGapMask.create(
                  outputPath: outputPath,
                  width: finalStore.width,
                  height: finalStore.height,
                  identity: postDecodeIdentity);
              LinearRgbTileStore? pendingGapFilled;
              late final LinearRgbTileStore gapFilled;
              try {
                gapFilled = await createGapFilledStarTrailStore(
                  source: finalStore == rollingRgb ? combinedInput : finalStore,
                  outputStoreFactory: postDecodeCheckpoints!.createRgbStore,
                  segments: gapSegments,
                  tileSize: effectiveTileSize,
                  isCancelled: () => reporter.cancellationRequested,
                  onSyntheticMask: mask.writeTile,
                );
                pendingGapFilled = gapFilled;
                await mask.commit();
              } on Object {
                if (pendingGapFilled != null) await pendingGapFilled.dispose();
                rethrow;
              } finally {
                await mask.abort();
              }
              final LinearContributionTileStore? oldValidity = rollingValidity;
              if (oldValidity != null) {
                await postDecodeCheckpoints!
                    .closeRetainingContribution(oldValidity);
              }
              if (finalStore == rollingRgb) {
                await postDecodeCheckpoints!.closeRetainingRgb(rollingRgb);
              }
              activePostDecodeRgb = gapFilled;
              await postDecodeCheckpoints!.publishCommitted(
                rgbStore: gapFilled,
                committedItems: sourcePaths.length,
                checkpointStage: 'finalized',
              );
              finalStore = gapFilled;
              rollingValidity = null;
              activePostDecodeRgb = finalStore;
              activePostDecodeContribution = null;
              rollingFinalized = true;
              rollingRecoverableItems = sourcePaths.length;
            }

            final bool bakesToneAdjustments =
                outputFormat != OutputImageFormat.linearDng;
            await File(outputPath).parent.create(recursive: true);
            await reporter.update(progress: 0.94, stage: '最終画像エンコード');
            await exportTileStoreToImage(
              tileStore: finalStore == rollingRgb ? combinedInput : finalStore,
              outputPath: outputPath,
              format: outputFormat,
              linearDngCompression: storagePreset.dngCompression,
              exposureScale:
                  bakesToneAdjustments ? fixedToneBaseline.exposureScale : null,
              whitePoint:
                  bakesToneAdjustments ? fixedToneBaseline.whitePoint : null,
              renderProfile: renderProfile,
              isCancelled: () => reporter.cancellationRequested,
            );
            await postDecodeCheckpoints!.publishExportReceipt(outputPath);
          } finally {
            try {
              await temporaryForeground?.dispose();
            } on Object {
              // Continue releasing the remaining stores after cleanup failure.
            }
            for (final LinearRgbTileStore? temporary in <LinearRgbTileStore?>[
              meanCombined,
              meanStore,
            ]) {
              try {
                await temporary?.dispose();
              } on Object {
                // Continue releasing the remaining stores.
              }
            }
            if (referenceProcessingStore != referenceDecoded.store) {
              await referenceProcessingStore.dispose();
            }
            await referenceDecoded.store.dispose();
          }

          // Work356: the rolling sum is only a recovery aid for this job.
          await bestEffortCleanup(() async => sumCheckpoints?.cleanupAll());
          cleanupDecodeCheckpointsOnExit = true;
          cleanupCompactFeatureCheckpointsOnExit = true;
          cleanupPostDecodeCheckpointOnExit = true;
          await operationJournal.complete(
            operation: 'standardStackJob',
            stage: 'completedRollingStarTrail',
            committedItems: sourcePaths.length,
          );
          jobHandledSuccessfully = true;
          await reporter.complete();
          return true;
        }

        Future<void> releaseDecodedSourceStores() async {
          final Set<LinearRgbTileStore> released = <LinearRgbTileStore>{};
          for (int i = 0; i < frameStores.length; i++) {
            final LinearRgbTileStore? store = frameStores[i];
            if (store == null || !released.add(store)) continue;
            try {
              // Once the post-decode stack checkpoint is committed, source
              // frames are no longer needed for recovery. Dispose them before
              // final encoding so their buffers/file mappings cannot overlap
              // encoder allocations.
              await store.dispose();
            } on Object catch (error) {
              await DiagnosticLog.log(
                'source-store release failed frame=$i: $error',
              );
            }
          }
          cleanupDecodeCheckpointsOnExit = true;
          await decodeCheckpoints?.cleanupAll();
          await DiagnosticLog.log(
              'decoded source stores released before export');

          final LinearRgbTileStore? combined = activePostDecodeRgb;
          if (combined != null && postDecodeCheckpointAvailable) {
            final MemoryAdmissionDecision exportAdmission =
                await memoryAdmission.waitUntilAdmitted(
              requiredAdditionalBytes:
                  MemoryAdmissionController.estimatePostDecodeAdditionalBytes(
                width: combined.width,
                height: combined.height,
              ),
              checkpointAvailable: true,
              onDecision: (MemoryAdmissionDecision decision) async {
                await DiagnosticLog.logRateLimited(
                  'memory-admission-export',
                  decision.reason,
                );
              },
            );
            if (exportAdmission.shouldRecycleProcessor ||
                !exportAdmission.safeToStart) {
              throw ProcessorMaintenanceRestartRequested(
                exportAdmission.reason,
              );
            }
          }
        }

        late final JobScheduler activeScheduler;
        activeScheduler = JobScheduler(
          executor:
              (ProcessingJob job, void Function(double) reportProgress) async {
            // Checked once per frame, before starting its (potentially
            // multi-second) native decode — a safe point between frames,
            // not an attempt to interrupt one already in flight (Dart
            // cannot preempt a blocking FFI call; see
            // external_stall_watchdog.dart's doc comment). Cancelling the
            // scheduler here stops it from starting any further
            // not-yet-started frames; frames already in flight still run to
            // completion.
            if (reporter.cancellationRequested) {
              activeScheduler.cancelAll();
              return;
            }
            final int index = int.parse(job.id.split('#').last);
            if (referenceOnlyPostDecodeRecovery && index != referenceIndex) {
              // The committed combined checkpoint is authoritative; these
              // source frames are not needed for export recovery.
              reportProgress(1.0);
              return;
            }
            if (frameStores[index] != null) {
              // This frame was fully committed before the previous worker
              // process died. Completing the scheduler job without decoding
              // preserves original frame indexing and progress semantics.
              reportProgress(1.0);
              return;
            }

            // Once dimensions are known, gate the next maximum-quality RAW at
            // a frame boundary using an estimate of the *next* operation's
            // transient memory demand rather than current free RAM alone.
            LinearRgbTileStore? dimensionSource;
            for (final LinearRgbTileStore? candidate in frameStores) {
              if (candidate != null) {
                dimensionSource = candidate;
                break;
              }
            }
            if (dimensionSource != null) {
              if (mode == ProcessingMode.starTrail) {
                await _ensureStarTrailDecodeStorageHeadroom(
                  dimensionSource: dimensionSource,
                  totalFrames: sourcePaths.length,
                  committedFrames: committedCheckpointIndices.length,
                );
              }
              final int required =
                  MemoryAdmissionController.estimateFullFrameAdditionalBytes(
                width: dimensionSource.width,
                height: dimensionSource.height,
              );
              final MemoryAdmissionDecision admission =
                  await memoryAdmission.waitUntilAdmitted(
                requiredAdditionalBytes: required,
                checkpointAvailable: (mode == ProcessingMode.starTrail ||
                        milkyDecodedCache != null) &&
                    committedCheckpointIndices.isNotEmpty,
                onDecision: (MemoryAdmissionDecision decision) async {
                  await DiagnosticLog.logRateLimited(
                    'memory-admission-raw',
                    decision.reason,
                  );
                },
              );
              if (admission.shouldRecycleProcessor) {
                throw ProcessorMaintenanceRestartRequested(admission.reason);
              }
              if (!admission.safeToStart) {
                // No durable per-frame Milky Way checkpoint exists at this
                // stage. Do not lower image quality; fail explicitly rather
                // than knowingly entering a likely OOM condition.
                throw StateError(
                  '次のRAW処理に必要なメモリ余裕を確保できませんでした。'
                  ' ${admission.reason}',
                );
              }
            }
            await operationJournal.enter(
              operation: 'rawDecode',
              stage: 'RAW解析・較正',
              frameIndex: index,
              committedItems: committedCheckpointIndices.length,
            );
            await runPhase2ValidatedJob(
              job,
              reportProgress,
              metadataProbe: metadataProbe,
              decoderRegistry: decoderRegistry,
              masterDarkStore: masterDarkStore,
              masterFlatStore: masterFlatStore,
              fileBackRawBeforeDemosaic: true,
              preferStreamedRawCalibration: true,
              rgbTileStoreFactory: milkyDecodedCache != null
                  ? (
                          {required int width,
                          required int height,
                          required OverlappedTilePlan plan}) =>
                      milkyDecodedCache!.create(
                          index: index,
                          width: width,
                          height: height,
                          plan: plan)
                  : decodeCheckpoints == null
                      ? null
                      : ({
                          required int width,
                          required int height,
                          required OverlappedTilePlan plan,
                        }) =>
                          decodeCheckpoints.createStore(
                            index: index,
                            width: width,
                            height: height,
                            plan: plan,
                          ),
              onRenderMetadataReady: (metadata, cfaPattern) {
                decodedMetadata[index] = metadata;
                decodedCfaPatterns[index] = cfaPattern;
                renderProfiles[index] = DngFinalRenderProfile.fromMetadata(
                  sourceId: job.sourcePath,
                  metadata: metadata,
                  cfaPattern: cfaPattern,
                );
              },
              onTileStoreReady: (LinearRgbTileStore store) async {
                frameStores[index] = store;
                if (milkyDecodedCache != null) {
                  // WORK350: the ~17 s per frame between `stage=demosaic` and
                  // the next frame was unattributed in logs; this receipt
                  // write includes a full-file SHA-256 of the FP32 store.
                  final Stopwatch publishWatch = Stopwatch()..start();
                  await milkyDecodedCache!.publish(
                      index, store, saturationMasks[index],
                      metadata: decodedMetadata[index]!,
                      cfaPattern: decodedCfaPatterns[index]!);
                  await DiagnosticLog.log(
                    'milkyDecodedCache publish frame=$index '
                    'elapsedMs=${publishWatch.elapsedMilliseconds}',
                  );
                  committedCheckpointIndices.add(index);
                } else if (decodeCheckpoints != null) {
                  await decodeCheckpoints.publishCommittedFrame(index, store);
                  committedCheckpointIndices.add(index);
                }
              },
              onSaturationMaskReady: (RawSaturationMask? mask) {
                saturationMasks[index] = mask;
              },
              onRawExecutionPathReady: (String path) => DiagnosticLog.log(
                'rawPath frame=$index path=$path',
              ),
            );
            await operationJournal.complete(
              operation: 'rawDecode',
              stage: 'RAW解析・較正',
              frameIndex: index,
              committedItems: committedCheckpointIndices.length,
            );
            // Work312: replace the fixed 2/4 second cooldown with adaptive,
            // frame-boundary resource control. Healthy devices immediately
            // start the next frame; constrained devices back off, and critical
            // memory/thermal pressure temporarily gates the next frame until
            // headroom recovers. Pixel math and output quality are untouched.
            if (sourcePaths.length >= 8 &&
                index < sourcePaths.length - 1 &&
                !reporter.cancellationRequested) {
              await waitSafeToStartNextFrame(
                onDecision: (AdaptiveResourceDecision decision) async {
                  await DiagnosticLog.logRateLimited(
                    'adaptive-resource-control',
                    'adaptiveResource ${decision.reason}',
                  );
                },
              );
            }
          },
          resourceReader: readDefaultResourceSnapshot,
          policy: fullFrameRawConcurrencyPolicy,
          jobTimeout: fullFrameRawStallTimeout,
        );

        final List<ProcessingJob> jobs = <ProcessingJob>[
          for (int index = 0; index < sourcePaths.length; index++)
            ProcessingJob(
              id: 'background-frame#$index',
              mode: mode,
              sourcePath: sourcePaths[index],
            ),
        ];
        scheduler = activeScheduler;
        final StreamSubscription<JobSchedulerSnapshot> subscription =
            activeScheduler.snapshots.listen((JobSchedulerSnapshot snapshot) {
          final int visibleCompleted =
              snapshot.completedCount < restoredFrameCount
                  ? restoredFrameCount
                  : snapshot.completedCount;
          final double phaseProgress = snapshot.overallProgress * 0.55;
          final double restoredProgress = sourcePaths.isEmpty
              ? 0
              : (restoredFrameCount / sourcePaths.length) * 0.55;
          reporter.updateBestEffort(
            progress: phaseProgress < restoredProgress
                ? restoredProgress
                : phaseProgress,
            stage: 'RAW解析・較正',
            currentItem: visibleCompleted,
          );
          unawaited(DiagnosticLog.logRateLimited(
            'rawDecode-progress',
            'rawDecode ${snapshot.completedCount}/${sourcePaths.length}',
          ));
        });
        activeScheduler.enqueueAll(jobs);
        await activeScheduler.waitUntilIdle();
        await subscription.cancel();
        await DiagnosticLog.log('rawDecode stage complete');

        if (reporter.cancellationRequested) {
          throw const StackJobCancelledException();
        }

        for (int index = 0; index < jobs.length; index++) {
          final ProcessingJob job = jobs[index];
          if (job.state != ProcessingJobState.completed) {
            throw StateError(
              'RAW処理に失敗しました: ${sourcePaths[index]} / ${job.error ?? job.state.name}',
            );
          }
          if ((!referenceOnlyPostDecodeRecovery || index == referenceIndex) &&
              frameStores[index] == null) {
            throw StateError(
              'RAW処理結果がありません: ${sourcePaths[index]}',
            );
          }
        }

        final DngFinalRenderProfile renderProfile;
        if ((mode == ProcessingMode.starTrail && decodeCheckpoints != null) ||
            referenceOnlyPostDecodeRecovery) {
          final DngFinalRenderProfile? referenceProfile =
              renderProfiles[referenceIndex];
          if (referenceProfile == null ||
              referenceProfile.sourceId != sourcePaths[referenceIndex]) {
            throw StateError(
              'Missing or mismatched final-render profile for star-trail '
              'reference frame $referenceIndex.',
            );
          }
          renderProfile = referenceProfile;
        } else {
          renderProfile = requireAlignedReferenceRenderProfile(
            profiles: renderProfiles,
            sourcePaths: sourcePaths,
            referenceIndex: referenceIndex,
          );
        }

        // Computed once, from the reference frame only, and reused for every
        // export below — see estimateFixedToneBaselineFromReferenceFrame's
        // doc comment. Without this, the stack's own auto-tone pass (run
        // separately, on the combined result's different pixel statistics)
        // can land on a visibly different exposure/white point than a
        // single-frame render of the same shoot, even though nothing about
        // the actual subject changed.
        final AutoToneParameters fixedToneBaseline =
            await estimateFixedToneBaselineFromReferenceFrame(
          referenceStore: frameStores[referenceIndex]!,
          renderProfile: renderProfile,
        );
        await DiagnosticLog.log(
          'fixed tone baseline: exposureScale=${fixedToneBaseline.exposureScale} '
          'whitePoint=${fixedToneBaseline.whitePoint}',
        );

        // Linear DNG export deliberately refuses to bake exposure/white-point
        // adjustments into the file (see
        // _exportLinearDngWithoutRenderedAdjustments in export_result.dart) —
        // it must stay a linear, unadjusted render so downstream raw editors
        // can apply their own tone mapping. Passing the computed fixed-tone
        // baseline through in that case throws an ArgumentError and fails the
        // whole job, so only forward it for formats that actually render/bake
        // those adjustments.
        final bool bakesToneAdjustments =
            outputFormat != OutputImageFormat.linearDng;
        final double? exposureScaleForExport =
            bakesToneAdjustments ? fixedToneBaseline.exposureScale : null;
        final double? whitePointForExport =
            bakesToneAdjustments ? fixedToneBaseline.whitePoint : null;

        if (quality.linearScale < 1 && !referenceOnlyPostDecodeRecovery) {
          await reporter.update(progress: 0.56, stage: '選択画質への事前縮小');
          await DiagnosticLog.log('downscale stage start');
          for (int index = 0; index < frameStores.length; index++) {
            final LinearRgbTileStore source = frameStores[index]!;
            final LinearRgbTileStore scaled = await downscaleLinearRgbStore(
              source: source,
              linearScale: quality.linearScale,
              outputStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
            );
            frameStores[index] = scaled;
            saturationMasks[index] = null;
            if (milkyDecodedCache != null) {
              await milkyDecodedCache!.release(source, discard: false);
            } else if (decodeCheckpoints != null) {
              await decodeCheckpoints.closeRetainingCheckpoint(source);
            } else {
              await source.dispose();
            }
          }
          await DiagnosticLog.log('downscale stage complete');
        }

        await File(outputPath).parent.create(recursive: true);
        if (restoredPostDecode == null) {
          await _ensurePostDecodeStorageHeadroom(
            referenceStore: frameStores[referenceIndex]!,
            mode: mode,
          );
          final LinearRgbTileStore referenceStore =
              frameStores[referenceIndex]!;
          final MemoryAdmissionDecision postDecodeAdmission =
              await memoryAdmission.waitUntilAdmitted(
            requiredAdditionalBytes:
                MemoryAdmissionController.estimatePostDecodeAdditionalBytes(
              width: referenceStore.width,
              height: referenceStore.height,
            ),
            checkpointAvailable: (mode == ProcessingMode.starTrail ||
                    milkyDecodedCache != null) &&
                committedCheckpointIndices.isNotEmpty,
            onDecision: (MemoryAdmissionDecision decision) async {
              await DiagnosticLog.logRateLimited(
                'memory-admission-postdecode',
                decision.reason,
              );
            },
          );
          if (postDecodeAdmission.shouldRecycleProcessor) {
            throw ProcessorMaintenanceRestartRequested(
              postDecodeAdmission.reason,
            );
          }
          if (!postDecodeAdmission.safeToStart) {
            throw StateError(
              'スタック開始に必要なメモリ余裕を確保できませんでした。'
              ' ${postDecodeAdmission.reason}',
            );
          }
        }
        if (mode == ProcessingMode.starTrail) {
          await reporter.update(progress: 0.58, stage: '比較明合成');
          await DiagnosticLog.log('starTrail combine start');
          await operationJournal.enter(
            operation: 'starTrailCombineAndExport',
            stage: '比較明合成',
            committedItems: committedCheckpointIndices.length,
          );
          await combineDecodedFramesAndExport(
            frameStores: frameStores.cast<LinearRgbTileStore>(),
            outputTileStoreFactory: postDecodeCheckpoints!.createRgbStore,
            exportPath: outputPath,
            sourcePaths: sourcePaths,
            enableAircraftSatelliteRemoval: automaticStarTrailAircraftRemoval,
            referenceForegroundStore: frameStores[referenceIndex]!,
            preserveReferenceForeground: automaticStarTrailForegroundProtection,
            foregroundRegion: foregroundRegion,
            gapFillMode: starTrailGapFillMode,
            fadeSettings: starTrailFadeSettings,
            exposureScale: exposureScaleForExport,
            whitePoint: whitePointForExport,
            outputFormat: outputFormat,
            linearDngCompression: storagePreset.dngCompression,
            tileSize: effectiveTileSize,
            renderProfile: renderProfile,
            reportProgress: (double progress) {
              reporter.updateBestEffort(progress: 0.58 + progress * 0.41);
            },
            reportStage: (stage, substage) {
              reporter.updateBestEffort(stage: substage ?? stage.label);
            },
            isCancelled: () => reporter.cancellationRequested,
            resumeCombinedStore: restoredPostDecode?.rgbStore,
            onCombinedCommitted: (LinearRgbTileStore store) async {
              activePostDecodeRgb = store;
              await postDecodeCheckpoints!.publishCommitted(rgbStore: store);
              postDecodeCheckpointAvailable = true;
              await operationJournal.complete(
                operation: 'postDecodeStackCheckpoint',
                stage: '比較明合成確定',
                committedItems: committedCheckpointIndices.length,
              );
            },
            onSourceStoresNoLongerNeeded: releaseDecodedSourceStores,
            retainCombinedStoreOnExit: true,
          );
          await postDecodeCheckpoints!.publishExportReceipt(outputPath);
          await operationJournal.complete(
            operation: 'finalExportCheckpoint',
            stage: '最終画像確定',
            committedItems: sourcePaths.length,
          );
          await operationJournal.complete(
            operation: 'starTrailCombineAndExport',
            stage: '比較明合成',
            committedItems: committedCheckpointIndices.length,
          );
        } else {
          await reporter.update(progress: 0.58, stage: '位置合わせ・スタック');
          await DiagnosticLog.log('registerAndCombine start');
          await operationJournal.enter(
            operation: 'registerCombineAndExport',
            stage: '位置合わせ・スタック',
            committedItems: committedCheckpointIndices.length,
          );
          await registerAndCombineDecodedFramesAndExport(
            stageCheckpoint: milkyTileCheckpoint,
            sourcePaths: sourcePaths,
            frameStores: frameStores,
            saturationInfluenceMasks: saturationMasks,
            decodeFailures: const <int, Object?>{},
            outputTileStoreFactory: postDecodeCheckpoints!.createRgbStore,
            contributionTileStoreFactory:
                postDecodeCheckpoints!.createContributionStore,
            exportPath: outputPath,
            outputFormat: outputFormat,
            linearDngCompression: storagePreset.dngCompression,
            maximumIterations: quality.maximumIterations,
            tileSize: effectiveTileSize,
            enableLocalRegistration: quality.enableLocalRegistration,
            interpolation: quality.interpolation,
            preserveStaticForeground: quality.preserveStaticForeground,
            enableMovingObjectRemoval: automaticMovingObjectRemoval,
            renderProfile: renderProfile,
            referenceIndex: referenceIndex,
            registrationModel: milkyWayRegistrationModel,
            // Work361: parallel combine (identical output; see
            // classicCombineWorkerCount for the core-count rule).
            combineWorkerIsolates: classicCombineWorkerCount(),
            exposureScale: exposureScaleForExport,
            whitePoint: whitePointForExport,
            reportProgress: (double progress) {
              reporter.updateBestEffort(progress: 0.58 + progress * 0.41);
            },
            reportStage: (stage, substage) {
              reporter.updateBestEffort(stage: substage ?? stage.label);
            },
            isCancelled: () => reporter.cancellationRequested,
            resumeCombinedStore: restoredPostDecode?.rgbStore,
            resumeContributionStore: restoredPostDecode?.contributionStore,
            onFrameDiagnostics: (diagnostics) async {
              for (final MilkyWayFrameDiagnostics diagnostic in diagnostics) {
                await DiagnosticLog.log(
                  'Milky Way registration diagnostics (classic): '
                  'source=${diagnostic.sourcePath} '
                  'included=${diagnostic.included} '
                  'excludedReason=${diagnostic.excludedReason} '
                  'detectedStars=${diagnostic.detectedStarCount} '
                  'matchedStars=${diagnostic.matchedStarCount} '
                  'rotationDeg=${diagnostic.rotationDegrees} '
                  'offsetX=${diagnostic.sourceOffsetX} '
                  'offsetY=${diagnostic.sourceOffsetY} '
                  'rmsResidualPx=${diagnostic.rmsResidual} '
                  'globalRmsResidualPx=${diagnostic.globalRmsResidual} '
                  'residualP95Px=${diagnostic.residualP95} '
                  'residualMaxPx=${diagnostic.residualMax} '
                  'residualDirectionalCoherence='
                  '${diagnostic.residualDirectionalCoherence} '
                  'localCorrectionApplied=${diagnostic.localCorrectionApplied} '
                  'weight=${diagnostic.registrationWeight}',
                );
              }
            },
            onCombinedCommitted: (
              LinearRgbTileStore store,
              LinearContributionTileStore? contributionStore,
            ) async {
              activePostDecodeRgb = store;
              activePostDecodeContribution = contributionStore;
              await postDecodeCheckpoints!.publishCommitted(
                rgbStore: store,
                contributionStore: contributionStore,
              );
              if (contributionStore != null) {
                await _logContributionStatistics(
                  contributionStore,
                  label: 'milkyWayClassic',
                );
              }
              postDecodeCheckpointAvailable = true;
              await operationJournal.complete(
                operation: 'postDecodeStackCheckpoint',
                stage: '位置合わせ・スタック確定',
                committedItems: committedCheckpointIndices.length,
              );
            },
            onSourceStoresNoLongerNeeded: releaseDecodedSourceStores,
            retainCombinedStoreOnExit: true,
          );
          await postDecodeCheckpoints!.publishExportReceipt(outputPath);
          await operationJournal.complete(
            operation: 'finalExportCheckpoint',
            stage: '最終画像確定',
            committedItems: sourcePaths.length,
          );
          await operationJournal.complete(
            operation: 'registerCombineAndExport',
            stage: '位置合わせ・スタック',
            committedItems: committedCheckpointIndices.length,
          );
        }
        await DiagnosticLog.log('task complete');
        cleanupDecodeCheckpointsOnExit = true;
        cleanupPostDecodeCheckpointOnExit = true;
        await operationJournal.complete(
          operation: 'standardStackJob',
          stage: 'completed',
          committedItems: committedCheckpointIndices.length,
        );
        jobHandledSuccessfully = true;
        await reporter.complete();
        return true;
      } on ProcessorMaintenanceRestartRequested catch (request) {
        await DiagnosticLog.log(
          'quality-neutral processor recycle at durable checkpoint: '
          '${request.reason}',
        );
        await operationJournal.enter(
          operation: 'processorMaintenanceRecycle',
          stage: 'memoryPressure',
          committedItems: useRollingPipeline
              ? rollingRecoverableItems
              : (postDecodeCheckpointAvailable
                  ? sourcePaths.length
                  : committedCheckpointIndices.length),
        );
        await reporter.requestProcessorMaintenanceRestart(
          request.reason,
          checkpointItems: useRollingPipeline
              ? rollingRecoverableItems
              : (postDecodeCheckpointAvailable
                  ? sourcePaths.length
                  : committedCheckpointIndices.length),
        );
        return true;
      } on StackJobCancelledException {
        await DiagnosticLog.log('task cancelled by user');
        cleanupDecodeCheckpointsOnExit = true;
        cleanupCompactFeatureCheckpointsOnExit = true;
        cleanupMilkyWayCompactFeaturesOnExit = true;
        cleanupRollingWeightedAverageOnExit = true;
        cleanupPostDecodeCheckpointOnExit = true;
        await operationJournal.enter(
          operation: 'standardStackJob',
          stage: 'cancelled',
          committedItems: committedCheckpointIndices.length,
        );
        await reporter.cancel();
        return true;
      } on ExportCancelled {
        await DiagnosticLog.log('task cancelled by user (during export)');
        cleanupDecodeCheckpointsOnExit = true;
        cleanupCompactFeatureCheckpointsOnExit = true;
        cleanupMilkyWayCompactFeaturesOnExit = true;
        cleanupRollingWeightedAverageOnExit = true;
        cleanupPostDecodeCheckpointOnExit = true;
        await operationJournal.enter(
          operation: 'standardStackJob',
          stage: 'cancelledDuringExport',
          committedItems: committedCheckpointIndices.length,
        );
        await reporter.cancel();
        return true;
      } on _StorageCapacityException catch (error) {
        await DiagnosticLog.log('task paused for storage headroom: $error');
        await operationJournal.enter(
          operation: 'storageCapacityPause',
          stage: '空き容量不足・再開待ち',
          committedItems: committedCheckpointIndices.length,
        );
        await reporter.pauseRecoverable(
          error,
          checkpointItems: useRollingPipeline
              ? rollingRecoverableItems
              : (postDecodeCheckpointAvailable
                  ? sourcePaths.length
                  : committedCheckpointIndices.length),
          stage: '空き容量不足・再開待ち',
        );
        return true;
      } on Object catch (error) {
        if (error is RollingWeightedAverageCancelled ||
            error is TiledStackingCancelled) {
          await DiagnosticLog.log('task cancelled by user (during stacking)');
          cleanupDecodeCheckpointsOnExit = true;
          cleanupCompactFeatureCheckpointsOnExit = true;
          cleanupMilkyWayCompactFeaturesOnExit = true;
          cleanupRollingWeightedAverageOnExit = true;
          cleanupPostDecodeCheckpointOnExit = true;
          await operationJournal.enter(
            operation: 'standardStackJob',
            stage: 'cancelledDuringStacking',
            committedItems: committedCheckpointIndices.length,
          );
          await reporter.cancel();
          return true;
        }
        if (_isNoSpaceError(error)) {
          final snapshot = await readDefaultResourceSnapshot();
          final storageError = _StorageCapacityException(
            message:
                '端末の空き容量が不足したため、RAW処理を安全に中断しました。書き込み途中の一時ファイルは再開時に破棄され、確定済みCheckpointは保持されます。',
            availableBytes: snapshot.availableStorageBytes,
          );
          await DiagnosticLog.log(
              'task hit ENOSPC; paused recoverably: $error');
          await operationJournal.enter(
            operation: 'storageCapacityPause',
            stage: '空き容量不足・再開待ち',
            committedItems: committedCheckpointIndices.length,
          );
          await reporter.pauseRecoverable(
            storageError,
            checkpointItems: useRollingPipeline
                ? rollingRecoverableItems
                : (postDecodeCheckpointAvailable
                    ? sourcePaths.length
                    : committedCheckpointIndices.length),
            stage: '空き容量不足・再開待ち',
          );
          return true;
        }
        await DiagnosticLog.log('task FAILED (checkpoint retained): $error');
        await operationJournal.enter(
          operation: 'recoverableFailure',
          stage: 'error',
          committedItems: committedCheckpointIndices.length,
        );
        if (((decodeCheckpoints != null || milkyDecodedCache != null) &&
                committedCheckpointIndices.isNotEmpty) ||
            rollingRecoverableItems > 0 ||
            postDecodeCheckpointAvailable) {
          await reporter.failRecoverable(
            error,
            checkpointItems: useRollingPipeline
                ? rollingRecoverableItems
                : (postDecodeCheckpointAvailable
                    ? sourcePaths.length
                    : committedCheckpointIndices.length),
          );
        } else {
          await reporter.fail(error);
        }
        return true;
      } finally {
        try {
          if (jobHandledSuccessfully) {
            await attemptHistoryStore.recordCleanAttempt();
          }
        } on Object {
          // Best-effort: worst case, the next attempt's tile-size ladder
          // simply doesn't reset this time.
        }
        await bestEffortCleanup(() async => scheduler?.dispose());
        await bestEffortCleanup(() async => masterFlatStore?.dispose());
        await bestEffortCleanup(() async => masterDarkStore?.dispose());
        await bestEffortCleanup(disposeStores);
        if (cleanupDecodeCheckpointsOnExit) {
          await bestEffortCleanup(
            () async => decodeCheckpoints?.cleanupAll(),
          );
        } else if (decodeCheckpoints != null) {
          await bestEffortCleanup(
            () => DiagnosticLog.log(
              'starTrail checkpoints retained for recovery: '
              '${committedCheckpointIndices.length}/${sourcePaths.length}',
            ),
          );
        }
        await bestEffortCleanup(() async {
          final LinearContributionTileStore? contribution =
              activePostDecodeContribution;
          if (contribution != null) {
            await postDecodeCheckpoints
                ?.closeRetainingContribution(contribution);
          }
        });
        await bestEffortCleanup(() async {
          final LinearRgbTileStore? rgb = activePostDecodeRgb;
          if (rgb != null) {
            await postDecodeCheckpoints?.closeRetainingRgb(rgb);
          }
        });
        await bestEffortCleanup(() async {
          final Float64RgbTileStore? weightedSum = activeRollingWeightedSum;
          if (weightedSum != null) {
            await rollingWeightedAverageCheckpoints
                ?.closeRetainingStore(weightedSum);
          }
        });
        await bestEffortCleanup(() async {
          final Float64RgbTileStore? weightSum = activeRollingWeightSum;
          if (weightSum != null) {
            await rollingWeightedAverageCheckpoints
                ?.closeRetainingStore(weightSum);
          }
        });
        if (cleanupDecodeCheckpointsOnExit && milkyDecodedCache != null) {
          await bestEffortCleanup(() async {
            final directory = milkyDecodedCache!.cache.directory;
            if (await directory.exists()) {
              await directory.delete(recursive: true);
            }
            await milkyTileCheckpoint?.clear();
          });
        }
        if (cleanupCompactFeatureCheckpointsOnExit) {
          await bestEffortCleanup(
            () async => compactFeatureCheckpoints?.cleanupAll(),
          );
          await bestEffortCleanup(() async => hotCandidateStore.cleanupAll());
        } else if (useRollingStarTrail &&
            committedCheckpointIndices.isNotEmpty) {
          await bestEffortCleanup(
            () => DiagnosticLog.log(
              'compact star-trail analysis retained for recovery: '
              '${committedCheckpointIndices.length}/${sourcePaths.length}',
            ),
          );
        }
        if (cleanupMilkyWayCompactFeaturesOnExit) {
          await bestEffortCleanup(
            () async => milkyWayCompactFeatureCheckpoints?.cleanupAll(),
          );
        } else if (useRollingMilkyWay &&
            committedCheckpointIndices.isNotEmpty) {
          await bestEffortCleanup(
            () => DiagnosticLog.log(
              'compact Milky Way registration retained for recovery: '
              '${committedCheckpointIndices.length}/${sourcePaths.length}',
            ),
          );
        }
        if (cleanupRollingWeightedAverageOnExit) {
          await bestEffortCleanup(
            () async => rollingWeightedAverageCheckpoints?.cleanupAll(),
          );
        } else if (useRollingMilkyWay && rollingRecoverableItems > 0) {
          await bestEffortCleanup(
            () => DiagnosticLog.log(
              'FP64 Milky Way accumulator retained for recovery: '
              '$rollingRecoverableItems item(s)',
            ),
          );
        }
        if (cleanupPostDecodeCheckpointOnExit) {
          await bestEffortCleanup(
            () async => postDecodeCheckpoints?.cleanupAll(),
          );
        } else if (postDecodeCheckpointAvailable) {
          await bestEffortCleanup(
            () => DiagnosticLog.log(
              'post-decode stack checkpoint retained for export/recovery',
            ),
          );
        }
        await bestEffortCleanup(reporter.dispose);
      }
    },
  );
}
