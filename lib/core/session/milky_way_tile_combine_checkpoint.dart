import 'dart:convert';
import 'dart:io';
import '../background/durable_tile_checkpoint.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import '../image/file_backed_linear_contribution_tile_store.dart';

/// All output planes are flushed before publishing per-tile SHA-256 receipts.
final class MilkyWayTileCombineCheckpointStore {
  MilkyWayTileCombineCheckpointStore(
      {required this.directory, required this.identity});
  final Directory directory;
  final String identity;
  String _runtimeIdentity = '';
  void bindInputs(Object value) {
    _runtimeIdentity = jsonEncode(value);
  }

  DurableTileCheckpoint? _checkpoint;
  MilkyWayTileCombineCheckpointProgress? _progress;
  int completedTileCount = 0;
  Future<MilkyWayTileCombineCheckpointProgress> openOrCreate({
    required int width,
    required int height,
    required OverlappedTilePlan plan,
  }) async {
    final checkpoint =
        DurableTileCheckpoint(directory, '$identity|$_runtimeIdentity');
    _checkpoint = checkpoint;
    final planes = {'combined.f32': 12, 'contributions.u16': 6};
    final restored = await checkpoint.load(
        width: width, height: height, plan: plan, planes: planes);
    final count = restored ?? 0;
    if (restored == null) await checkpoint.startFresh();
    final opened = <Object>[];
    try {
      final FileBackedLinearRgbTileStore rgbStore = restored == null
          ? await FileBackedLinearRgbTileStore.create(
              path: checkpoint.planePath('combined.f32'),
              width: width,
              height: height,
              plan: plan)
          : await FileBackedLinearRgbTileStore.openForResume(
              path: checkpoint.planePath('combined.f32'),
              width: width,
              height: height,
              plan: plan,
              completedTileCount: count);
      opened.add(rgbStore);
      final FileBackedLinearContributionTileStore contributionStore =
          restored == null
              ? await FileBackedLinearContributionTileStore.create(
                  path: checkpoint.planePath('contributions.u16'),
                  width: width,
                  height: height,
                  plan: plan)
              : await FileBackedLinearContributionTileStore.openForResume(
                  path: checkpoint.planePath('contributions.u16'),
                  width: width,
                  height: height,
                  plan: plan,
                  completedTileCount: count);
      opened.add(contributionStore);
      if (restored == null) await checkpoint.publishInitial();
      completedTileCount = count;
      return _progress = MilkyWayTileCombineCheckpointProgress(
        resumeFromTileIndex: count,
        rgbStore: rgbStore,
        contributionStore: contributionStore,
      );
    } on Object {
      for (final store in opened) {
        if (store is FileBackedLinearRgbTileStore) {
          await store.closeRetainingFile();
        }
        if (store is FileBackedLinearContributionTileStore) {
          await store.closeRetainingFile();
        }
      }
      rethrow;
    }
  }

  Future<void> recordProgress(int count) async {
    final progress = _progress!;
    await progress.rgbStore.flushCheckpoint();
    await progress.contributionStore.flushCheckpoint();
    await _checkpoint!.record(count);
    completedTileCount = count;
  }

  Future<void> clear() async {
    if (await directory.exists()) await directory.delete(recursive: true);
    completedTileCount = 0;
  }
}

final class MilkyWayTileCombineCheckpointProgress {
  const MilkyWayTileCombineCheckpointProgress({
    required this.resumeFromTileIndex,
    required this.rgbStore,
    required this.contributionStore,
  });
  final int resumeFromTileIndex;
  final FileBackedLinearRgbTileStore rgbStore;
  final FileBackedLinearContributionTileStore contributionStore;
}
