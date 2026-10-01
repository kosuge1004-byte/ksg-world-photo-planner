import 'cfa_drizzle_tiled_checkpoint.dart';
import '../image/file_backed_linear_rgb_tile_store.dart';
import 'dart:typed_data';

import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import '../tiles/overlapped_tile_plan.dart';
import 'cfa_drizzle.dart' show CfaDrizzleResult;
import 'drizzle_accumulator.dart' show DrizzleResult;
import 'robust_combine_cfa_drizzle.dart';
import 'tiled_cfa_drizzle.dart';

final class StreamingRobustCfaDrizzleResult {
  const StreamingRobustCfaDrizzleResult({
    required this.valueStore,
    required this.coverageStore,
    this.saturationCoverageStore,
    this.preRejectionCoverageStore,
  });

  final LinearRgbTileStore valueStore;
  final LinearRgbTileStore coverageStore;
  final LinearRgbTileStore? saturationCoverageStore;
  final LinearRgbTileStore? preRejectionCoverageStore;
}

/// Robust-drizzles all frames one output tile at a time. No per-frame
/// full-resolution drizzle image is written, so persistent scratch usage is
/// O(input RAW + final output), not O(frame count * final output).
Future<StreamingRobustCfaDrizzleResult> robustDrizzleCfaFramesStreamingTiled({
  required List<CfaDrizzleTiledFrame> frames,
  required int outputWidth,
  required int outputHeight,
  required LinearRgbTileStoreFactory valueStoreFactory,
  required LinearRgbTileStoreFactory coverageStoreFactory,
  CfaDrizzleTiledCheckpointStore? stageCheckpoint,
  int tileSize = 128,
  double outputScale = 2,
  double pixfrac = 0.7,
  double minCoverage = 1e-6,
  int minFramesForRejection = 4,
  double sigmaLow = 4,
  double sigmaHigh = 3,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  if (frames.isEmpty) {
    throw InvalidRobustCombineInput('At least one CFA frame is required.');
  }
  if (outputWidth <= 0 || outputHeight <= 0 || tileSize <= 0) {
    throw ArgumentError('Output dimensions and tileSize must be positive.');
  }
  if (!pixfrac.isFinite ||
      !outputScale.isFinite ||
      !(pixfrac > 0) ||
      !(outputScale > 0)) {
    throw ArgumentError('pixfrac and outputScale must be finite and positive.');
  }
  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: outputWidth,
    imageHeight: outputHeight,
    tileSize: tileSize,
    overlap: 0,
  );
  final bool hasSaturation = frames.any(
    (CfaDrizzleTiledFrame frame) => frame.mosaicStore.hasSaturatedPixels,
  );
  final List<CfaDrizzleFrameGeometry> frameGeometries =
      frames.map(prepareCfaDrizzleFrameGeometry).toList(growable: false);
  LinearRgbTileStore? outputValue;
  LinearRgbTileStore? outputCoverage;
  LinearRgbTileStore? outputSaturation;
  LinearRgbTileStore? outputPreRejectionCoverage;
  bool committed = false;
  try {
    int resumeFromTileIndex = 0;
    if (stageCheckpoint != null) {
      final progress = await stageCheckpoint.openOrCreate(
          width: outputWidth,
          height: outputHeight,
          plan: plan,
          needsSaturationStore: hasSaturation,
          needsPreRejectionStore: hasSaturation);
      outputValue = progress.valueStore;
      outputCoverage = progress.coverageStore;
      outputSaturation = progress.saturationCoverageStore;
      outputPreRejectionCoverage = progress.preRejectionCoverageStore;
      resumeFromTileIndex = progress.resumeFromTileIndex;
    } else {
      outputValue = await valueStoreFactory(
        width: outputWidth,
        height: outputHeight,
        plan: plan,
      );
      outputCoverage = await coverageStoreFactory(
        width: outputWidth,
        height: outputHeight,
        plan: plan,
      );
      if (hasSaturation) {
        outputSaturation = await coverageStoreFactory(
          width: outputWidth,
          height: outputHeight,
          plan: plan,
        );
        outputPreRejectionCoverage = await coverageStoreFactory(
          width: outputWidth,
          height: outputHeight,
          plan: plan,
        );
      }
    }
    for (int tileIndex = resumeFromTileIndex;
        tileIndex < plan.tiles.length;
        tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Robust CFA drizzle was cancelled.');
      }
      final OverlappedTile tile = plan.tiles[tileIndex];
      final int pixelCount = tile.outputWidth * tile.outputHeight;
      final List<CfaDrizzleResult> perFrame = <CfaDrizzleResult>[];
      final Float64List? saturationSum =
          hasSaturation ? Float64List(pixelCount * 3) : null;
      final Float64List? preRejectionCoverageSum =
          hasSaturation ? Float64List(pixelCount * 3) : null;
      for (int frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        if (isCancelled?.call() ?? false) {
          throw StateError('Robust CFA drizzle was cancelled.');
        }
        final CfaDrizzleTiledFrame frame = frames[frameIndex];
        final tileResult = await drizzleCfaFrameToOutputTile(
          frame: frame,
          outputTile: tile,
          outputScale: outputScale,
          pixfrac: pixfrac,
          preparedGeometry: frameGeometries[frameIndex],
        );
        perFrame.add(tileResult.scientific);
        if (hasSaturation) {
          for (int c = 0; c < 3; c++) {
            final Float64List coverage =
                tileResult.scientific.channels[c].coverage;
            final Float64List? saturation =
                tileResult.saturation?.channels[c].coverage;
            for (int pixel = 0; pixel < pixelCount; pixel++) {
              final int interleaved = pixel * 3 + c;
              preRejectionCoverageSum![interleaved] += coverage[pixel];
              if (saturation != null) {
                saturationSum![interleaved] += saturation[pixel];
              }
            }
          }
        }
      }
      final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
        perFrame,
        minCoverage: minCoverage,
        minFramesForRejection: minFramesForRejection,
        sigmaLow: sigmaLow,
        sigmaHigh: sigmaHigh,
      );
      final Float32List values = Float32List(pixelCount * 3);
      final Float32List coverage = Float32List(pixelCount * 3);
      final Float32List? saturation =
          hasSaturation ? Float32List(pixelCount * 3) : null;
      final Float32List? preRejection =
          hasSaturation ? Float32List(pixelCount * 3) : null;
      const double maximumFloat32 = 3.4028234663852886e38;
      for (int pixel = 0; pixel < pixelCount; pixel++) {
        for (int c = 0; c < 3; c++) {
          final int index = pixel * 3 + c;
          final double combinedValue = combined.channels[c].value[pixel];
          final double combinedCoverage = combined.channels[c].coverage[pixel];
          final double saturationCoverage = saturationSum?[index] ?? 0;
          final double preRejectionCoverage =
              preRejectionCoverageSum?[index] ?? 0;
          if (!combinedValue.isFinite ||
              !combinedCoverage.isFinite ||
              !saturationCoverage.isFinite ||
              !preRejectionCoverage.isFinite ||
              combinedCoverage < 0 ||
              saturationCoverage < 0 ||
              preRejectionCoverage < 0 ||
              combinedValue.abs() > maximumFloat32 ||
              combinedCoverage > maximumFloat32 ||
              saturationCoverage > maximumFloat32 ||
              preRejectionCoverage > maximumFloat32) {
            throw InvalidRobustCombineInput(
              'Streaming robust CFA drizzle output exceeds finite Float32 range.',
            );
          }
          values[index] = combinedValue;
          coverage[index] = combinedCoverage;
          if (hasSaturation) {
            saturation![index] = saturationCoverage;
            preRejection![index] = preRejectionCoverage;
          }
        }
      }
      await outputValue.writeTile(LinearRgbTile(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
        interleavedRgb: values,
      ));
      await outputCoverage.writeTile(LinearRgbTile(
        x: tile.outputX,
        y: tile.outputY,
        width: tile.outputWidth,
        height: tile.outputHeight,
        interleavedRgb: coverage,
      ));
      if (hasSaturation) {
        await outputSaturation!.writeTile(LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: saturation!,
        ));
        await outputPreRejectionCoverage!.writeTile(LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: preRejection!,
        ));
      }
      await stageCheckpoint?.recordProgress(tileIndex + 1);
      reportProgress?.call((tileIndex + 1) / plan.tiles.length);
    }
    await outputValue.commit();
    await outputCoverage.commit();
    await outputSaturation?.commit();
    await outputPreRejectionCoverage?.commit();
    committed = true;
    return StreamingRobustCfaDrizzleResult(
      valueStore: outputValue,
      coverageStore: outputCoverage,
      saturationCoverageStore: outputSaturation,
      preRejectionCoverageStore: outputPreRejectionCoverage,
    );
  } finally {
    if (!committed) {
      for (final store in [
        outputValue,
        outputCoverage,
        outputSaturation,
        outputPreRejectionCoverage
      ]) {
        if (stageCheckpoint != null && store is FileBackedLinearRgbTileStore) {
          await store.closeRetainingFile();
        } else {
          await store?.abort();
        }
      }
    }
  }
}

