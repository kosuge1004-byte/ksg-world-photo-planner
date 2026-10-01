import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/file_backed_linear_contribution_tile_store.dart';
import 'package:mobile_stack/core/image/file_backed_linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/image/linear_contribution_tile.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';
import 'package:mobile_stack/core/stacking/tiled_kappa_sigma_combiner.dart';
import 'package:mobile_stack/core/stacking/tiled_registered_rgb_stack_pipeline.dart';
import 'package:mobile_stack/core/stacking/tiled_registered_rgb_stacker.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

import 'support/in_memory_rgb_tile_store.dart';

Float32List _frame(int width, int height) {
  final Float32List rgb = Float32List(width * height * 3);
  for (int index = 0; index < rgb.length; index++) {
    rgb[index] = index / 10;
  }
  return rgb;
}

void main() {
  test('全出力タイルのRGBと生存数を両方commitする', () async {
    const int width = 4;
    const int height = 3;
    final Float32List expected = _frame(width, height);
    final InMemoryRgbTileStore source = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: expected,
    );
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: width,
      imageHeight: height,
      tileSize: 2,
      overlap: 0,
    );
    final List<double> progress = <double>[];
    final TiledRegisteredRgbStackResult result =
        await const TiledRegisteredRgbStackPipeline().run(
      frames: <RegisteredRgbFrame>[
        RegisteredRgbFrame(
          store: source,
          transform: AffineSamplingTransform.identity(),
          weight: 1,
        ),
      ],
      outputImageWidth: width,
      outputImageHeight: height,
      outputPlan: plan,
      reportProgress: progress.add,
    );
    final FileBackedLinearRgbTileStore rgbStore =
        result.rgb as FileBackedLinearRgbTileStore;
    final FileBackedLinearContributionTileStore countStore =
        result.contributions as FileBackedLinearContributionTileStore;
    final String rgbPath = rgbStore.path;
    final String countPath = countStore.path;

    expect(result.rgb.isCommitted, isTrue);
    expect(result.contributions.isCommitted, isTrue);
    final LinearRgbTile rgb = await result.rgb.readRegion(
      x: 0,
      y: 0,
      width: width,
      height: height,
    );
    final LinearContributionTile counts = await result.contributions.readRegion(
      x: 0,
      y: 0,
      width: width,
      height: height,
    );
    expect(rgb.interleavedRgb, orderedEquals(expected));
    expect(counts.interleavedCounts, everyElement(1));
    expect(progress, isNotEmpty);
    expect(progress.last, 1);

    await result.dispose();
    expect(File(rgbPath).existsSync(), isFalse);
    expect(File(countPath).existsSync(), isFalse);
  });

  test('タイル細分化はbicubic最高画質のRGBと生存数を変えない', () async {
    const int width = 9;
    const int height = 7;
    final InMemoryRgbTileStore first = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: _frame(width, height),
    );
    final Float32List shiftedSamples = _frame(width, height);
    for (int index = 0; index < shiftedSamples.length; index++) {
      shiftedSamples[index] += (index % 11) * 0.013;
    }
    final InMemoryRgbTileStore second = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: shiftedSamples,
    );
    final List<RegisteredRgbFrame> frames = <RegisteredRgbFrame>[
      RegisteredRgbFrame(
        store: first,
        transform: AffineSamplingTransform.identity(),
        weight: 1,
      ),
      RegisteredRgbFrame(
        store: second,
        transform: AffineSamplingTransform.similarity(
          rotationDegrees: 0.4,
          sourceOffsetX: 0.25,
          sourceOffsetY: -0.35,
          centerX: width / 2,
          centerY: height / 2,
        ),
        weight: 0.8,
      ),
    ];

    Future<TiledRegisteredRgbStackResult> runWithTileSize(int tileSize) {
      return const TiledRegisteredRgbStackPipeline().run(
        frames: frames,
        outputImageWidth: width,
        outputImageHeight: height,
        outputPlan: OverlappedTilePlan.create(
          imageWidth: width,
          imageHeight: height,
          tileSize: tileSize,
          overlap: 0,
        ),
      );
    }

    final TiledRegisteredRgbStackResult whole = await runWithTileSize(width);
    final TiledRegisteredRgbStackResult split = await runWithTileSize(3);
    try {
      final LinearRgbTile wholeRgb = await whole.rgb.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final LinearRgbTile splitRgb = await split.rgb.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final LinearContributionTile wholeCounts =
          await whole.contributions.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      final LinearContributionTile splitCounts =
          await split.contributions.readRegion(
        x: 0,
        y: 0,
        width: width,
        height: height,
      );
      expect(splitRgb.interleavedRgb, orderedEquals(wholeRgb.interleavedRgb));
      expect(
        splitCounts.interleavedCounts,
        orderedEquals(wholeCounts.interleavedCounts),
      );
    } finally {
      await whole.dispose();
      await split.dispose();
    }
  });

  test('開始前キャンセルは出力ストアを作らない', () async {
    int factoriesCalled = 0;
    final TiledRegisteredRgbStackPipeline pipeline =
        TiledRegisteredRgbStackPipeline(
      rgbStoreFactory: ({
        required int width,
        required int height,
        required OverlappedTilePlan plan,
      }) async {
        factoriesCalled++;
        throw StateError('must not create RGB');
      },
      contributionStoreFactory: ({
        required int width,
        required int height,
        required OverlappedTilePlan plan,
      }) async {
        factoriesCalled++;
        throw StateError('must not create counts');
      },
    );
    final InMemoryRgbTileStore source = InMemoryRgbTileStore(
      width: 2,
      height: 2,
      interleavedRgb: _frame(2, 2),
    );
    await expectLater(
      pipeline.run(
        frames: <RegisteredRgbFrame>[
          RegisteredRgbFrame(
            store: source,
            transform: AffineSamplingTransform.identity(),
            weight: 1,
          ),
        ],
        outputImageWidth: 2,
        outputImageHeight: 2,
        outputPlan: OverlappedTilePlan.create(
          imageWidth: 2,
          imageHeight: 2,
          tileSize: 2,
          overlap: 0,
        ),
        isCancelled: () => true,
      ),
      throwsA(isA<TiledStackingCancelled>()),
    );
    expect(factoriesCalled, 0);
  });

  test('第2ストア生成失敗時に作成済みRGBストアを削除する', () async {
    FileBackedLinearRgbTileStore? createdRgb;
    final TiledRegisteredRgbStackPipeline pipeline =
        TiledRegisteredRgbStackPipeline(
      rgbStoreFactory: ({
        required int width,
        required int height,
        required OverlappedTilePlan plan,
      }) async {
        createdRgb = await FileBackedLinearRgbTileStore.createTemporary(
          width: width,
          height: height,
          plan: plan,
        );
        return createdRgb!;
      },
      contributionStoreFactory: ({
        required int width,
        required int height,
        required OverlappedTilePlan plan,
      }) async {
        throw StateError('count store unavailable');
      },
    );
    final InMemoryRgbTileStore source = InMemoryRgbTileStore(
      width: 2,
      height: 2,
      interleavedRgb: _frame(2, 2),
    );
    await expectLater(
      pipeline.run(
        frames: <RegisteredRgbFrame>[
          RegisteredRgbFrame(
            store: source,
            transform: AffineSamplingTransform.identity(),
            weight: 1,
          ),
        ],
        outputImageWidth: 2,
        outputImageHeight: 2,
        outputPlan: OverlappedTilePlan.create(
          imageWidth: 2,
          imageHeight: 2,
          tileSize: 2,
          overlap: 0,
        ),
      ),
      throwsStateError,
    );
    expect(createdRgb, isNotNull);
    expect(File(createdRgb!.path).existsSync(), isFalse);
  });
}
