import 'durable_decoded_frame_cache.dart';
import 'dart:convert';
import 'dart:io';

import '../image/file_backed_linear_contribution_tile_store.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/linear_contribution_tile_store.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';

/// Durable checkpoint for the expensive post-decode stack result.
///
/// Publication is transactional: the large files are committed first and the
/// small manifest is atomically replaced last. `current` and `previous` point
/// at two independent immutable generations, so a process death while a new
/// generation is being written cannot destroy the last known-good one.
final class PostDecodePipelineCheckpointStore {
  PostDecodePipelineCheckpointStore({
    required String statusPath,
    required this.identity,
    // Work356: a second, independent checkpoint (the star-trail rolling
    // sum) lives in its own directory. Default unchanged.
    String directoryName = 'post_decode_pipeline_checkpoints_v1',
  }) : _directory = Directory(
          '${File(statusPath).parent.path}${Platform.pathSeparator}'
          '$directoryName',
        );

  static const int _version = 1;
  final Directory _directory;
  final String identity;

  String get _currentManifestPath =>
      '${_directory.path}${Platform.pathSeparator}current.json';
  String get _previousManifestPath =>
      '${_directory.path}${Platform.pathSeparator}previous.json';

  String? _generation;
  // Retain the newly created stores until their generation is published. The
  // owning pipeline also holds them, but this makes the checkpoint lifecycle
  // explicit and prevents accidental early release in future refactors.
  // ignore: unused_field
  FileBackedLinearRgbTileStore? _newRgbStore;
  // ignore: unused_field
  FileBackedLinearContributionTileStore? _newContributionStore;

