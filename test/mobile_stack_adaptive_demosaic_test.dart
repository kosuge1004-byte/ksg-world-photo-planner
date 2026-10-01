import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/demosaic/demosaic_engine.dart';
import 'package:mobile_stack/core/demosaic/demosaic_request.dart';
import 'package:mobile_stack/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/tiles/overlapped_tile_plan.dart';

LinearRawMosaic _mosaicFromRgb(
  int width,
  int height,
  double Function(int x, int y, CfaColor color) value,
) {
  final Float32List samples = Float32List(width * height);
  const CfaPattern pattern = CfaPattern.rggb;
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      samples[y * width + x] = value(x, y, pattern.colorAt(x, y));
    }
  }
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: pattern,
    samples: samples,
  );
}

OverlappedTile _fullTile(LinearRawMosaic mosaic) => OverlappedTile(
      outputX: 0,
      outputY: 0,
      outputWidth: mosaic.width,
      outputHeight: mosaic.height,
      inputX: 0,
      inputY: 0,
      inputWidth: mosaic.width,
      inputHeight: mosaic.height,
    );

void main() {
  test('一定色のRGB比を画像端まで復元する', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      6,
      6,
      (_, __, CfaColor color) => switch (color) {
        CfaColor.red => 0.8,
        CfaColor.green => 0.5,
        CfaColor.blue => 0.2,
      },
    );

    final LinearRgbTile tile =
        await const MobileStackAdaptiveDemosaicEngine().processTile(
      DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
    );

    for (int y = 0; y < tile.height; y++) {
      for (int x = 0; x < tile.width; x++) {
        expect(tile.channelAt(x, y, 0), closeTo(0.8, 1e-6));
        expect(tile.channelAt(x, y, 1), closeTo(0.5, 1e-6));
        expect(tile.channelAt(x, y, 2), closeTo(0.2, 1e-6));
      }
    }
  });

  test('実測CFAの負値と1超ハイライトを変更しない', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      6,
      6,
      (int x, int y, CfaColor color) {
        if (x == 2 && y == 2) return 2;
        if (x == 3 && y == 3) return -0.25;
        return switch (color) {
          CfaColor.red => 0.8,
          CfaColor.green => 0.5,
          CfaColor.blue => 0.2,
        };
      },
    );

    final LinearRgbTile tile =
        await const MobileStackAdaptiveDemosaicEngine().processTile(
      DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
    );

    expect(tile.channelAt(2, 2, 0), 2);
    expect(tile.channelAt(3, 3, 2), -0.25);
  });

  test('無彩色の垂直エッジで偽色を抑える', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      12,
      8,
      (int x, _, __) => x < 6 ? 0.1 : 0.9,
    );

    final LinearRgbTile tile =
        await const MobileStackAdaptiveDemosaicEngine().processTile(
      DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
    );

    for (int y = 2; y < 6; y++) {
      for (int x = 4; x < 8; x++) {
        final double red = tile.channelAt(x, y, 0);
        final double green = tile.channelAt(x, y, 1);
        final double blue = tile.channelAt(x, y, 2);
        expect((red - green).abs(), lessThan(0.25));
        expect((blue - green).abs(), lessThan(0.25));
      }
    }
    expect(tile.channelAt(3, 3, 1), lessThan(tile.channelAt(8, 3, 1)));
  });

  test('分割タイルと全体処理の中央出力が一致する', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      20,
      8,
      (int x, int y, CfaColor color) {
        final double luminance = 0.05 + x * 0.02 + y * 0.01;
        return switch (color) {
          CfaColor.red => luminance * 1.2,
          CfaColor.green => luminance,
          CfaColor.blue => luminance * 0.7,
        };
      },
    );
    const MobileStackAdaptiveDemosaicEngine engine =
        MobileStackAdaptiveDemosaicEngine();
    final LinearRgbTile full = await engine.processTile(
      DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
    );
    final OverlappedTilePlan plan = OverlappedTilePlan.create(
      imageWidth: 20,
      imageHeight: 8,
      tileSize: 11,
      overlap: MobileStackAdaptiveDemosaicEngine.referenceRequiredInputRadius,
    );

    for (final OverlappedTile planned in plan.tiles) {
      final LinearRgbTile part = await engine.processTile(
        DemosaicRequest(mosaic: mosaic, tile: planned),
      );
      for (int localY = 0; localY < part.height; localY++) {
        for (int localX = 0; localX < part.width; localX++) {
          for (int channel = 0; channel < 3; channel++) {
            expect(
              part.channelAt(localX, localY, channel),
              full.channelAt(
                planned.outputX + localX,
                planned.outputY + localY,
                channel,
              ),
            );
          }
        }
      }
    }
  });

  test('必要半径4に満たない内部タイル入力を拒否する', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      20,
      20,
      (_, __, ___) => 0.5,
    );
    final OverlappedTile insufficient = OverlappedTilePlan.create(
      imageWidth: 20,
      imageHeight: 20,
      tileSize: 10,
      overlap: 3,
    ).tiles[1];

    await expectLater(
      const MobileStackAdaptiveDemosaicEngine().processTile(
        DemosaicRequest(mosaic: mosaic, tile: insufficient),
      ),
      throwsArgumentError,
    );
  });

  test('孤立した色差スペックルを隣接画素へ漏らさない', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      12,
      10,
      (int x, int y, CfaColor color) {
        const double base = 0.5;
        if (x == 5 && y == 4) return base + 0.3;
        return base;
      },
    );

    final LinearRgbTile tile =
        await const MobileStackAdaptiveDemosaicEngine().processTile(
      DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
    );

    expect(tile.channelAt(4, 4, 0), closeTo(0.5, 1e-3));
    expect(tile.channelAt(4, 4, 2), closeTo(0.5, 1e-3));
  });

  test('孤立した高輝度点（星）を平滑化で減光しない', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      14,
      10,
      (int x, int y, __) => (x == 6 && y == 5) ? 1.0 : 0.05,
    );

    final LinearRgbTile tile =
        await const MobileStackAdaptiveDemosaicEngine().processTile(
      DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
    );

    expect(tile.channelAt(6, 5, 0), greaterThan(0.95));
    expect(tile.channelAt(6, 5, 2), greaterThan(0.95));
  });

  test('advanced directional analysis resolves a diagonal neutral edge',
      () async {
    const int width = 32;
    const int height = 32;
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      width,
      height,
      (int x, int y, _) => x + y < 31 ? 0.08 : 0.88,
    );
    final LinearRgbTile tile =
        await const MobileStackAdaptiveDemosaicEngine().processTile(
      DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
    );
    double squaredError = 0;
    int compared = 0;
    for (int y = 4; y < height - 4; y++) {
      for (int x = 4; x < width - 4; x++) {
        final double expected = x + y < 31 ? 0.08 : 0.88;
        for (int channel = 0; channel < 3; channel++) {
          final double difference = tile.channelAt(x, y, channel) - expected;
          squaredError += difference * difference;
          compared++;
        }
      }
    }
    expect(squaredError / compared, lessThan(0.002));
  });

  test('行処理前のキャンセル要求を専用例外で停止する', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      4,
      4,
      (_, __, ___) => 0.5,
    );

    await expectLater(
      const MobileStackAdaptiveDemosaicEngine().processTile(
        DemosaicRequest(
          mosaic: mosaic,
          tile: _fullTile(mosaic),
          isCancelled: () => true,
        ),
      ),
      throwsA(isA<DemosaicProcessingCancelled>()),
    );
  });
  test('非有限CFA入力を黒などへ捏造せず拒否する', () async {
    final LinearRawMosaic mosaic = _mosaicFromRgb(
      6,
      6,
      (_, __, ___) => 0.5,
    );
    mosaic.samples[7] = double.nan;

    await expectLater(
      const MobileStackAdaptiveDemosaicEngine().processTile(
        DemosaicRequest(mosaic: mosaic, tile: _fullTile(mosaic)),
      ),
      throwsArgumentError,
    );
  });
}
