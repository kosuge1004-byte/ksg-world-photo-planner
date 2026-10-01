import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/background/rolling_weighted_average_checkpoint_store.dart';
import 'package:mobile_stack/core/image/file_backed_linear_contribution_tile_store.dart';
import 'package:mobile_stack/core/image/file_backed_float64_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/float64_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/stacking/tiled_kappa_sigma_combiner.dart';
import 'package:mobile_stack/core/stacking/tiled_weighted_average_combiner.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

OverlappedTile _region(int x, int y, int width, int height) => OverlappedTile(
      outputX: x,
      outputY: y,
      outputWidth: width,
      outputHeight: height,
      inputX: x,
      inputY: y,
      inputWidth: width,
      inputHeight: height,
    );

CoveredLinearRgbTile _readFixture(
  Float32List frame,
  Uint8List coverage,
  int imageWidth,
  OverlappedTile region,
) {
  final Float32List rgb =
      Float32List(region.outputWidth * region.outputHeight * 3);
  final Uint8List covered = Uint8List(region.outputWidth * region.outputHeight);
  for (int y = 0; y < region.outputHeight; y++) {
    for (int x = 0; x < region.outputWidth; x++) {
      final int sourcePixel =
          (region.outputY + y) * imageWidth + region.outputX + x;
      final int destinationPixel = y * region.outputWidth + x;
      rgb.setRange(
        destinationPixel * 3,
        destinationPixel * 3 + 3,
        frame,
        sourcePixel * 3,
      );
      covered[destinationPixel] = coverage[sourcePixel];
    }
  }
  return CoveredLinearRgbTile(
    tile: LinearRgbTile(
      x: region.outputX,
      y: region.outputY,
      width: region.outputWidth,
      height: region.outputHeight,
      interleavedRgb: rgb,
    ),
    coverage: covered,
  );
}

