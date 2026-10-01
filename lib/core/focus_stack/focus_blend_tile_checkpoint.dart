import 'dart:convert';
import 'dart:io';
import '../background/durable_tile_checkpoint.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'file_backed_focus_coverage_mask.dart';

/// All output planes are flushed before publishing per-tile SHA-256 receipts.
final class FocusBlendTileCheckpointStore {
  FocusBlendTileCheckpointStore(
      {required this.directory, required this.identity});
  final Directory directory;
  final String identity;
  String _runtimeIdentity = '';
  void bindInputs(Object value) {
    _runtimeIdentity = jsonEncode(value);
  }

  DurableTileCheckpoint? _checkpoint;
  FocusBlendTileCheckpointProgress? _progress;
  int completedTileCount = 0;
  Future<FocusBlendTileCheckpointProgress> openOrCreate({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    final checkpoint =
        DurableTileCheckpoint(directory, '$identity|$_runtimeIdentity');
    _checkpoint = checkpoint;
    final planes = {'blend-rgb.f32': 12, 'blend-coverage.u8': 1};
    final restored = await checkpoint.load(
        width: width, height: height, plan: plan, planes: planes);
    final count = restored ?? 0;
    if (restored == null) await checkpoint.startFresh();
    final opened = <Object>[];
    try {
      final FileBackedLinearRgbTileStore rgbStore = restored == null
          ? await FileBackedLinearRgbTileStore.create(
              path: checkpoint.planePath('blend-rgb.f32'),
              width: width,
              height: height,
              plan: plan)
          : await FileBackedLinearRgbTileStore.openForResume(
              path: checkpoint.planePath('blend-rgb.f32'),
              width: width,
              height: height,
              plan: plan,
              completedTileCount: count);
      opened.add(rgbStore);
      final FileBackedFocusCoverageMask coverageMask = restored == null
          ? await FileBackedFocusCoverageMask.create(
              path: checkpoint.planePath('blend-coverage.u8'),
              width: width,
              height: height)
          : await FileBackedFocusCoverageMask.openForResume(
              path: checkpoint.planePath('blend-coverage.u8'),
              width: width,
              height: height);
      opened.add(coverageMask);
      if (restored == null) await checkpoint.publishInitial();
      completedTileCount = count;
      return _progress = FocusBlendTileCheckpointProgress(
        resumeFromTileIndex: count,
        rgbStore: rgbStore,
        coverageMask: coverageMask,
      );
    } on Object {
      for (final store in opened) {
        if (store is FileBackedLinearRgbTileStore) {
          await store.closeRetainingFile();
        }
        if (store is FileBackedFocusCoverageMask) {
          await store.closeRetainingFile();
        }
      }
      rethrow;
    }
  }

  Future<void> recordProgress(int count) async {
    final progress = _progress!;
    await progress.rgbStore.flushCheckpoint();
    await progress.coverageMask.flushCheckpoint();
    await _checkpoint!.record(count);
    completedTileCount = count;
  }

  Future<void> clear() async {
    if (await directory.exists()) await directory.delete(recursive: true);
    completedTileCount = 0;
  }
}

final class FocusBlendTileCheckpointProgress {
  const FocusBlendTileCheckpointProgress({
    required this.resumeFromTileIndex,
    required this.rgbStore,
    required this.coverageMask,
  });
  final int resumeFromTileIndex;
  final FileBackedLinearRgbTileStore rgbStore;
  final FileBackedFocusCoverageMask coverageMask;
}
