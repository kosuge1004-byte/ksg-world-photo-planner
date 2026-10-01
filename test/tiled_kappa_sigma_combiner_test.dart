import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/stacking/tiled_kappa_sigma_combiner.dart';
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

Float32List _constantFrame(
  int width,
  int height,
  double red,
  double green,
  double blue,
) {
  final Float32List frame = Float32List(width * height * 3);
  for (int pixel = 0; pixel < width * height; pixel++) {
    final int base = pixel * 3;
    frame[base] = red;
    frame[base + 1] = green;
    frame[base + 2] = blue;
  }
  return frame;
}

CoveredRgbRegionReader _reader({
  required int width,
  required int height,
  required List<Float32List> frames,
  List<Uint8List>? coverages,
  List<OverlappedTile>? requests,
}) {
  return (int frameIndex, OverlappedTile region) async {
    if (region.outputX < 0 ||
        region.outputY < 0 ||
        region.outputX + region.outputWidth > width ||
        region.outputY + region.outputHeight > height) {
      throw RangeError('Requested fixture region is outside the frame.');
    }
    requests?.add(region);
    final Float32List rgb = Float32List(
      region.outputWidth * region.outputHeight * 3,
    );
    final Uint8List coverage = Uint8List(
      region.outputWidth * region.outputHeight,
    );
    for (int localY = 0; localY < region.outputHeight; localY++) {
      for (int localX = 0; localX < region.outputWidth; localX++) {
        final int sourcePixel =
            (region.outputY + localY) * width + region.outputX + localX;
        final int destinationPixel = localY * region.outputWidth + localX;
        rgb.setRange(
          destinationPixel * 3,
          destinationPixel * 3 + 3,
          frames[frameIndex],
          sourcePixel * 3,
        );
        coverage[destinationPixel] = coverages?[frameIndex][sourcePixel] ?? 1;
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
      coverage: coverage,
    );
  };
}

void main() {
  test('上限内では位置合わせ済みバンドを各フレーム1回だけ読む', () async {
    final List<Float32List> frames = <Float32List>[
      for (final double value in <double>[1, 1, 1, 9])
        _constantFrame(2, 2, value, value, value),
    ];
    final List<OverlappedTile> requests = <OverlappedTile>[];
    await const TiledKappaSigmaCombiner(
      robustSmallStackInitialization: true,
    ).combineTile(
      frameCount: frames.length,
      frameWeights: const <double>[1, 1, 1, 1],
      outputTile: _region(0, 0, 2, 2),
      readFrame: _reader(
        width: 2,
        height: 2,
        frames: frames,
        requests: requests,
      ),
    );

    expect(requests, hasLength(frames.length));
  });

  test('coverage内のフレームをFP64重み付き平均する', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(2, 2, 1, 2, 3),
      _constantFrame(2, 2, 3, 4, 5),
    ];
    final RejectionStackedRgbTile result =
        await const TiledKappaSigmaCombiner().combineTile(
      frameCount: frames.length,
      frameWeights: const <double>[1, 3],
      outputTile: _region(0, 0, 2, 2),
      readFrame: _reader(width: 2, height: 2, frames: frames),
    );

    expect(result.tile.channelAt(0, 0, 0), closeTo(2.5, 1e-6));
    expect(result.tile.channelAt(0, 0, 1), closeTo(3.5, 1e-6));
    expect(result.tile.channelAt(0, 0, 2), closeTo(4.5, 1e-6));
    expect(result.contributingSamples, everyElement(2));
  });

  test('反復Kappa-Sigmaで単発外れ値を棄却する', () async {
    final List<Float32List> frames = <Float32List>[
      for (final double value in <double>[1, 1, 1, 1, 10])
        _constantFrame(1, 1, value, value, value),
    ];
    final RejectionStackedRgbTile result =
        await const TiledKappaSigmaCombiner(kappa: 1).combineTile(
      frameCount: frames.length,
      frameWeights: List<double>.filled(frames.length, 1),
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.tile.interleavedRgb, everyElement(closeTo(1, 1e-6)));
    expect(result.contributingSamples, everyElement(4));
  });

  test('外れ値除去OFFでは単発光跡相当の値を棄却せず平均へ残す', () async {
    final List<Float32List> frames = <Float32List>[
      for (final double value in <double>[1, 1, 1, 1, 10])
        _constantFrame(1, 1, value, value, value),
    ];
    final RejectionStackedRgbTile result = await const TiledKappaSigmaCombiner(
      kappa: 1,
      robustSmallStackInitialization: true,
      enableOutlierRejection: false,
    ).combineTile(
      frameCount: frames.length,
      frameWeights: List<double>.filled(frames.length, 1),
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.tile.interleavedRgb, everyElement(closeTo(2.8, 1e-6)));
    expect(result.contributingSamples, everyElement(5));
  });

  test('coverage 0を黒画素として平均へ混ぜない', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 2, 3, 4),
      _constantFrame(1, 1, 100, 100, 100),
    ];
    final List<Uint8List> coverage = <Uint8List>[
      Uint8List.fromList(<int>[1]),
      Uint8List.fromList(<int>[0]),
    ];
    final RejectionStackedRgbTile result =
        await const TiledKappaSigmaCombiner().combineTile(
      frameCount: 2,
      frameWeights: const <double>[1, 1],
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(
        width: 1,
        height: 1,
        frames: frames,
        coverages: coverage,
      ),
    );

    expect(result.tile.interleavedRgb, orderedEquals(<double>[2, 3, 4]));
    expect(result.contributingSamples, everyElement(1));
  });

  test('棄却数をRGBチャンネルごとに保持する', () async {
    final List<Float32List> frames = <Float32List>[
      for (int index = 0; index < 4; index++) _constantFrame(1, 1, 1, 2, 3),
      _constantFrame(1, 1, 1, 2, 30),
    ];
    final RejectionStackedRgbTile result =
        await const TiledKappaSigmaCombiner(kappa: 1).combineTile(
      frameCount: frames.length,
      frameWeights: List<double>.filled(frames.length, 1),
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.contributingSamples, orderedEquals(<int>[5, 5, 4]));
    expect(result.tile.interleavedRgb, orderedEquals(<double>[1, 2, 3]));
  });

  test('RGB同期棄却では1フレームを3チャンネルまとめて除外する', () async {
    final List<Float32List> frames = <Float32List>[
      for (int index = 0; index < 4; index++) _constantFrame(1, 1, 1, 2, 3),
      _constantFrame(1, 1, 1, 2, 30),
    ];
    final RejectionStackedRgbTile result = await const TiledKappaSigmaCombiner(
      kappa: 1,
      minimumSurvivingFrames: 2,
      synchronizeRgbRejection: true,
    ).combineTile(
      frameCount: frames.length,
      frameWeights: List<double>.filled(frames.length, 1),
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.contributingSamples, orderedEquals(<int>[4, 4, 4]));
    expect(result.tile.interleavedRgb, orderedEquals(<double>[1, 2, 3]));
  });

  test('RGB同期後の共通生存数が最低数未満なら全coverageへ安全に戻す', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 10, 1, 1),
      _constantFrame(1, 1, 1, 10, 1),
      _constantFrame(1, 1, 1, 1, 10),
    ];
    final RejectionStackedRgbTile result = await const TiledKappaSigmaCombiner(
      kappa: 1,
      minimumSurvivingFrames: 2,
      robustSmallStackInitialization: true,
      synchronizeRgbRejection: true,
    ).combineTile(
      frameCount: frames.length,
      frameWeights: const <double>[1, 1, 1],
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.contributingSamples, orderedEquals(<int>[3, 3, 3]));
    expect(result.tile.interleavedRgb, everyElement(closeTo(4, 1e-6)));
  });

  test('出力タイルを設定上限以下の行バンドだけで読む', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(4, 4, 1, 1, 1),
      _constantFrame(4, 4, 2, 2, 2),
    ];
    final List<OverlappedTile> requests = <OverlappedTile>[];
    await const TiledKappaSigmaCombiner(maximumPixelsPerBand: 8).combineTile(
      frameCount: 2,
      frameWeights: const <double>[1, 1],
      outputTile: _region(0, 0, 4, 4),
      readFrame: _reader(
        width: 4,
        height: 4,
        frames: frames,
        requests: requests,
      ),
    );

    expect(requests, isNotEmpty);
    expect(requests.every((OverlappedTile tile) => tile.outputHeight <= 2),
        isTrue);
    expect(requests.map((OverlappedTile tile) => tile.outputY).toSet(),
        <int>{0, 2});
  });

  test('最低生存数を割る棄却を適用しない', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 0, 0, 0),
      _constantFrame(1, 1, 10, 10, 10),
    ];
    final RejectionStackedRgbTile result = await const TiledKappaSigmaCombiner(
      kappa: 0.1,
      minimumSurvivingFrames: 2,
    ).combineTile(
      frameCount: 2,
      frameWeights: const <double>[1, 1],
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.tile.interleavedRgb, everyElement(5));
    expect(result.contributingSamples, everyElement(2));
  });

  test('開始前キャンセルと不正重みを明示的に拒否する', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 1, 1, 1),
    ];
    int reads = 0;
    await expectLater(
      const TiledKappaSigmaCombiner().combineTile(
        frameCount: 1,
        frameWeights: const <double>[1],
        outputTile: _region(0, 0, 1, 1),
        readFrame: (int _, OverlappedTile __) async {
          reads++;
          throw StateError('must not read');
        },
        isCancelled: () => true,
      ),
      throwsA(isA<TiledStackingCancelled>()),
    );
    expect(reads, 0);

    await expectLater(
      const TiledKappaSigmaCombiner().combineTile(
        frameCount: 1,
        frameWeights: const <double>[double.nan],
        outputTile: _region(0, 0, 1, 1),
        readFrame: _reader(width: 1, height: 1, frames: frames),
      ),
      throwsArgumentError,
    );

    await expectLater(
      const TiledKappaSigmaCombiner(maximumPixelsPerBand: 2).combineTile(
        frameCount: 1,
        frameWeights: const <double>[1],
        outputTile: _region(0, 0, 3, 1),
        readFrame: _reader(width: 3, height: 1, frames: <Float32List>[
          _constantFrame(3, 1, 1, 1, 1),
        ]),
      ),
      throwsArgumentError,
    );
  });

  test('小枚数robust初期化はdefault kappa=2.5でも単発外れ値を棄却する', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 1.0, 1.0, 1.0),
      _constantFrame(1, 1, 1.1, 1.1, 1.1),
      _constantFrame(1, 1, 10.0, 10.0, 10.0),
    ];
    final RejectionStackedRgbTile result = await const TiledKappaSigmaCombiner(
      robustSmallStackInitialization: true,
    ).combineTile(
      frameCount: frames.length,
      frameWeights: const <double>[1, 1, 1],
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.tile.interleavedRgb, everyElement(closeTo(1.05, 1e-6)));
    expect(result.contributingSamples, everyElement(2));
  });

  test('小枚数robust初期化は通常の3フレーム揺らぎを棄却しない', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 0.9, 0.9, 0.9),
      _constantFrame(1, 1, 1.0, 1.0, 1.0),
      _constantFrame(1, 1, 1.1, 1.1, 1.1),
    ];
    final RejectionStackedRgbTile result = await const TiledKappaSigmaCombiner(
      robustSmallStackInitialization: true,
    ).combineTile(
      frameCount: frames.length,
      frameWeights: const <double>[1, 1, 1],
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.tile.interleavedRgb, everyElement(closeTo(1.0, 1e-6)));
    expect(result.contributingSamples, everyElement(3));
  });

  test('小枚数robust初期化はzero-MAD多数一致から孤立値を棄却する', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 1, 1, 1),
      _constantFrame(1, 1, 1, 1, 1),
      _constantFrame(1, 1, 10, 10, 10),
    ];
    final RejectionStackedRgbTile result = await const TiledKappaSigmaCombiner(
      robustSmallStackInitialization: true,
    ).combineTile(
      frameCount: frames.length,
      frameWeights: const <double>[1, 1, 1],
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.tile.interleavedRgb, everyElement(closeTo(1, 1e-6)));
    expect(result.contributingSamples, everyElement(2));
  });

  test('低レベル既定値は小枚数robust初期化を強制せず後方互換', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 1.0, 1.0, 1.0),
      _constantFrame(1, 1, 1.1, 1.1, 1.1),
      _constantFrame(1, 1, 10.0, 10.0, 10.0),
    ];
    final RejectionStackedRgbTile result =
        await const TiledKappaSigmaCombiner().combineTile(
      frameCount: frames.length,
      frameWeights: const <double>[1, 1, 1],
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );

    expect(result.contributingSamples, everyElement(3));
  });
}
