import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

import 'support/in_memory_rgb_tile_store.dart';

Float32List _frame(int width, int height) {
  final Float32List frame = Float32List(width * height * 3);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final double value = x + y * 10.0;
      final int base = (y * width + x) * 3;
      frame[base] = value;
      frame[base + 1] = value + 100;
      frame[base + 2] = value + 200;
    }
  }
  return frame;
}

OverlappedTile _outputTile(int x, int y, int width, int height) =>
    OverlappedTile(
      outputX: x,
      outputY: y,
      outputWidth: width,
      outputHeight: height,
      inputX: x,
      inputY: y,
      inputWidth: width,
      inputHeight: height,
    );

void main() {
  test('identityは必要な小領域だけを読みRGBを完全一致で返す', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 6,
      height: 5,
      interleavedRgb: _frame(6, 5),
    );
    final CoveredLinearRgbTile result =
        await const TiledAffineRgbResampler().sampleTile(
      source: store,
      outputTile: _outputTile(2, 1, 3, 2),
      outputImageWidth: 6,
      outputImageHeight: 5,
      transform: AffineSamplingTransform.identity(),
    );

    expect(store.readRequests, hasLength(1));
    final RgbReadRequest read = store.readRequests.single;
    expect((read.x, read.y, read.width, read.height), (2, 1, 4, 3));
    for (int y = 0; y < 2; y++) {
      for (int x = 0; x < 3; x++) {
        final double expected = (x + 2) + (y + 1) * 10.0;
        expect(result.tile.channelAt(x, y, 0), expected);
        expect(result.tile.channelAt(x, y, 1), expected + 100);
        expect(result.tile.channelAt(x, y, 2), expected + 200);
        expect(result.isCoveredAt(x, y), isTrue);
      }
    }
  });

  test('回転と並進を単一の逆写像補間で適用する', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 5,
      height: 5,
      interleavedRgb: _frame(5, 5),
    );
    final CoveredLinearRgbTile translated =
        await const TiledAffineRgbResampler().sampleTile(
      source: store,
      outputTile: _outputTile(1, 1, 1, 1),
      outputImageWidth: 5,
      outputImageHeight: 5,
      transform: AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: 0.5,
        sourceOffsetY: 0.5,
        centerX: 2,
        centerY: 2,
      ),
    );
    expect(translated.tile.channelAt(0, 0, 0), closeTo(16.5, 1e-6));

    final CoveredLinearRgbTile rotated =
        await const TiledAffineRgbResampler().sampleTile(
      source: store,
      outputTile: _outputTile(3, 2, 1, 1),
      outputImageWidth: 5,
      outputImageHeight: 5,
      transform: AffineSamplingTransform.similarity(
        rotationDegrees: 90,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
        centerX: 2,
        centerY: 2,
      ),
    );
    expect(rotated.tile.channelAt(0, 0, 0), closeTo(32, 1e-6));
  });

  test('画像外をcoverage 0として端画素を複製しない', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: _frame(4, 4),
    );
    final CoveredLinearRgbTile result =
        await const TiledAffineRgbResampler().sampleTile(
      source: store,
      outputTile: _outputTile(0, 1, 2, 1),
      outputImageWidth: 4,
      outputImageHeight: 4,
      transform: AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: -1,
        sourceOffsetY: 0,
        centerX: 0,
        centerY: 0,
      ),
    );

    expect(result.isCoveredAt(0, 0), isFalse);
    expect(result.tile.channelAt(0, 0, 0), 0);
    expect(result.isCoveredAt(1, 0), isTrue);
    expect(result.tile.channelAt(1, 0, 0), 10);
  });

  test('タイル全体が画像外ならソースを読まない', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: _frame(4, 4),
    );
    final CoveredLinearRgbTile result =
        await const TiledAffineRgbResampler().sampleTile(
      source: store,
      outputTile: _outputTile(0, 0, 2, 2),
      outputImageWidth: 4,
      outputImageHeight: 4,
      transform: AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: 100,
        sourceOffsetY: 100,
        centerX: 0,
        centerY: 0,
      ),
    );

    expect(store.readRequests, isEmpty);
    expect(result.coverage, everyElement(0));
  });

  test('行処理前のキャンセルを専用例外で停止する', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: _frame(4, 4),
    );

    await expectLater(
      const TiledAffineRgbResampler().sampleTile(
        source: store,
        outputTile: _outputTile(0, 0, 2, 2),
        outputImageWidth: 4,
        outputImageHeight: 4,
        transform: AffineSamplingTransform.identity(),
        isCancelled: () => true,
      ),
      throwsA(isA<AffineRgbResamplingCancelled>()),
    );
  });

  test('非有限な変換係数を拒否する', () {
    expect(
      () => AffineSamplingTransform(
        m00: double.nan,
        m01: 0,
        m02: 0,
        m10: 0,
        m11: 1,
        m12: 0,
      ),
      throwsArgumentError,
    );
  });

  test('有限係数でも座標計算がオーバーフローすれば拒否する', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: _frame(4, 4),
    );

    await expectLater(
      const TiledAffineRgbResampler().sampleTile(
        source: store,
        outputTile: _outputTile(2, 2, 2, 2),
        outputImageWidth: 4,
        outputImageHeight: 4,
        transform: AffineSamplingTransform(
          m00: 1e308,
          m01: 1e308,
          m02: 1e308,
          m10: 0,
          m11: 1,
          m12: 0,
        ),
      ),
      throwsStateError,
    );
    expect(store.readRequests, isEmpty);
  });

  test(
    'bicubicはidentity変換時に整数格子点でオリジナル値を厳密に再現する',
    () async {
      // Catmull-Romスプラインは補間性を持つため(近似ではなく)、整数格子点
      // では厳密に元の値を再現するはず -- Node参照実装の同名テストと同じ性質。
      final InMemoryRgbTileStore store = InMemoryRgbTileStore(
        width: 8,
        height: 8,
        interleavedRgb: _frame(8, 8),
      );
      const TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
        interpolation: ResamplingInterpolation.bicubic,
      );
      final CoveredLinearRgbTile result = await resampler.sampleTile(
        source: store,
        outputTile: _outputTile(2, 2, 3, 3),
        outputImageWidth: 8,
        outputImageHeight: 8,
        transform: AffineSamplingTransform.identity(),
      );
      for (int y = 0; y < 3; y++) {
        for (int x = 0; x < 3; x++) {
          final double expected = (x + 2) + (y + 2) * 10.0;
          expect(
            result.tile.channelAt(x, y, 0),
            closeTo(expected, 1e-6),
          );
        }
      }
    },
  );

  test('bicubicは1ピクセル余分な読み取りマージンを要求する', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 10,
      height: 10,
      interleavedRgb: _frame(10, 10),
    );
    const TiledAffineRgbResampler bilinearResampler = TiledAffineRgbResampler();
    const TiledAffineRgbResampler bicubicResampler = TiledAffineRgbResampler(
      interpolation: ResamplingInterpolation.bicubic,
    );
    await bilinearResampler.sampleTile(
      source: store,
      outputTile: _outputTile(3, 3, 2, 2),
      outputImageWidth: 10,
      outputImageHeight: 10,
      transform: AffineSamplingTransform.identity(),
    );
    final RgbReadRequest bilinearRead = store.readRequests.single;
    store.readRequests.clear();

    await bicubicResampler.sampleTile(
      source: store,
      outputTile: _outputTile(3, 3, 2, 2),
      outputImageWidth: 10,
      outputImageHeight: 10,
      transform: AffineSamplingTransform.identity(),
    );
    final RgbReadRequest bicubicRead = store.readRequests.single;

    // bicubicは4x4近傍が必要なため、各辺で1ピクセル分広く読み取るはず。
    expect(bicubicRead.width, bilinearRead.width + 2);
    expect(bicubicRead.height, bilinearRead.height + 2);
    expect(bicubicRead.x, bilinearRead.x - 1);
    expect(bicubicRead.y, bilinearRead.y - 1);
  });

  test('bicubicは境界付近でも有限な値を返しクラッシュしない', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 4,
      height: 4,
      interleavedRgb: _frame(4, 4),
    );
    const TiledAffineRgbResampler resampler = TiledAffineRgbResampler(
      interpolation: ResamplingInterpolation.bicubic,
    );
    final CoveredLinearRgbTile result = await resampler.sampleTile(
      source: store,
      outputTile: _outputTile(0, 0, 4, 4),
      outputImageWidth: 4,
      outputImageHeight: 4,
      transform: AffineSamplingTransform.identity(),
    );
    for (final double value in result.tile.interleavedRgb) {
      expect(value.isFinite, isTrue);
    }
    expect(result.coverage, everyElement(1));
  });

  test(
    'デフォルトはbilinearのまま(既存呼び出し元との後方互換性)',
    () async {
      final InMemoryRgbTileStore store = InMemoryRgbTileStore(
        width: 6,
        height: 5,
        interleavedRgb: _frame(6, 5),
      );
      expect(
        const TiledAffineRgbResampler().interpolation,
        ResamplingInterpolation.bilinear,
      );
      // identity変換ではbilinearもbicubicも整数格子点で同一の厳密値を
      // 返すため、デフォルトコンストラクタが実際にbilinear経路を通る
      // ことは、読み取りマージンが拡張されていないこと(上のテストで
      // 検証済み)と合わせて、この呼び出しが例外なく完了することで
      // 間接的に確認する。
      final CoveredLinearRgbTile result =
          await const TiledAffineRgbResampler().sampleTile(
        source: store,
        outputTile: _outputTile(0, 0, 6, 5),
        outputImageWidth: 6,
        outputImageHeight: 5,
        transform: AffineSamplingTransform.identity(),
      );
      expect(result.coverage, everyElement(1));
    },
  );

  test('局所残差補正をRGB再サンプリング座標へ適用する', () async {
    final InMemoryRgbTileStore store = InMemoryRgbTileStore(
      width: 8,
      height: 8,
      interleavedRgb: _frame(8, 8),
    );
    final List<LocalResidualMatch> matches = <LocalResidualMatch>[
      for (final ({double x, double y}) p in <({double x, double y})>[
        (x: 1, y: 1),
        (x: 3, y: 1),
        (x: 5, y: 1),
        (x: 1, y: 3),
        (x: 3, y: 3),
        (x: 5, y: 3),
        (x: 1, y: 5),
        (x: 3, y: 5),
        (x: 5, y: 5),
      ])
        LocalResidualMatch(
          referenceX: p.x,
          referenceY: p.y,
          residualX: 1,
          residualY: 0,
        ),
    ];
    final LocalResidualCorrectionField field = fitLocalResidualCorrectionField(
      matches,
      minimumMatchesPerCoefficient: 1,
      maximumCorrectionMagnitude: 2,
    );
    expect(field.fitted, isTrue);

    final CoveredLinearRgbTile result =
        await const TiledAffineRgbResampler().sampleTile(
      source: store,
      outputTile: _outputTile(2, 2, 1, 1),
      outputImageWidth: 8,
      outputImageHeight: 8,
      transform: AffineSamplingTransform.identity(),
      localCorrectionField: field,
    );

    // Identity-only would sample (2,2) => 22.  The fitted +1px local
    // residual must instead sample source (3,2) => 23.
    expect(result.isCoveredAt(0, 0), isTrue);
    expect(result.tile.channelAt(0, 0, 0), closeTo(23, 1e-5));
  });
}
