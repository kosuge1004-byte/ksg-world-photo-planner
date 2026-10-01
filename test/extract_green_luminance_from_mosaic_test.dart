import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/extract_green_luminance_from_mosaic.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';

/// Dart port of `tool/raw_samples/test/extract_green_luminance_from_
/// mosaic_reference.test.mjs` (excluding the two invalid-input
/// rejection tests: unreachable in Dart, since [LinearRawMosaic]'s own
/// constructor already enforces dimension/sample-count consistency and
/// [CfaPattern] is an `enum` with no "unsupported" value to construct —
/// see `extract_green_luminance_from_mosaic.dart`'s own doc comment).

LinearRawMosaic _makeMosaic(
  int width,
  int height,
  CfaPattern pattern,
  double Function(int x, int y) fill,
) {
  final Float32List samples = Float32List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      samples[y * width + x] = fill(x, y);
    }
  }
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: pattern,
    samples: samples,
  );
}

void main() {
  test(
    '全CFAパターン・全4通りの偶奇の組み合わせで、CfaPattern.colorAtと'
    '一致する緑位置判定になる',
    () {
      for (final CfaPattern pattern in CfaPattern.values) {
        for (final (int x, int y) in <(int, int)>[
          (0, 0),
          (1, 0),
          (0, 1),
          (1, 1),
        ]) {
          final bool isGreenByColorAt = pattern.colorAt(x, y) == CfaColor.green;
          final LinearRawMosaic mosaic = _makeMosaic(
            4,
            4,
            pattern,
            (int mx, int my) => (mx == x && my == y) ? 999 : 1,
          );
          final LuminancePlane result = extractGreenLuminanceFromMosaic(
            mosaic,
          );
          final double outputValue = result.samples[y * 4 + x];
          if (isGreenByColorAt) {
            expect(
              outputValue,
              999,
              reason: 'pattern=$pattern ($x,$y): expected green position '
                  'to pass through unchanged',
            );
          } else {
            expect(
              outputValue,
              isNot(999),
              reason: 'pattern=$pattern ($x,$y): expected non-green '
                  'position to be interpolated',
            );
          }
        }
      }
    },
  );

  test('緑位置の値は一切変更されずそのまま出力される', () {
    final LinearRawMosaic mosaic = _makeMosaic(
      6,
      6,
      CfaPattern.rggb,
      (int x, int y) => (x * 10 + y).toDouble(),
    );
    final LuminancePlane result = extractGreenLuminanceFromMosaic(mosaic);
    for (int y = 0; y < 6; y++) {
      for (int x = 0; x < 6; x++) {
        if (CfaPattern.rggb.colorAt(x, y) == CfaColor.green) {
          expect(result.samples[y * 6 + x], mosaic.samples[y * 6 + x]);
        }
      }
    }
  });

  test('内部の非緑位置は4方向の緑近傍の平均になる', () {
    // rggbで(1,1)は緑ではない(BLUE)。4近傍は全て緑のはず。
    expect(CfaPattern.rggb.colorAt(1, 1), CfaColor.blue);
    final LinearRawMosaic mosaic = _makeMosaic(5, 5, CfaPattern.rggb, (
      int x,
      int y,
    ) {
      if (x == 0 && y == 1) return 10;
      if (x == 2 && y == 1) return 20;
      if (x == 1 && y == 0) return 30;
      if (x == 1 && y == 2) return 40;
      return 0;
    });
    final LuminancePlane result = extractGreenLuminanceFromMosaic(mosaic);
    expect(result.samples[1 * 5 + 1], (10 + 20 + 30 + 40) / 4);
  });

  test(
    '端・角の非緑位置は範囲内の近傍のみで平均される'
    '(範囲外をゼロ扱いしない)',
    () {
      expect(CfaPattern.rggb.colorAt(0, 0), CfaColor.red);
      final LinearRawMosaic mosaic = _makeMosaic(4, 4, CfaPattern.rggb, (
        int x,
        int y,
      ) {
        if (x == 1 && y == 0) return 6;
        if (x == 0 && y == 1) return 10;
        return 100;
      });
      final LuminancePlane result = extractGreenLuminanceFromMosaic(mosaic);
      expect(result.samples[0], 8);
    },
  );

  test('4x4より小さい極小モザイクでもゼロ除算せず有限値を返す', () {
    final LinearRawMosaic mosaic = _makeMosaic(
      2,
      2,
      CfaPattern.rggb,
      (int x, int y) => 5,
    );
    final LuminancePlane result = extractGreenLuminanceFromMosaic(mosaic);
    for (final double value in result.samples) {
      expect(value.isFinite, isTrue);
    }
  });

  test('出力の寸法は入力と同じ', () {
    final LinearRawMosaic mosaic = _makeMosaic(
      7,
      5,
      CfaPattern.grbg,
      (int x, int y) => 1,
    );
    final LuminancePlane result = extractGreenLuminanceFromMosaic(mosaic);
    expect(result.width, 7);
    expect(result.height, 5);
    expect(result.samples.length, 35);
  });
}
