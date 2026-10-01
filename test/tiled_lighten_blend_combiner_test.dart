import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/linear_rgb_tile.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/stacking/lighten_blend_combiner.dart';
import 'package:mobile_stack/core/stacking/tiled_lighten_blend_combiner.dart';
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
  test('各チャンネルの最大値を独立に取る(標準の比較明合成)', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(2, 2, 1, 5, 2),
      _constantFrame(2, 2, 3, 1, 9),
    ];
    final LightenBlendStackedRgbTile result =
        await const TiledLightenBlendCombiner().combineTile(
      frameCount: frames.length,
      outputTile: _region(0, 0, 2, 2),
      readFrame: _reader(width: 2, height: 2, frames: frames),
    );
    expect(result.tile.channelAt(0, 0, 0), closeTo(3, 1e-6)); // max(1,3)
    expect(result.tile.channelAt(0, 0, 1), closeTo(5, 1e-6)); // max(5,1)
    expect(result.tile.channelAt(0, 0, 2), closeTo(9, 1e-6)); // max(2,9)
    expect(result.coverage, everyElement(2));
  });

  test('coverage 0のフレームは合成に混ざらない', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 2, 2, 2),
      _constantFrame(1, 1, 100, 100, 100),
    ];
    final List<Uint8List> coverage = <Uint8List>[
      Uint8List.fromList(<int>[1]),
      Uint8List.fromList(<int>[0]),
    ];
    final LightenBlendStackedRgbTile result =
        await const TiledLightenBlendCombiner().combineTile(
      frameCount: 2,
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(
        width: 1,
        height: 1,
        frames: frames,
        coverages: coverage,
      ),
    );
    expect(result.tile.interleavedRgb, everyElement(closeTo(2, 1e-6)));
    expect(result.coverage, <int>[1]);
  });

  test('keepHighest=2で単発の外れ値スパイクを棄却する', () async {
    final List<Float32List> frames = <Float32List>[
      for (final double value in <double>[0.5, 0.5, 99, 0.5, 0.5, 0.5])
        _constantFrame(1, 1, value, value, value),
    ];
    final LightenBlendStackedRgbTile result =
        await const TiledLightenBlendCombiner(
      keepHighest: 2,
      minimumCoveringFrames: 2,
    ).combineTile(
      frameCount: frames.length,
      outputTile: _region(0, 0, 1, 1),
      readFrame: _reader(width: 1, height: 1, frames: frames),
    );
    expect(result.tile.interleavedRgb, everyElement(closeTo(0.5, 1e-6)));
  });

  test('複数バンドにまたがっても出力全体が一致する', () async {
    const int width = 4;
    const int height = 5; // maximumPixelsPerBand との組み合わせで複数バンド化
    final List<Float32List> frames = <Float32List>[
      _constantFrame(width, height, 1, 1, 1),
      _constantFrame(width, height, 7, 7, 7),
    ];
    final List<OverlappedTile> requests = <OverlappedTile>[];
    final LightenBlendStackedRgbTile result =
        await const TiledLightenBlendCombiner(
      maximumPixelsPerBand: 8, // width=4 -> bandHeight=2 で複数バンドを強制
    ).combineTile(
      frameCount: frames.length,
      outputTile: _region(0, 0, width, height),
      readFrame: _reader(
        width: width,
        height: height,
        frames: frames,
        requests: requests,
      ),
    );
    expect(result.tile.interleavedRgb, everyElement(closeTo(7, 1e-6)));
    expect(result.coverage, everyElement(2));
    // bandHeight=2 のとき height=5 は3バンド(2,2,1行)に分割されるはず。
    expect(requests.length, frames.length * 3);
  });

  test('逐次化後も従来のlightenBlendCombineCoveredRgbと完全に同じ意味になる', () async {
    const int width = 3;
    const int height = 2;
    final List<Float32List> frames = <Float32List>[
      Float32List.fromList(<double>[
        1,
        7,
        3,
        4,
        2,
        9,
        8,
        1,
        5,
        6,
        3,
        2,
        0.5,
        4,
        7,
        9,
        8,
        1,
      ]),
      Float32List.fromList(<double>[
        5,
        2,
        4,
        3,
        8,
        1,
        2,
        9,
        6,
        7,
        1,
        8,
        4,
        6,
        2,
        3,
        5,
        9,
      ]),
      Float32List.fromList(<double>[
        2,
        6,
        8,
        7,
        5,
        3,
        4,
        2,
        9,
        1,
        9,
        5,
        8,
        3,
        6,
        2,
        7,
        4,
      ]),
    ];
    final List<Uint8List> coverages = <Uint8List>[
      Uint8List.fromList(<int>[1, 1, 1, 1, 1, 1]),
      Uint8List.fromList(<int>[1, 0, 1, 1, 1, 1]),
      Uint8List.fromList(<int>[1, 1, 1, 0, 1, 1]),
    ];
    for (final int keepHighest in <int>[1, 2, 3]) {
      final List<CoveredLinearRgbTile> legacyFrames = <CoveredLinearRgbTile>[
        for (int i = 0; i < frames.length; i++)
          CoveredLinearRgbTile(
            tile: LinearRgbTile(
              x: 0,
              y: 0,
              width: width,
              height: height,
              interleavedRgb: Float32List.fromList(frames[i]),
            ),
            coverage: Uint8List.fromList(coverages[i]),
          ),
      ];
      final LightenBlendResult expected = lightenBlendCombineCoveredRgb(
        frames: legacyFrames,
        keepHighest: keepHighest,
        minimumCoveringFrames: 1,
      );
      final LightenBlendStackedRgbTile actual =
          await TiledLightenBlendCombiner(keepHighest: keepHighest).combineTile(
        frameCount: frames.length,
        outputTile: _region(0, 0, width, height),
        readFrame: _reader(
          width: width,
          height: height,
          frames: frames,
          coverages: coverages,
        ),
      );
      expect(actual.tile.interleavedRgb, orderedEquals(expected.rgb));
      expect(actual.coverage, orderedEquals(expected.coverage));
    }
  });

  test('進捗コールバックは単調増加し最終的に1に達する', () async {
    const int width = 2;
    const int height = 6;
    final List<Float32List> frames = <Float32List>[
      _constantFrame(width, height, 1, 1, 1),
    ];
    final List<double> progressValues = <double>[];
    await const TiledLightenBlendCombiner(
      maximumPixelsPerBand: 4, // bandHeight=2 -> 3バンド
    ).combineTile(
      frameCount: 1,
      outputTile: _region(0, 0, width, height),
      readFrame: _reader(width: width, height: height, frames: frames),
      reportProgress: progressValues.add,
    );
    expect(progressValues, isNotEmpty);
    for (int i = 1; i < progressValues.length; i++) {
      expect(progressValues[i], greaterThanOrEqualTo(progressValues[i - 1]));
    }
    expect(progressValues.last, closeTo(1, 1e-9));
  });

  test('キャンセルされるとTiledLightenBlendCancelledを投げる', () async {
    final List<Float32List> frames = <Float32List>[
      _constantFrame(1, 1, 1, 1, 1),
    ];
    bool cancelNow = false;
    final Completer<void> readStarted = Completer<void>();
    final Completer<void> releaseRead = Completer<void>();
    final Future<LightenBlendStackedRgbTile> future =
        const TiledLightenBlendCombiner().combineTile(
      frameCount: 1,
      outputTile: _region(0, 0, 1, 1),
      readFrame: (int frameIndex, OverlappedTile region) async {
        readStarted.complete();
        await releaseRead.future;
        return _reader(width: 1, height: 1, frames: frames)(
          frameIndex,
          region,
        );
      },
      isCancelled: () => cancelNow,
    );
    await readStarted.future;
    cancelNow = true;
    releaseRead.complete();
    await expectLater(
      future,
      throwsA(isA<TiledLightenBlendCancelled>()),
    );
  });

  test('frameCountが0以下だとArgumentErrorを投げる', () {
    expect(
      () => const TiledLightenBlendCombiner().combineTile(
        frameCount: 0,
        outputTile: _region(0, 0, 1, 1),
        readFrame: (int frameIndex, OverlappedTile region) async {
          throw StateError('呼ばれないはず');
        },
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('minimumCoveringFramesがframeCountを超えるとArgumentErrorを投げる', () {
    expect(
      () => const TiledLightenBlendCombiner(
        minimumCoveringFrames: 3,
      ).combineTile(
        frameCount: 2,
        outputTile: _region(0, 0, 1, 1),
        readFrame: (int frameIndex, OverlappedTile region) async {
          throw StateError('呼ばれないはず');
        },
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('リーダーが想定外の領域を返すとStateErrorを投げる', () async {
    expect(
      () => const TiledLightenBlendCombiner().combineTile(
        frameCount: 1,
        outputTile: _region(0, 0, 2, 2),
        readFrame: (int frameIndex, OverlappedTile region) async {
          // 要求とは異なる領域を返す(x座標を意図的にずらす)
          return CoveredLinearRgbTile(
            tile: LinearRgbTile(
              x: region.outputX + 1,
              y: region.outputY,
              width: region.outputWidth,
              height: region.outputHeight,
              interleavedRgb: Float32List(
                region.outputWidth * region.outputHeight * 3,
              ),
            ),
            coverage: Uint8List(region.outputWidth * region.outputHeight),
          );
        },
      ),
      throwsA(isA<StateError>()),
    );
  });
}