  Future<LinearRgbTileStore> createRgbStore({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    await _directory.create(recursive: true);
    _generation ??=
        '${DateTime.now().microsecondsSinceEpoch}-${pid.toString()}';
    final String path = '${_directory.path}${Platform.pathSeparator}'
        '${_generation!}.rgb.f32';
    final File stale = File(path);
    if (await stale.exists()) await stale.delete();
    final FileBackedLinearRgbTileStore store =
        await FileBackedLinearRgbTileStore.create(
      path: path,
      width: width,
      height: height,
      plan: plan,
    );
    _newRgbStore = store;
    return store;
  }

  Future<LinearContributionTileStore> createContributionStore({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    await _directory.create(recursive: true);
    _generation ??=
        '${DateTime.now().microsecondsSinceEpoch}-${pid.toString()}';
    final String path = '${_directory.path}${Platform.pathSeparator}'
        '${_generation!}.contrib.u16';
    final File stale = File(path);
    if (await stale.exists()) await stale.delete();
    final FileBackedLinearContributionTileStore store =
        await FileBackedLinearContributionTileStore.create(
      path: path,
      width: width,
      height: height,
      plan: plan,
    );
    _newContributionStore = store;
    return store;
  }

  Future<void> publishCommitted({
    required LinearRgbTileStore rgbStore,
    LinearContributionTileStore? contributionStore,
    int? committedItems,
    String? checkpointStage,
  }) async {
    if (rgbStore is! FileBackedLinearRgbTileStore || !rgbStore.isCommitted) {
      throw StateError('Post-decode RGB checkpoint is not committed.');
    }
    if (contributionStore != null &&
        (contributionStore is! FileBackedLinearContributionTileStore ||
            !contributionStore.isCommitted)) {
      throw StateError('Post-decode contribution checkpoint is not committed.');
    }
    if (contributionStore != null &&
        (contributionStore.width != rgbStore.width ||
            contributionStore.height != rgbStore.height)) {
      throw StateError('Post-decode checkpoint dimensions do not match.');
    }

    await _directory.create(recursive: true);
    final Map<String, dynamic> manifest = <String, dynamic>{
      'version': _version,
      'identity': identity,
      'generation':
          _generation ?? 'adopted-${DateTime.now().microsecondsSinceEpoch}',
      'createdEpochMs': DateTime.now().millisecondsSinceEpoch,
      'width': rgbStore.width,
      'height': rgbStore.height,
      'rgbPath': rgbStore.path,
      'rgbBytes': rgbStore.persistentByteLength,
      if (!ownsRgbStore(rgbStore))
        'rgbSha256':
            await DurableDecodedFrameCache.fileHash(File(rgbStore.path)),
      'contributionPath':
          contributionStore is FileBackedLinearContributionTileStore
              ? contributionStore.path
              : null,
      'contributionBytes': contributionStore?.persistentByteLength,
      if (contributionStore is FileBackedLinearContributionTileStore &&
          !ownsContributionStore(contributionStore))
        'contributionSha256': await DurableDecodedFrameCache.fileHash(
            File(contributionStore.path)),
      'committedItems': committedItems,
      'checkpointStage': checkpointStage,
    };

    final Map<String, dynamic>? oldCurrent =
        await _readManifest(File(_currentManifestPath));
    final Map<String, dynamic>? oldPrevious =
        await _readManifest(File(_previousManifestPath));
    if (oldCurrent != null) {
      // Publish the previous pointer first, but never delete the old previous
      // generation until the new current pointer is durable. A process death
      // between these two tiny writes therefore still leaves at least one
      // valid pointer to the old current generation.
      await _writeJsonAtomically(File(_previousManifestPath), oldCurrent);
    }
    await _writeJsonAtomically(File(_currentManifestPath), manifest);
    if (oldPrevious != null) {
      final Set<String> keep = <String>{
        ..._generationPaths(oldCurrent),
        ..._generationPaths(manifest),
      };
      await _deleteGenerationFilesExcept(oldPrevious, keep);
    }
    await _removeUnreferencedGenerationFiles();
    // Allow the same checkpoint store instance to create another immutable
    // generation. Existing callers publish once; rolling star-trail processing
    // intentionally publishes after every durably merged frame.
    _generation = null;
    _newRgbStore = null;
    _newContributionStore = null;
  }

  String get _exportReceiptPath =>
      '${_directory.path}${Platform.pathSeparator}export_receipt.json';

  Future<void> publishExportReceipt(String outputPath) async {
    final File output = File(outputPath);
    if (!await output.exists()) {
      throw StateError('Cannot commit export receipt: output is missing.');
    }
    final FileStat stat = await output.stat();
    if (stat.size <= 0) {
      throw StateError('Cannot commit export receipt: output is empty.');
    }
    await _writeJsonAtomically(File(_exportReceiptPath), <String, dynamic>{
      'version': _version,
      'identity': identity,
      'outputPath': outputPath,
      'bytes': stat.size,
      'modifiedEpochMs': stat.modified.millisecondsSinceEpoch,
      'committedEpochMs': DateTime.now().millisecondsSinceEpoch,
    });
  }

  Future<bool> hasValidExportReceipt(String outputPath) async {
    final Map<String, dynamic>? receipt =
        await _readManifest(File(_exportReceiptPath));
    if (receipt == null ||
        receipt['version'] != _version ||
        receipt['identity'] != identity ||
        receipt['outputPath'] != outputPath) {
      return false;
    }
    final File output = File(outputPath);
    if (!await output.exists()) return false;
    final FileStat stat = await output.stat();
    return stat.size > 0 &&
        stat.size == (receipt['bytes'] as num?)?.toInt() &&
        stat.modified.millisecondsSinceEpoch ==
            (receipt['modifiedEpochMs'] as num?)?.toInt();
  }

  Future<PostDecodePipelineCheckpoint?> restore() async {
    await _directory.create(recursive: true);
    for (final String manifestPath in <String>[
      _currentManifestPath,
      _previousManifestPath,
    ]) {
      final Map<String, dynamic>? manifest =
          await _readManifest(File(manifestPath));
      if (manifest == null || manifest['version'] != _version) continue;
      if (manifest['identity'] != identity) continue;
      final int? width = (manifest['width'] as num?)?.toInt();
      final int? height = (manifest['height'] as num?)?.toInt();
      final String? rgbPath = manifest['rgbPath'] as String?;
      if (width == null || height == null || width <= 0 || height <= 0) {
        continue;
      }
      if (rgbPath == null || rgbPath.isEmpty) continue;
      FileBackedLinearRgbTileStore? rgb;
      FileBackedLinearContributionTileStore? contribution;
      try {
        if (manifest['rgbSha256'] != null &&
            await DurableDecodedFrameCache.fileHash(File(rgbPath)) !=
                manifest['rgbSha256']) {
          continue;
        }
        rgb = await FileBackedLinearRgbTileStore.openCommitted(
          path: rgbPath,
          width: width,
          height: height,
        );
        final String? contributionPath =
            manifest['contributionPath'] as String?;
        if (contributionPath != null && contributionPath.isNotEmpty) {
          if (manifest['contributionSha256'] != null &&
              await DurableDecodedFrameCache.fileHash(File(contributionPath)) !=
                  manifest['contributionSha256']) {
            throw StateError('Contribution checkpoint hash mismatch');
          }
          contribution =
              await FileBackedLinearContributionTileStore.openCommitted(
            path: contributionPath,
            width: width,
            height: height,
          );
        }
        return PostDecodePipelineCheckpoint(
          rgbStore: rgb,
          contributionStore: contribution,
          generation: manifest['generation']?.toString() ?? 'unknown',
          committedItems: (manifest['committedItems'] as num?)?.toInt(),
          checkpointStage: manifest['checkpointStage']?.toString(),
        );
      } on Object {
        try {
          await contribution?.closeRetainingFile();
        } on Object {
          // Best-effort release while falling back to the older generation.
        }
        try {
          await rgb?.closeRetainingFile();
        } on Object {
          // Best-effort release while falling back to the older generation.
        }
        // Try the older generation. A torn/corrupt current generation must not
        // make the previous known-good checkpoint unusable.
      }
    }
    await _removeUnreferencedGenerationFiles();
    return null;
  }

  bool ownsRgbStore(LinearRgbTileStore store) =>
      store is FileBackedLinearRgbTileStore &&
      store.path.startsWith('${_directory.path}${Platform.pathSeparator}');

  bool ownsContributionStore(LinearContributionTileStore store) =>
      store is FileBackedLinearContributionTileStore &&
      store.path.startsWith('${_directory.path}${Platform.pathSeparator}');

  Future<void> closeRetainingRgb(LinearRgbTileStore store) async {
    if (store is FileBackedLinearRgbTileStore) {
      await store.closeRetainingFile();
    } else {
      await store.dispose();
    }
  }

  Future<void> closeRetainingContribution(
    LinearContributionTileStore store,
  ) async {
    if (store is FileBackedLinearContributionTileStore) {
      await store.closeRetainingFile();
    } else {
      await store.dispose();
    }
  }

  Future<void> cleanupAll() async {
    if (await _directory.exists()) {
      await _directory.delete(recursive: true);
    }
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
      '${destination.path}.tmp.${pid.toString()}.${DateTime.now().microsecondsSinceEpoch}',
    );
    await temp.writeAsString(jsonEncode(value), flush: true);
    try {
      await temp.rename(destination.path);
    } on FileSystemException {
      // Android/POSIX rename replaces atomically. The fallback exists for
      // filesystems that reject replacement; the previous generation still
      // remains independently referenced by previous.json.
      if (await destination.exists()) await destination.delete();
      await temp.rename(destination.path);
    }
  }

  Set<String> _generationPaths(Map<String, dynamic>? manifest) {
    if (manifest == null) return const <String>{};
    final Set<String> result = <String>{};
    for (final String key in <String>['rgbPath', 'contributionPath']) {
      final String? path = manifest[key] as String?;
      if (path != null && path.isNotEmpty) result.add(path);
    }
    return result;
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
        // Best effort; orphan cleanup can retry on a later launch.
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
      final Map<String, dynamic>? manifest = await _readManifest(File(path));
      if (manifest == null) continue;
      for (final String key in <String>['rgbPath', 'contributionPath']) {
        final String? filePath = manifest[key] as String?;
        if (filePath != null && filePath.isNotEmpty) referenced.add(filePath);
      }
    }
    await for (final FileSystemEntity entity in _directory.list()) {
      if (entity is! File) continue;
      final String name = entity.path.split(Platform.pathSeparator).last;
      if (name == 'current.json' || name == 'previous.json') continue;
      if (name.contains('.tmp.')) {
        try {
          await entity.delete();
        } on Object {
          // A future cleanup pass can retry removal of this stale temp file.
        }
        continue;
      }
      if ((name.endsWith('.rgb.f32') || name.endsWith('.contrib.u16')) &&
          !referenced.contains(entity.path)) {
        try {
          await entity.delete();
        } on Object {
          // A future cleanup pass can retry removal of this old generation.
        }
      }
    }
  }
}

final class PostDecodePipelineCheckpoint {
  const PostDecodePipelineCheckpoint({
    required this.rgbStore,
    required this.contributionStore,
    required this.generation,
    this.committedItems,
    this.checkpointStage,
  });

  final FileBackedLinearRgbTileStore rgbStore;
  final FileBackedLinearContributionTileStore? contributionStore;
  final String generation;
  final int? committedItems;
  final String? checkpointStage;
}