/// Tiled counterpart to `robust_combine_cfa_drizzle.dart`'s own
/// whole-image `robustCombineCfaDrizzleResults`, reading each of N
/// separate per-frame drizzle results — [valueStores]/[coverageStores],
/// each a 3-channel interleaved RGB [LinearRgbTileStore] (the same
/// shape `drizzleCfaTiled` already produces when called once per frame
/// — see this file's own doc comment for why that per-frame call
/// pattern, not a single combined call, is what makes rejection
/// possible at all) — tile by tile, rather than requiring all N frames'
/// full-image planes materialized in memory at once.
///
/// **Why tile by tile, and why this genuinely costs more than the
/// existing single-pass drizzle path**: robust rejection fundamentally
/// needs to see every contributing frame's own individual value at a
/// position before it can decide what is an outlier — unlike the
/// existing `cfaDrizzle`/`DrizzleAccumulator`, which sums contributions
/// as they arrive and never needs more than one accumulator's worth of
/// memory regardless of frame count, this necessarily needs access to N
/// separate results at once. Reading only one tile's worth from each of
/// the N stores at a time (rather than all N stores' full images)
/// bounds peak memory to `O(N * tileSize^2)` instead of
/// `O(N * imageSize)` — the same "use tiling to keep quality-costing
/// features memory-bounded rather than skipping them" approach this
/// project has used throughout (`tiled_cfa_drizzle.dart`, Work87;
/// `tiled_drizzle_gap_fill.dart`, Work92; `tiled_local_tone_
/// adaptation.dart`, Work101) — the person who requested this feature
/// explicitly asked for exactly this trade-off ("速度やメモリ効率の
/// ために画質を犠牲にしない...タイル／ストリーミング／ファイル
/// バック方式で解決すること").
///
/// This module deliberately does not reimplement the rejection math
/// itself — each tile's own N per-frame regions are converted into the
/// same `CfaDrizzleResult`-shaped structure `robustCombineCfaDrizzle
/// Results` (Work113) already accepts and consumes with that same,
/// already-tested function, unchanged. This keeps the actual statistics
/// (median/MAD/asymmetric sigma-clipping) defined and tested in exactly
/// one place.
///
/// This file has not been executed against the Dart SDK. Its own new
/// logic — reading N stores per tile and converting between the
/// interleaved-RGB-tile and separate-channel-plane shapes — has direct
/// test coverage in `test/tiled_robust_combine_cfa_drizzle_test.dart`,
/// which additionally confirms this tiled version's output matches the
/// whole-image `robustCombineCfaDrizzleResults` exactly on the same
/// synthetic per-frame data, the same "tiled version matches the
/// whole-frame version exactly" discipline established for
/// `tiled_cfa_drizzle.dart` (Work87) and `tiled_drizzle_gap_fill.dart`
/// (Work92).

