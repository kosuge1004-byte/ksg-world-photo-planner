import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile_store.dart';
import 'package:mobile_stack/core/meteor/streak_shape.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_decoder_registry.dart';
import 'package:mobile_stack/core/session/star_trail_pipeline.dart';
import 'package:mobile_stack/core/stacking/tiled_lighten_blend_combiner.dart';

import 'support/in_memory_rgb_tile_store.dart';
import 'support/recording_rgb_tile_store.dart';

/// Tests [combineDecodedFrames] directly against hand-built fake tile
/// stores — see `star_trail_pipeline.dart`'s own doc comment for why
/// [runStarTrailPipeline]'s `JobScheduler`-driven orchestration is *not*
/// covered here: it needs a real or fake decoder pipeline wired end to
/// end, which is a larger integration-testing effort left as a known,
/// explicitly-acknowledged gap rather than attempted blind.

InMemoryRgbTileStore _constantFrame(
  int width,
  int height,
  double red,
  double green,
  double blue,
) {
  final Float32List rgb = Float32List(width * height * 3);
  for (int pixel = 0; pixel < width * height; pixel++) {
    rgb[pixel * 3] = red;
    rgb[pixel * 3 + 1] = green;
    rgb[pixel * 3 + 2] = blue;
  }
  return InMemoryRgbTileStore(
    width: width,
    height: height,
    interleavedRgb: rgb,
  );
}

final class _TestStreak implements StreakShape {
  const _TestStreak({required this.endpoints, required this.width});

  @override
  final List<({double x, double y})> endpoints;

  @override
  final double width;
}

