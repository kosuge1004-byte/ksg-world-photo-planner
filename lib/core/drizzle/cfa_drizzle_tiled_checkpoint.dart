import 'dart:convert';
import 'dart:io';
import '../background/durable_tile_checkpoint.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';

/// All output planes are flushed before publishing per-tile SHA-256 receipts.
final class CfaDrizzleTiledCheckpointStore {
  CfaDrizzleTiledCheckpointStore(
      {required this.directory, required this.identity});
  final Directory directory;
  final String identity;
  String _runtimeIdentity = '';
  void bindInputs(Object value) {
    _runtimeIdentity = jsonEncode(value);
  }

  DurableTileCheckpoint? _checkpoint;
  CfaDrizzleTiledCheckpointProgress? _progress;
  int completedTileCount = 0;
  Future<CfaDrizzleTiledCheckpointProgress> openOrCreate({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
    required bool needsSaturationStore,
    bool needsPreRejectionStore = false,
  }) async {
    final checkpoint =
        DurableTileCheckpoint(directory, '$identity|$_runtimeIdentity');
    _checkpoint = checkpoint;
    final planes = {
      'value.f32': 12,
      'coverage.f32': 12,
      if (needsSaturationStore) 'saturation.f32': 12,
      if (needsPreRejectionStore) 'pre-rejection.f32': 12
    };
    final restored = await checkpoint.load(
        width: width, height: height, plan: plan, planes: planes);
    final count = restored ?? 0;
    if (restored == null) await checkpoint.startFresh();
    final opened = <Object>[];
    try {
      final FileBackedLinearRgbTileStore valueStore = restored == null
          ? await FileBackedLinearRgbTileStore.create(
              path: checkpoint.planePath('value.f32'),
              width: width,
              height: height,
              plan: plan)
          : await FileBackedLinearRgbTileStore.openForResume(
              path: checkpoint.planePath('value.f32'),
              width: width,
              height: height,
              plan: plan,
              completedTileCount: count);
      opened.add(valueStore);
      final FileBackedLinearRgbTileStore coverageStore = restored == null
          ? await FileBackedLinearRgbTileStore.create(
              path: checkpoint.planePath('coverage.f32'),
              width: width,
              height: height,
              plan: plan)
          : await FileBackedLinearRgbTileStore.openForResume(
              path: checkpoint.planePath('coverage.f32'),
              width: width,
              height: height,
              plan: plan,
              completedTileCount: count);
      opened.add(coverageStore);
      final FileBackedLinearRgbTileStore? saturationCoverageStore =
          needsSaturationStore
              ? (restored == null
                  ? await FileBackedLinearRgbTileStore.create(
                      path: checkpoint.planePath('saturation.f32'),
                      width: width,
                      height: height,
                      plan: plan)
                  : await FileBackedLinearRgbTileStore.openForResume(
                      path: checkpoint.planePath('saturation.f32'),
                      width: width,
                      height: height,
                      plan: plan,
                      completedTileCount: count))
              : null;
      if (saturationCoverageStore != null) opened.add(saturationCoverageStore);
      final FileBackedLinearRgbTileStore? preRejectionCoverageStore =
          needsPreRejectionStore
              ? (restored == null
                  ? await FileBackedLinearRgbTileStore.create(
                      path: checkpoint.planePath('pre-rejection.f32'),
                      width: width,
                      height: height,
                      plan: plan)
                  : await FileBackedLinearRgbTileStore.openForResume(
                      path: checkpoint.planePath('pre-rejection.f32'),
                      width: width,
                      height: height,
                      plan: plan,
                      completedTileCount: count))
              : null;
      if (preRejectionCoverageStore != null) {
        opened.add(preRejectionCoverageStore);
      }
      if (restored == null) await checkpoint.publishInitial();
      completedTileCount = count;
      return _progress = CfaDrizzleTiledCheckpointProgress(
        resumeFromTileIndex: count,
        valueStore: valueStore,
        coverageStore: coverageStore,
        saturationCoverageStore: saturationCoverageStore,
        preRejectionCoverageStore: preRejectionCoverageStore,
      );
    } on Object {
      for (final store in opened) {
        if (store is FileBackedLinearRgbTileStore) {
          await store.closeRetainingFile();
        }
      }
      rethrow;
    }
  }

  Future<void> recordProgress(int count) async {
    final progress = _progress!;
    await progress.valueStore.flushCheckpoint();
    await progress.coverageStore.flushCheckpoint();
    await progress.saturationCoverageStore?.flushCheckpoint();
    await progress.preRejectionCoverageStore?.flushCheckpoint();
    await _checkpoint!.record(count);
    completedTileCount = count;
  }

  Future<void> clear() async {
    if (await directory.exists()) await directory.delete(recursive: true);
    completedTileCount = 0;
  }
}

final class CfaDrizzleTiledCheckpointProgress {
  const CfaDrizzleTiledCheckpointProgress({
    required this.resumeFromTileIndex,
    required this.valueStore,
    required this.coverageStore,
    required this.saturationCoverageStore,
    required this.preRejectionCoverageStore,
  });
  final int resumeFromTileIndex;
  final FileBackedLinearRgbTileStore valueStore;
  final FileBackedLinearRgbTileStore coverageStore;
  final FileBackedLinearRgbTileStore? saturationCoverageStore;
  final FileBackedLinearRgbTileStore? preRejectionCoverageStore;
}
