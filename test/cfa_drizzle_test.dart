import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/registration/similarity_transform_math.dart';

/// Dart port of `tool/raw_samples/test/cfa_drizzle_reference.test.mjs`
/// (excluding the `invertSimilarityTransform` test, already covered by
/// `similarity_transform_math_test.dart`).

final class _Estimate implements SimilarityTransformEstimate {
  const _Estimate({
    required this.rotationDegrees,
    required this.sourceOffsetX,
    required this.sourceOffsetY,
    required this.centerX,
    required this.centerY,
  });

  @override
  final double rotationDegrees;
  @override
  final double sourceOffsetX;
  @override
  final double sourceOffsetY;
  @override
  final double centerX;
  @override
  final double centerY;
}

Float32List _makeMosaicSamples(int width, int height, int seed) {
  final Float32List samples = Float32List(width * height);
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < samples.length; i++) {
    samples[i] = next();
  }
  return samples;
}

({double x, double y}) _identityTransform(double x, double y) => (x: x, y: y);

void main() {
  test('rejects an empty frame list', () {
    expect(
      () => cfaDrizzle(
        frames: const <CfaDrizzleFrame>[],
        outputWidth: 4,
        outputHeight: 4,
      ),
      throwsA(isA<InvalidCfaDrizzleInput>()),
    );
  });

  test('rejects non-positive pixfrac or outputScale', () {
    final CfaDrizzleFrame frame = CfaDrizzleFrame(
      width: 4,
      height: 4,
      cfaPattern: CfaPattern.rggb,
      samples: _makeMosaicSamples(4, 4, 1),
      forwardTransform: _identityTransform,
    );
    expect(
      () => cfaDrizzle(
        frames: <CfaDrizzleFrame>[frame],
        outputWidth: 4,
        outputHeight: 4,
        pixfrac: 0,
      ),
      throwsA(isA<InvalidCfaDrizzleInput>()),
    );
    expect(
      () => cfaDrizzle(
        frames: <CfaDrizzleFrame>[frame],
        outputWidth: 4,
        outputHeight: 4,
        outputScale: -1,
      ),
      throwsA(isA<InvalidCfaDrizzleInput>()),
    );
  });

  test(
    'rejects a frame whose sample count does not match its dimensions',
    () {
      final CfaDrizzleFrame frame = CfaDrizzleFrame(
        width: 4,
        height: 4,
        cfaPattern: CfaPattern.rggb,
        samples: Float32List(4),
        forwardTransform: _identityTransform,
      );
      expect(
        () => cfaDrizzle(
          frames: <CfaDrizzleFrame>[frame],
          outputWidth: 4,
          outputHeight: 4,
        ),
        throwsA(isA<InvalidCfaDrizzleInput>()),
      );
    },
  );

  test(
    '単一フレーム・identity変換・1倍スケール・pixfrac1: 各CFAサンプルを'
    'そのチャンネルへ正確に再現する',
    () {
      const int size = 6;
      final Float32List samples = _makeMosaicSamples(size, size, 7);
      final CfaDrizzleFrame frame = CfaDrizzleFrame(
        width: size,
        height: size,
        cfaPattern: CfaPattern.rggb,
        samples: samples,
        forwardTransform: _identityTransform,
      );
      final CfaDrizzleResult result = cfaDrizzle(
        frames: <CfaDrizzleFrame>[frame],
        outputWidth: size,
        outputHeight: size,
        outputScale: 1,
        pixfrac: 1,
      );
      for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
          final int channel = CfaPattern.rggb.colorAt(x, y).index;
          final int index = y * size + x;
          for (int c = 0; c < 3; c++) {
            if (c == channel) {
              expect(
                (result.channels[c].value[index] - samples[index]).abs(),
                lessThan(1e-6),
                reason: 'channel $c at ($x,$y)',
              );
              expect(
                (result.channels[c].coverage[index] - 1).abs(),
                lessThan(1e-6),
              );
            } else {
              expect(result.channels[c].coverage[index], 0);
            }
          }
        }
      }
    },
  );

  test(
    '純粋なサブピクセル並進で関係する2フレームは、チャンネルごとにflux'
    'を失わず合成される',
    () {
      const int width = 8;
      const int height = 8;
      final Float32List samplesA = _makeMosaicSamples(width, height, 11);
      final Float32List samplesB = _makeMosaicSamples(width, height, 12);
      final CfaDrizzleFrame frameA = CfaDrizzleFrame(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
        samples: samplesA,
        forwardTransform: _identityTransform,
      );
      final CfaDrizzleFrame frameB = CfaDrizzleFrame(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
        samples: samplesB,
        forwardTransform: (double x, double y) => (x: x + 0.4, y: y + 0.4),
      );

      final CfaDrizzleResult result = cfaDrizzle(
        frames: <CfaDrizzleFrame>[frameA, frameB],
        outputWidth: width,
        outputHeight: height,
        outputScale: 1,
        pixfrac: 1,
      );

      double expectedFlux = 0;
      double actualFlux = 0;
      for (int y = 2; y < height - 2; y++) {
        for (int x = 2; x < width - 2; x++) {
          expectedFlux += samplesA[y * width + x];
          expectedFlux += samplesB[y * width + x];
        }
      }
      for (int c = 0; c < 3; c++) {
        for (int y = 2; y < height - 2; y++) {
          for (int x = 2; x < width - 2; x++) {
            final int index = y * width + x;
            actualFlux += result.channels[c].value[index] *
                result.channels[c].coverage[index];
          }
        }
      }
      expect(
        (actualFlux - expectedFlux).abs(),
        lessThan(expectedFlux * 0.05),
        reason: 'expected total interior flux near $expectedFlux, got '
            '$actualFlux',
      );
    },
  );

  test(
    '複数のサブピクセルディザーフレームからの2倍スーパーサンプリングは、'
    '単一のネイティブ解像度フレームより詳細を解像する',
    () {
      const int width = 10;
      const int height = 10;
      const double outputScale = 2;
      final int outputWidth = (width * outputScale).round();
      final int outputHeight = (height * outputScale).round();

      Float32List renderPointSource(double offsetX, double offsetY) {
        final Float32List samples = Float32List(width * height)
          ..fillRange(0, width * height, 0.1);
        final int px = (5.3 + offsetX).round();
        final int py = (5.3 + offsetY).round();
        samples[py * width + px] += 8;
        return samples;
      }

      const List<({double dx, double dy})> dithers = <({double dx, double dy})>[
        (dx: 0, dy: 0),
        (dx: 0.5, dy: 0),
        (dx: 0, dy: 0.5),
        (dx: 0.5, dy: 0.5),
      ];
      final List<CfaDrizzleFrame> frames = <CfaDrizzleFrame>[
        for (final dither in dithers)
          CfaDrizzleFrame(
            width: width,
            height: height,
            cfaPattern: CfaPattern.rggb,
            samples: renderPointSource(dither.dx, dither.dy),
            forwardTransform: (double x, double y) =>
                (x: x - dither.dx, y: y - dither.dy),
          ),
      ];

      final CfaDrizzleResult result = cfaDrizzle(
        frames: frames,
        outputWidth: outputWidth,
        outputHeight: outputHeight,
        outputScale: outputScale,
        pixfrac: 0.8,
      );

      final DrizzleResult green = result.channels[1];
      int peakIndex = -1;
      double peakValue = double.negativeInfinity;
      for (int index = 0; index < green.value.length; index++) {
        if (green.coverage[index] > 0 && green.value[index] > peakValue) {
          peakValue = green.value[index];
          peakIndex = index;
        }
      }
      expect(peakIndex, greaterThanOrEqualTo(0));
      expect(peakValue, greaterThan(0.5));
      final int peakX = peakIndex % outputWidth;
      final int peakY = peakIndex ~/ outputWidth;
      expect(
        (peakX - 5 * outputScale).abs(),
        lessThanOrEqualTo(outputScale),
      );
      expect(
        (peakY - 5 * outputScale).abs(),
        lessThanOrEqualTo(outputScale),
      );
    },
  );

  test('フレームごとの重みがそのフレームの寄与をスケールする', () {
    const int width = 4;
    const int height = 4;
    final Float32List samplesA = _makeMosaicSamples(width, height, 1);
    final Float32List samplesB = _makeMosaicSamples(width, height, 2);

    final CfaDrizzleResult resultEqual = cfaDrizzle(
      frames: <CfaDrizzleFrame>[
        CfaDrizzleFrame(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: samplesA,
          forwardTransform: _identityTransform,
        ),
        CfaDrizzleFrame(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: samplesB,
          forwardTransform: _identityTransform,
        ),
      ],
      outputWidth: width,
      outputHeight: height,
      outputScale: 1,
      pixfrac: 1,
    );
    final CfaDrizzleResult resultWeighted = cfaDrizzle(
      frames: <CfaDrizzleFrame>[
        CfaDrizzleFrame(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: samplesA,
          forwardTransform: _identityTransform,
        ),
        CfaDrizzleFrame(
          width: width,
          height: height,
          cfaPattern: CfaPattern.rggb,
          samples: samplesB,
          forwardTransform: _identityTransform,
          weight: 0,
        ),
      ],
      outputWidth: width,
      outputHeight: height,
      outputScale: 1,
      pixfrac: 1,
    );

    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        final int channel = CfaPattern.rggb.colorAt(x, y).index;
        final int index = y * width + x;
        expect(
          (resultWeighted.channels[channel].value[index] - samplesA[index])
              .abs(),
          lessThan(1e-6),
        );
        if ((samplesA[index] - samplesB[index]).abs() > 1e-3) {
          expect(
            resultEqual.channels[channel].value[index],
            isNot(resultWeighted.channels[channel].value[index]),
          );
        }
      }
    }
  });

  test(
    '実際に回転したフレームは(軸並行ではなく)回転したフットプリントで'
    '分配され、総fluxを厳密に保存する',
    () {
      const int width = 10;
      const int height = 10;
      final Float32List samples = _makeMosaicSamples(width, height, 5);
      const double rotationDegrees = 27;
      const double outputScale = 2;
      const int outputWidth = 80;
      const int outputHeight = 80;
      const double dataCenterX = width / 2;
      const double dataCenterY = height / 2;
      const double desiredOutputCenterNative = outputWidth / (2 * outputScale);

      final CfaDrizzleForwardTransform forwardTransform =
          invertSimilarityTransform(
        const _Estimate(
          rotationDegrees: -rotationDegrees,
          sourceOffsetX: dataCenterX - desiredOutputCenterNative,
          sourceOffsetY: dataCenterY - desiredOutputCenterNative,
          centerX: desiredOutputCenterNative,
          centerY: desiredOutputCenterNative,
        ),
      );

      const double pixfrac = 0.5;
      final CfaDrizzleResult rotated = cfaDrizzle(
        frames: <CfaDrizzleFrame>[
          CfaDrizzleFrame(
            width: width,
            height: height,
            cfaPattern: CfaPattern.rggb,
            samples: samples,
            forwardTransform: forwardTransform,
          ),
        ],
        outputWidth: outputWidth,
        outputHeight: outputHeight,
        outputScale: outputScale,
        pixfrac: pixfrac,
      );

      double totalInputFlux = 0;
      for (final double value in samples) {
        totalInputFlux += value;
      }
      double totalOutputFlux = 0;
      for (final DrizzleResult channel in rotated.channels) {
        for (int index = 0; index < channel.value.length; index++) {
          totalOutputFlux += channel.value[index] * channel.coverage[index];
        }
      }
      expect(
        (totalOutputFlux - totalInputFlux).abs(),
        lessThan(1e-6),
        reason: 'expected total flux $totalInputFlux, got $totalOutputFlux',
      );

      final List<DrizzleAccumulator> axisAlignedAccumulators =
          <DrizzleAccumulator>[
        for (int c = 0; c < 3; c++)
          DrizzleAccumulator(width: outputWidth, height: outputHeight),
      ];
      final double dropHalfExtent = 0.5 * pixfrac * outputScale;
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int channel = CfaPattern.rggb.colorAt(x, y).index;
          final ({double x, double y}) mapped = forwardTransform(
            x.toDouble(),
            y.toDouble(),
          );
          axisAlignedAccumulators[channel].addDrop(
            mapped.x * outputScale,
            mapped.y * outputScale,
            samples[y * width + x],
            dropRadius: dropHalfExtent,
          );
        }
      }
      bool anyPixelDiffers = false;
      for (int channel = 0; channel < 3; channel++) {
        final DrizzleResult axisAlignedResult =
            axisAlignedAccumulators[channel].finalize();
        final DrizzleResult rotatedResult = rotated.channels[channel];
        for (int index = 0; index < rotatedResult.value.length; index++) {
          if ((axisAlignedResult.coverage[index] -
                      rotatedResult.coverage[index])
                  .abs() >
              1e-6) {
            anyPixelDiffers = true;
            break;
          }
        }
        if (anyPixelDiffers) break;
      }
      expect(
        anyPixelDiffers,
        isTrue,
        reason: 'expected the rotation-aware footprint to differ from the '
            'axis-aligned approximation at a 27-degree rotation',
      );
    },
  );
}