void main() {
  test('2フレームの比較明合成が各チャンネル独立に最大値を取る', () async {
    final InMemoryRgbTileStore frameA = _constantFrame(4, 4, 1, 9, 2);
    final InMemoryRgbTileStore frameB = _constantFrame(4, 4, 5, 3, 8);
    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();

    final LinearRgbTileStore result = await combineDecodedFrames(
      frameStores: <LinearRgbTileStore>[frameA, frameB],
      outputTileStoreFactory: outputFactory.call,
      tileSize: 512, // 1タイルで収まる
    );

    final RecordingRgbTileStore recorded = result as RecordingRgbTileStore;
    expect(recorded.isCommitted, isTrue);
    expect(recorded.writtenTiles, hasLength(1));
    final tile = recorded.writtenTiles.single;
    for (int pixel = 0; pixel < 16; pixel++) {
      expect(tile.interleavedRgb[pixel * 3], closeTo(5, 1e-6)); // max(1,5)
      expect(
        tile.interleavedRgb[pixel * 3 + 1],
        closeTo(9, 1e-6),
      ); // max(9,3)
      expect(
        tile.interleavedRgb[pixel * 3 + 2],
        closeTo(8, 1e-6),
      ); // max(2,8)
    }
  });

  test('除外光跡は該当フレームだけcoverageから外し他フレームの実画素を使う', () async {
    const int width = 8;
    const int height = 8;
    final InMemoryRgbTileStore background =
        _constantFrame(width, height, 2, 2, 2);
    final InMemoryRgbTileStore brightFrame =
        _constantFrame(width, height, 10, 10, 10);
    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();

    final LinearRgbTileStore result = await combineDecodedFrames(
      frameStores: <LinearRgbTileStore>[background, brightFrame],
      outputTileStoreFactory: outputFactory.call,
      excludedStreaksByFrame: <List<StreakShape>>[
        const <StreakShape>[],
        <StreakShape>[
          const _TestStreak(
            endpoints: <({double x, double y})>[
              (x: 0, y: 4),
              (x: 7, y: 4),
            ],
            width: 1,
          ),
        ],
      ],
      tileSize: 512,
    );

    final RecordingRgbTileStore recorded = result as RecordingRgbTileStore;
    final tile = recorded.writtenTiles.single;
    // The masked aircraft/satellite band uses the other frame's real pixels.
    final int maskedBase = (4 * width + 4) * 3;
    expect(tile.interleavedRgb[maskedBase], closeTo(2, 1e-6));
    // A distant pixel remains ordinary lighten blend.
    final int normalBase = (0 * width + 0) * 3;
    expect(tile.interleavedRgb[normalBase], closeTo(10, 1e-6));
  });

  test('画像がタイルサイズより大きい場合は複数タイルに分割して正しく合成する', () async {
    const int width = 20;
    const int height = 15;
    final InMemoryRgbTileStore frameA = _constantFrame(width, height, 2, 2, 2);
    final InMemoryRgbTileStore frameB = _constantFrame(width, height, 6, 6, 6);
    final RecordingRgbTileStoreFactory outputFactory =
        RecordingRgbTileStoreFactory();

    final List<double> progressValues = <double>[];
    final LinearRgbTileStore result = await combineDecodedFrames(
      frameStores: <LinearRgbTileStore>[frameA, frameB],
      outputTileStoreFactory: outputFactory.call,
      tileSize: 8, // 20x15 を複数タイルに強制分割
      reportProgress: progressValues.add,
    );

    final RecordingRgbTileStore recorded = result as RecordingRgbTileStore;
    expect(recorded.isCommitted, isTrue);
    // tileSize=8 で 20x15 は 3x2=6 タイルに分割されるはず。
    expect(recorded.writtenTiles, hasLength(6));
    for (final tile in recorded.writtenTiles) {
      expect(tile.interleavedRgb, everyElement(closeTo(6, 1e-6)));
    }
    expect(progressValues.last, closeTo(1, 1e-9));
    for (int i = 1; i < progressValues.length; i++) {
      expect(progressValues[i], greaterThanOrEqualTo(progressValues[i - 1]));
    }
  });

  test('フレーム数が2未満だとArgumentErrorを投げる', () async {
    final InMemoryRgbTileStore frame = _constantFrame(4, 4, 1, 1, 1);
    expect(
      () => combineDecodedFrames(
        frameStores: <LinearRgbTileStore>[frame],
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('フレーム間で寸法が異なるとArgumentErrorを投げる', () async {
    final InMemoryRgbTileStore frameA = _constantFrame(4, 4, 1, 1, 1);
    final InMemoryRgbTileStore frameB = _constantFrame(5, 5, 1, 1, 1);
    expect(
      () => combineDecodedFrames(
        frameStores: <LinearRgbTileStore>[frameA, frameB],
        outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test(
    'キャンセルされるとTiledLightenBlendCancelledを投げ、出力ストアはabortされる',
    () async {
      const int width = 16;
      const int height = 16;
      final InMemoryRgbTileStore frameA =
          _constantFrame(width, height, 1, 1, 1);
      final InMemoryRgbTileStore frameB =
          _constantFrame(width, height, 2, 2, 2);
      final RecordingRgbTileStoreFactory outputFactory =
          RecordingRgbTileStoreFactory();

      int callCount = 0;
      await expectLater(
        combineDecodedFrames(
          frameStores: <LinearRgbTileStore>[frameA, frameB],
          outputTileStoreFactory: outputFactory.call,
          tileSize: 4, // 複数タイルに分割してキャンセルの機会を作る
          isCancelled: () {
            callCount += 1;
            return callCount > 1;
          },
        ),
        throwsA(isA<TiledLightenBlendCancelled>()),
      );
      expect(outputFactory.latest!.aborted, isTrue);
    },
  );

  test(
    'keepHighestとminimumCoveringFramesがTiledLightenBlendCombinerへ転送される',
    () async {
      final List<InMemoryRgbTileStore> frames = <InMemoryRgbTileStore>[
        for (final double value in <double>[0.5, 0.5, 99, 0.5, 0.5, 0.5])
          _constantFrame(2, 2, value, value, value),
      ];
      final RecordingRgbTileStoreFactory outputFactory =
          RecordingRgbTileStoreFactory();

      final LinearRgbTileStore result = await combineDecodedFrames(
        frameStores: frames.cast<LinearRgbTileStore>(),
        outputTileStoreFactory: outputFactory.call,
        keepHighest: 2,
        minimumCoveringFrames: 2,
        tileSize: 512,
      );
      final RecordingRgbTileStore recorded = result as RecordingRgbTileStore;
      expect(
        recorded.writtenTiles.single.interleavedRgb,
        everyElement(closeTo(0.5, 1e-6)),
      );
    },
  );

  test(
    'runStarTrailPipeline: masterDarkとdarkFramePathsを同時に指定すると'
    'ArgumentErrorを投げる(Work110)',
    () async {
      final StarTrailFrameDecodingConfig decodingConfig =
          StarTrailFrameDecodingConfig(
        decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
      );
      final LinearRawMosaic fakeMasterDark = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List(4),
      );
      await expectLater(
        runStarTrailPipeline(
          sourcePaths: <String>['a.arw', 'b.arw'],
          decodingConfig: decodingConfig,
          outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
          masterDark: fakeMasterDark,
          darkFramePaths: const <String>['dark0.arw'],
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );

  test(
    'runStarTrailPipeline: masterFlatとflatFramePathsを同時に指定すると'
    'ArgumentErrorを投げる(Work110)',
    () async {
      final StarTrailFrameDecodingConfig decodingConfig =
          StarTrailFrameDecodingConfig(
        decoderRegistry: RawDecoderRegistry(const <RawDecoder>[]),
      );
      final LinearRawMosaic fakeMasterFlat = LinearRawMosaic(
        width: 2,
        height: 2,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List.fromList(<double>[1, 1, 1, 1]),
      );
      await expectLater(
        runStarTrailPipeline(
          sourcePaths: <String>['a.arw', 'b.arw'],
          decodingConfig: decodingConfig,
          outputTileStoreFactory: RecordingRgbTileStoreFactory().call,
          masterFlat: fakeMasterFlat,
          flatFramePaths: const <String>['flat0.arw'],
        ),
        throwsA(isA<ArgumentError>()),
      );
    },
  );
}