/// Combines [valueStores]/[coverageStores] (each a same-length list of
/// per-frame, already-committed 3-channel interleaved RGB stores, all
/// sharing the same dimensions) into one combined value store and one
/// combined coverage store, applying `robustCombineCfaDrizzleResults`'s
/// own per-pixel, per-channel rejection tile by tile.
///
/// - [minCoverage], [minFramesForRejection], [sigmaLow], [sigmaHigh]:
///   forwarded to `robustCombineCfaDrizzleResults`.
///
/// Throws [InvalidRobustCombineInput] if [valueStores]/[coverageStores]
/// are empty, have mismatched lengths, or any entry has dimensions
/// differing from the first.
Future<({LinearRgbTileStore valueStore, LinearRgbTileStore coverageStore})>
    robustCombineCfaDrizzleTiledResults({
  required List<LinearRgbTileStore> valueStores,
  required List<LinearRgbTileStore> coverageStores,
  required LinearRgbTileStoreFactory outputValueStoreFactory,
  required LinearRgbTileStoreFactory outputCoverageStoreFactory,
  int tileSize = 512,
  double minCoverage = 1e-6,
  int minFramesForRejection = 4,
  double sigmaLow = 4,
  double sigmaHigh = 3,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  if (valueStores.isEmpty || coverageStores.isEmpty) {
    throw InvalidRobustCombineInput(
      'At least one per-frame value/coverage store pair is required.',
    );
  }
  if (valueStores.length != coverageStores.length) {
    throw InvalidRobustCombineInput(
      'valueStores and coverageStores must have the same length.',
    );
  }
  if (minFramesForRejection < 2) {
    throw InvalidRobustCombineInput(
      'minFramesForRejection must be an integer >= 2.',
    );
  }
  if (!minCoverage.isFinite || minCoverage < 0) {
    throw InvalidRobustCombineInput(
      'minCoverage must be finite and non-negative.',
    );
  }
  if (!sigmaLow.isFinite ||
      !sigmaHigh.isFinite ||
      sigmaLow <= 0 ||
      sigmaHigh <= 0) {
    throw InvalidRobustCombineInput(
      'sigmaLow and sigmaHigh must be finite and positive.',
    );
  }
  final int width = valueStores[0].width;
  final int height = valueStores[0].height;
  for (int i = 0; i < valueStores.length; i++) {
    if (valueStores[i].width != width ||
        valueStores[i].height != height ||
        coverageStores[i].width != width ||
        coverageStores[i].height != height) {
      throw InvalidRobustCombineInput(
        'All value/coverage stores must share the same dimensions.',
      );
    }
  }

  final OverlappedTilePlan plan = OverlappedTilePlan.create(
    imageWidth: width,
    imageHeight: height,
    tileSize: tileSize,
    overlap: 0,
  );
  LinearRgbTileStore? outputValueStore;
  LinearRgbTileStore? outputCoverageStore;
  bool committed = false;
  try {
    outputValueStore = await outputValueStoreFactory(
      width: width,
      height: height,
      plan: plan,
    );
    outputCoverageStore = await outputCoverageStoreFactory(
      width: width,
      height: height,
      plan: plan,
    );
    for (int tileIndex = 0; tileIndex < plan.tiles.length; tileIndex++) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Robust combine was cancelled.');
      }
      final OverlappedTile tile = plan.tiles[tileIndex];
      final int tilePixelCount = tile.outputWidth * tile.outputHeight;

      final List<CfaDrizzleResult> perFrameResults = <CfaDrizzleResult>[];
      for (int f = 0; f < valueStores.length; f++) {
        final LinearRgbTile valueTile = await valueStores[f].readRegion(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
        );
        final LinearRgbTile coverageTile = await coverageStores[f].readRegion(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
        );
        final List<DrizzleResult> channels = <DrizzleResult>[
          for (int c = 0; c < 3; c++)
            DrizzleResult(
              width: tile.outputWidth,
              height: tile.outputHeight,
              value: Float64List(tilePixelCount),
              coverage: Float64List(tilePixelCount),
            ),
        ];
        for (int ty = 0; ty < tile.outputHeight; ty++) {
          for (int tx = 0; tx < tile.outputWidth; tx++) {
            final int localIndex = ty * tile.outputWidth + tx;
            for (int c = 0; c < 3; c++) {
              channels[c].value[localIndex] = valueTile.channelAt(
                tx,
                ty,
                c,
              );
              channels[c].coverage[localIndex] = coverageTile.channelAt(
                tx,
                ty,
                c,
              );
            }
          }
        }
        perFrameResults.add(
          CfaDrizzleResult(
            width: tile.outputWidth,
            height: tile.outputHeight,
            channels: channels,
          ),
        );
      }

      final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
        perFrameResults,
        minCoverage: minCoverage,
        minFramesForRejection: minFramesForRejection,
        sigmaLow: sigmaLow,
        sigmaHigh: sigmaHigh,
      );

      final Float32List combinedValueSamples = Float32List(
        tilePixelCount * 3,
      );
      final Float32List combinedCoverageSamples = Float32List(
        tilePixelCount * 3,
      );
      for (int localIndex = 0; localIndex < tilePixelCount; localIndex++) {
        for (int c = 0; c < 3; c++) {
          final double combinedValue = combined.channels[c].value[localIndex];
          final double combinedCoverage =
              combined.channels[c].coverage[localIndex];
          const double maximumFloat32 = 3.4028234663852886e38;
          if (!combinedValue.isFinite ||
              !combinedCoverage.isFinite ||
              combinedCoverage < 0 ||
              combinedValue.abs() > maximumFloat32 ||
              combinedCoverage > maximumFloat32) {
            throw InvalidRobustCombineInput(
              'Tiled robust CFA combine output exceeds finite Float32 range.',
            );
          }
          combinedValueSamples[localIndex * 3 + c] = combinedValue;
          combinedCoverageSamples[localIndex * 3 + c] = combinedCoverage;
        }
      }
      await outputValueStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: combinedValueSamples,
        ),
      );
      await outputCoverageStore.writeTile(
        LinearRgbTile(
          x: tile.outputX,
          y: tile.outputY,
          width: tile.outputWidth,
          height: tile.outputHeight,
          interleavedRgb: combinedCoverageSamples,
        ),
      );
      reportProgress?.call((tileIndex + 1) / plan.tiles.length);
    }
    await outputValueStore.commit();
    await outputCoverageStore.commit();
    committed = true;
    return (
      valueStore: outputValueStore,
      coverageStore: outputCoverageStore,
    );
  } finally {
    if (!committed) {
      try {
        await outputValueStore?.abort();
      } finally {
        await outputCoverageStore?.abort();
      }
    }
  }
}