void main() {
  test('FP64 rolling result is bit-identical to batch weighted average',
      () async {
    const int width = 97;
    const int height = 173;
    const int frameCount = 7;
    final math.Random random = math.Random(325);
    final List<Float32List> frames = <Float32List>[
      for (int frame = 0; frame < frameCount; frame++)
        Float32List.fromList(<double>[
          for (int i = 0; i < width * height * 3; i++)
            random.nextDouble() * 8 - 2,
        ]),
    ];
    final List<Uint8List> coverages = <Uint8List>[
      for (int frame = 0; frame < frameCount; frame++)
        Uint8List.fromList(<int>[
          for (int i = 0; i < width * height; i++)
            random.nextDouble() < 0.08 ? 0 : 1,
        ]),
    ];
    final List<double> weights = <double>[
      0.13,
      0.91,
      0.44,
      0.72,
      1,
      0.35,
      0.63
    ];
    final double maximumWeight = weights.reduce(math.max);

    final RejectionStackedRgbTile batch = await const TiledKappaSigmaCombiner(
      enableOutlierRejection: false,
      maximumPixelsPerBand: 8192,
      maximumAlignedFrameCacheBytes: 0,
    ).combineTile(
      frameCount: frameCount,
      frameWeights: weights,
      outputTile: _region(0, 0, width, height),
      readFrame: (int index, OverlappedTile region) async => _readFixture(
        frames[index],
        coverages[index],
        width,
        region,
      ),
    );

    Float64RgbTileStore? sum;
    Float64RgbTileStore? weight;
    try {
      for (int index = 0; index < frameCount; index++) {
        final merged = await mergeIntoRollingWeightedAverageAccumulator(
          width: width,
          height: height,
          readFrame: (OverlappedTile region) async => _readFixture(
            frames[index],
            coverages[index],
            width,
            region,
          ),
          frameWeight: weights[index] / maximumWeight,
          outputWeightedSumStoreFactory:
              FileBackedFloat64RgbTileStore.createTemporary,
          outputWeightSumStoreFactory:
              FileBackedFloat64RgbTileStore.createTemporary,
          previousWeightedSum: sum,
          previousWeightSum: weight,
          tileSize: 512,
          maximumPixelsPerBand: 8192,
        );
        await sum?.dispose();
        await weight?.dispose();
        sum = merged.weightedSum;
        weight = merged.weightSum;
      }
      final RollingWeightedAverageFinalized rolling =
          await finalizeRollingWeightedAverageWithContributions(
        weightedSum: sum!,
        weightSum: weight!,
        outputStoreFactory: FileBackedLinearRgbTileStore.createTemporary,
        contributionStoreFactory:
            FileBackedLinearContributionTileStore.createTemporary,
        tileSize: 512,
      );
      try {
        final LinearRgbTile result = await rolling.rgb.readRegion(
          x: 0,
          y: 0,
          width: width,
          height: height,
        );
        expect(result.interleavedRgb, batch.tile.interleavedRgb);
        final contribution = await rolling.contributions!.readRegion(
          x: 0,
          y: 0,
          width: width,
          height: height,
        );
        for (int i = 0; i < contribution.interleavedCounts.length; i++) {
          expect(
            contribution.interleavedCounts[i] > 0,
            batch.contributingSamples[i] > 0,
          );
        }
      } finally {
        await rolling.contributions?.dispose();
        await rolling.rgb.dispose();
      }
    } finally {
      await weight?.dispose();
      await sum?.dispose();
    }
  });

  test('durable accumulator restores previous generation after torn current',
      () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'mobile-stack-rolling-checkpoint-test-',
    );
    final String statusPath =
        '${directory.path}${Platform.pathSeparator}status.json';
    final RollingWeightedAverageCheckpointStore store =
        RollingWeightedAverageCheckpointStore(
      statusPath: statusPath,
      identity: 'fixture-v1',
    );
    Float64RgbTileStore? sum;
    Float64RgbTileStore? weight;
    try {
      for (int generation = 1; generation <= 2; generation++) {
        final merged = await mergeIntoRollingWeightedAverageAccumulator(
          width: 2,
          height: 2,
          readFrame: (OverlappedTile region) async => CoveredLinearRgbTile(
            tile: LinearRgbTile(
              x: region.outputX,
              y: region.outputY,
              width: region.outputWidth,
              height: region.outputHeight,
              interleavedRgb: Float32List.fromList(
                List<double>.filled(
                    region.outputWidth * region.outputHeight * 3,
                    generation.toDouble()),
              ),
            ),
            coverage: Uint8List.fromList(
                List<int>.filled(region.outputWidth * region.outputHeight, 1)),
          ),
          frameWeight: 1,
          outputWeightedSumStoreFactory: store.createWeightedSumStore,
          outputWeightSumStoreFactory: store.createWeightSumStore,
          previousWeightedSum: sum,
          previousWeightSum: weight,
          tileSize: 2,
        );
        if (sum != null) await store.closeRetainingStore(sum);
        if (weight != null) await store.closeRetainingStore(weight);
        await store.publishCommitted(
          weightedSum: merged.weightedSum,
          weightSum: merged.weightSum,
          committedItems: generation,
        );
        sum = merged.weightedSum;
        weight = merged.weightSum;
      }
      await store.closeRetainingStore(sum!);
      await store.closeRetainingStore(weight!);
      sum = null;
      weight = null;
      final File current = File(
        '${directory.path}${Platform.pathSeparator}'
        'rolling_weighted_average_checkpoints_v1'
        '${Platform.pathSeparator}current.json',
      );
      await current.writeAsString('{torn', flush: true);

      final RollingWeightedAverageCheckpoint? restored =
          await RollingWeightedAverageCheckpointStore(
        statusPath: statusPath,
        identity: 'fixture-v1',
      ).restore();
      expect(restored, isNotNull);
      expect(restored!.committedItems, 1);
      await restored.weightedSum.closeRetainingFile();
      await restored.weightSum.closeRetainingFile();
    } finally {
      await weight?.dispose();
      await sum?.dispose();
      await store.cleanupAll();
      if (await directory.exists()) await directory.delete(recursive: true);
    }
  });
}
