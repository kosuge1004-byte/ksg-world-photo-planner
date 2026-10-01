import 'dart:convert';
import 'dart:io';

import '../image/file_backed_float64_rgb_tile_store.dart';
import '../image/float64_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';

/// Two-generation durable checkpoint for the exact FP64 Milky Way rolling
/// weighted-average accumulator.
final class RollingWeightedAverageCheckpointStore {
  RollingWeightedAverageCheckpointStore({
    required String statusPath,
    required this.identity,
  }) : _directory = Directory(
          '${File(statusPath).parent.path}${Platform.pathSeparator}'
          'rolling_weighted_average_checkpoints_v1',
        );

  static const int _version = 1;
  final Directory _directory;
  final String identity;
  String? _generation;

  String get _currentManifestPath =>
      '${_directory.path}${Platform.pathSeparator}current.json';
  String get _previousManifestPath =>
      '${_directory.path}${Platform.pathSeparator}previous.json';

  Future<Float64RgbTileStore> createWeightedSumStore({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) =>
      _createStore(
        suffix: 'weighted_sum.f64',
        width: width,
        height: height,
        plan: plan,
      );

  Future<Float64RgbTileStore> createWeightSumStore({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) =>
      _createStore(
        suffix: 'weight_sum.f64',
        width: width,
        height: height,
        plan: plan,
      );

  Future<Float64RgbTileStore> _createStore({
    required String suffix,
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    await _directory.create(recursive: true);
    _generation ??=
        '${DateTime.now().microsecondsSinceEpoch}-${pid.toString()}';
    final String path = '${_directory.path}${Platform.pathSeparator}'
        '${_generation!}.$suffix';
    final File stale = File(path);
    if (await stale.exists()) await stale.delete();
    return FileBackedFloat64RgbTileStore.create(
      path: path,
      width: width,
      height: height,
      plan: plan,
    );
  }

  Future<void> publishCommitted({
    required Float64RgbTileStore weightedSum,
    required Float64RgbTileStore weightSum,
    required int committedItems,
  }) async {
    if (weightedSum is! FileBackedFloat64RgbTileStore ||
        weightSum is! FileBackedFloat64RgbTileStore ||
        !weightedSum.isCommitted ||
        !weightSum.isCommitted) {
      throw StateError('Rolling FP64 accumulator is not committed.');
    }
    if (weightedSum.width != weightSum.width ||
        weightedSum.height != weightSum.height) {
      throw StateError('Rolling FP64 accumulator dimensions do not match.');
    }
    final Map<String, dynamic> manifest = <String, dynamic>{
      'version': _version,
      'identity': identity,
      'generation':
          _generation ?? 'adopted-${DateTime.now().microsecondsSinceEpoch}',
      'createdEpochMs': DateTime.now().millisecondsSinceEpoch,
      'width': weightedSum.width,
      'height': weightedSum.height,
      'weightedSumPath': weightedSum.path,
      'weightedSumBytes': weightedSum.persistentByteLength,
      'weightSumPath': weightSum.path,
      'weightSumBytes': weightSum.persistentByteLength,
      'committedItems': committedItems,
    };
    final Map<String, dynamic>? oldCurrent =
        await _readManifest(File(_currentManifestPath));
    final Map<String, dynamic>? oldPrevious =
        await _readManifest(File(_previousManifestPath));
    if (oldCurrent != null) {
      await _writeJsonAtomically(File(_previousManifestPath), oldCurrent);
    }
    await _writeJsonAtomically(File(_currentManifestPath), manifest);
    if (oldPrevious != null) {
      await _deleteGenerationFilesExcept(
        oldPrevious,
        <String>{
          ..._generationPaths(oldCurrent),
          ..._generationPaths(manifest),
        },
      );
    }
    await _removeUnreferencedGenerationFiles();
    _generation = null;
  }

  Future<RollingWeightedAverageCheckpoint?> restore() async {
    await _directory.create(recursive: true);
    for (final String manifestPath in <String>[
      _currentManifestPath,
      _previousManifestPath,
    ]) {
      final Map<String, dynamic>? manifest =
          await _readManifest(File(manifestPath));
      if (manifest == null ||
          manifest['version'] != _version ||
          manifest['identity'] != identity) {
        continue;
      }
      final int? width = (manifest['width'] as num?)?.toInt();
      final int? height = (manifest['height'] as num?)?.toInt();
      final int? committedItems = (manifest['committedItems'] as num?)?.toInt();
      final String? weightedSumPath = manifest['weightedSumPath'] as String?;
      final String? weightSumPath = manifest['weightSumPath'] as String?;
      if (width == null ||
          height == null ||
          width <= 0 ||
          height <= 0 ||
          committedItems == null ||
          committedItems < 0 ||
          weightedSumPath == null ||
          weightSumPath == null) {
        continue;
      }
      FileBackedFloat64RgbTileStore? weightedSum;
      FileBackedFloat64RgbTileStore? weightSum;
      try {
        weightedSum = await FileBackedFloat64RgbTileStore.openCommitted(
          path: weightedSumPath,
          width: width,
          height: height,
        );
        weightSum = await FileBackedFloat64RgbTileStore.openCommitted(
          path: weightSumPath,
          width: width,
          height: height,
        );
        return RollingWeightedAverageCheckpoint(
          weightedSum: weightedSum,
          weightSum: weightSum,
          committedItems: committedItems,
          generation: manifest['generation']?.toString() ?? 'unknown',
        );
      } on Object {
        try {
          await weightedSum?.closeRetainingFile();
        } on Object {
          // Try the previous immutable generation.
        }
        try {
          await weightSum?.closeRetainingFile();
        } on Object {
          // Try the previous immutable generation.
        }
      }
    }
    await _removeUnreferencedGenerationFiles();
    return null;
  }

  Future<void> closeRetainingStore(Float64RgbTileStore store) async {
    if (store is FileBackedFloat64RgbTileStore) {
      await store.closeRetainingFile();
    } else {
      await store.dispose();
    }
  }

  Future<void> cleanupAll() async {
    if (await _directory.exists()) await _directory.delete(recursive: true);
  }

  Future<Map<String, dynamic>?> _readManifest(File file) async {
    try {
      if (!await file.exists()) return null;
      final Object? decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map) return null;
      return decoded.cast<String, dynamic>();
    } on Object {
      return null;
    }
  }

  Future<void> _writeJsonAtomically(
    File destination,
    Map<String, dynamic> value,
  ) async {
    await destination.parent.create(recursive: true);
    final File temp = File(
      '${destination.path}.tmp.$pid.${DateTime.now().microsecondsSinceEpoch}',
    );
    await temp.writeAsString(jsonEncode(value), flush: true);
    try {
      await temp.rename(destination.path);
    } on FileSystemException {
      if (await destination.exists()) await destination.delete();
      await temp.rename(destination.path);
    }
  }

  Set<String> _generationPaths(Map<String, dynamic>? manifest) {
    if (manifest == null) return const <String>{};
    return <String>{
      for (final String key in <String>['weightedSumPath', 'weightSumPath'])
        if ((manifest[key] as String?) case final String path
            when path.isNotEmpty)
          path,
    };
  }

  Future<void> _deleteGenerationFilesExcept(
    Map<String, dynamic> manifest,
    Set<String> keep,
  ) async {
    for (final String path in _generationPaths(manifest)) {
      if (keep.contains(path)) continue;
      final File file = File(path);
      try {
        if (await file.exists()) await file.delete();
      } on Object {
        // Best effort; orphan cleanup retries on a later launch.
      }
    }
  }

  Future<void> _removeUnreferencedGenerationFiles() async {
    if (!await _directory.exists()) return;
    final Set<String> referenced = <String>{};
    for (final String path in <String>[
      _currentManifestPath,
      _previousManifestPath,
    ]) {
      referenced.addAll(
        _generationPaths(await _readManifest(File(path))),
      );
    }
    await for (final FileSystemEntity entity in _directory.list()) {
      if (entity is! File) continue;
      final String name = entity.path.split(Platform.pathSeparator).last;
      if (name == 'current.json' || name == 'previous.json') continue;
      if (name.contains('.tmp.') ||
          ((name.endsWith('.weighted_sum.f64') ||
                  name.endsWith('.weight_sum.f64')) &&
              !referenced.contains(entity.path))) {
        try {
          await entity.delete();
        } on Object {
          // Best effort.
        }
      }
    }
  }
}

final class RollingWeightedAverageCheckpoint {
  const RollingWeightedAverageCheckpoint({
    required this.weightedSum,
    required this.weightSum,
    required this.committedItems,
    required this.generation,
  });

  final FileBackedFloat64RgbTileStore weightedSum;
  final FileBackedFloat64RgbTileStore weightSum;
  final int committedItems;
  final String generation;
}
