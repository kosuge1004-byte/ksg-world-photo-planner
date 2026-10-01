import '../image/file_backed_linear_contribution_tile_store.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import '../image/linear_contribution_tile.dart';
import '../image/linear_contribution_tile_store.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'tiled_kappa_sigma_combiner.dart';
import 'tiled_registered_rgb_stacker.dart';

/// Owns both transactional stack outputs. Call [dispose] after export or the
/// next pipeline stage has finished reading them.
final class TiledRegisteredRgbStackResult {
  TiledRegisteredRgbStackResult({
    required this.rgb,
    required this.contributions,
  });

  final LinearRgbTileStore rgb;
  final LinearContributionTileStore contributions;
  bool _isDisposed = false;

  Future<void> dispose() async {
    if (_isDisposed) return;
    _isDisposed = true;
    try {
      await rgb.dispose();
    } finally {
      await contributions.dispose();
    }
  }
}

/// Runs registered rejection stacking over an ordered output plan and commits
/// RGB plus contribution counts as one logical transaction.
final class TiledRegisteredRgbStackPipeline {
  const TiledRegisteredRgbStackPipeline({
    this.stacker = const TiledRegisteredRgbStacker(),
    this.rgbStoreFactory = _createTemporaryRgbStore,
    this.contributionStoreFactory = _createTemporaryContributionStore,
  });

  final TiledRegisteredRgbStacker stacker;
  final LinearRgbTileStoreFactory rgbStoreFactory;
  final LinearContributionTileStoreFactory contributionStoreFactory;

  Future<TiledRegisteredRgbStackResult> run({
    required List<RegisteredRgbFrame> frames,
    required int outputImageWidth,
    required int outputImageHeight,
    required OverlappedTilePlan outputPlan,
    bool Function()? isCancelled,
    void Function(double progress)? reportProgress,
  }) async {
    if (frames.isEmpty ||
        outputImageWidth <= 0 ||
        outputImageHeight <= 0 ||
        outputPlan.tiles.isEmpty) {
      throw ArgumentError('Invalid tiled registered stack request.');
    }
    if (isCancelled?.call() ?? false) {
      throw const TiledStackingCancelled();
    }

    LinearRgbTileStore? rgbStore;
    LinearContributionTileStore? contributionStore;
    bool succeeded = false;
    try {
      rgbStore = await rgbStoreFactory(
        width: outputImageWidth,
        height: outputImageHeight,
        plan: outputPlan,
      );
      contributionStore = await contributionStoreFactory(
        width: outputImageWidth,
        height: outputImageHeight,
        plan: outputPlan,
      );
      for (int index = 0; index < outputPlan.tiles.length; index++) {
        if (isCancelled?.call() ?? false) {
          throw const TiledStackingCancelled();
        }
        final OverlappedTile tile = outputPlan.tiles[index];
        final RejectionStackedRgbTile combined = await stacker.combineTile(
          frames: frames,
          outputTile: tile,
          outputImageWidth: outputImageWidth,
          outputImageHeight: outputImageHeight,
          isCancelled: isCancelled,
          reportProgress: (double tileProgress) {
            reportProgress?.call(
              (index + tileProgress) / outputPlan.tiles.length,
            );
          },
        );
        await rgbStore.writeTile(combined.tile);
        await contributionStore.writeTile(
          LinearContributionTile(
            x: combined.tile.x,
            y: combined.tile.y,
            width: combined.tile.width,
            height: combined.tile.height,
            interleavedCounts: combined.contributingSamples,
          ),
        );
      }
      await rgbStore.commit();
      await contributionStore.commit();
      succeeded = true;
      return TiledRegisteredRgbStackResult(
        rgb: rgbStore,
        contributions: contributionStore,
      );
    } finally {
      if (!succeeded) {
        try {
          await rgbStore?.abort();
        } finally {
          await contributionStore?.abort();
        }
      }
    }
  }
}

Future<LinearRgbTileStore> _createTemporaryRgbStore({
  required int width,
  required int height,
  required OverlappedTilePlan plan,
}) =>
    FileBackedLinearRgbTileStore.createTemporary(
      width: width,
      height: height,
      plan: plan,
    );

Future<LinearContributionTileStore> _createTemporaryContributionStore({
  required int width,
  required int height,
  required OverlappedTilePlan plan,
}) =>
    FileBackedLinearContributionTileStore.createTemporary(
      width: width,
      height: height,
      plan: plan,
    );
