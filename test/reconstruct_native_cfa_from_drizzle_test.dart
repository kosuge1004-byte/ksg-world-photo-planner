import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';
import 'package:mobile_stack/core/drizzle/reconstruct_native_cfa_from_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';

/// Dart port of `tool/raw_samples/test/reconstruct_native_cfa_from_
/// drizzle_reference.test.mjs`.

DrizzleResult _makeChannel(
  int width,
  int height,
  double Function(int x, int y) valueFn,
  double Function(int x, int y) coverageFn,
) {
  final Float64List value = Float64List(width * height);
  final Float64List coverage = Float64List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      value[index] = valueFn(x, y);
      coverage[index] = coverageFn(x, y);
    }
  }
  return DrizzleResult(
    width: width,
    height: height,
    value: value,
    coverage: coverage,
  );
}

void main() {
  test(
    '各画素で、参照CFAパターンが定めるネイティブ位相のチャンネル値だけが'
    '採用される',
    () {
      const int width = 4;
      const int height = 4;
      final List<DrizzleResult> channels = <DrizzleResult>[
        _makeChannel(
          width,
          height,
          (int x, int y) => 10,
          (int x, int y) => 1,
        ),
        _makeChannel(
          width,
          height,
          (int x, int y) => 20,
          (int x, int y) => 1,
        ),
        _makeChannel(
          width,
          height,
          (int x, int y) => 30,
          (int x, int y) => 1,
        ),
      ];
      final LinearRawMosaic result = reconstructNativeCfaMosaicFromDrizzle(
        CfaDrizzleResult(width: width, height: height, channels: channels),
        CfaPattern.rggb,
        1,
      );
      expect(result.width, width);
      expect(result.height, height);
      expect(result.cfaPattern, CfaPattern.rggb);
      expect(result.samples[0 * width + 0], 10);
      expect(result.samples[0 * width + 1], 20);
      expect(result.samples[1 * width + 0], 20);
      expect(result.samples[1 * width + 1], 30);
    },
  );

  test(
    '他チャンネルの値が混入しない(全チャンネルに極端に異なる値を'
    '仕込んで確認)',
    () {
      const int width = 6;
      const int height = 6;
      final List<DrizzleResult> channels = <DrizzleResult>[
        _makeChannel(
          width,
          height,
          (int x, int y) => (1000 + x * 10 + y).toDouble(),
          (int x, int y) => 1,
        ),
        _makeChannel(
          width,
          height,
          (int x, int y) => (2000 + x * 10 + y).toDouble(),
          (int x, int y) => 1,
        ),
        _makeChannel(
          width,
          height,
          (int x, int y) => (3000 + x * 10 + y).toDouble(),
          (int x, int y) => 1,
        ),
      ];
      final LinearRawMosaic result = reconstructNativeCfaMosaicFromDrizzle(
        CfaDrizzleResult(width: width, height: height, channels: channels),
        CfaPattern.bggr,
        1,
      );
      expect(result.samples[0], 3000);
    },
  );

  test(
    'ネイティブ位相チャンネルのcoverageが不足している画素は、同じ'
    'チャンネルの近傍から(他チャンネルを混ぜずに)ギャップ埋めされる',
    () {
      const int width = 5;
      const int height = 5;
      final DrizzleResult redChannel = _makeChannel(
        width,
        height,
        (int x, int y) => (x == 2 && y == 2) ? 999 : 50,
        (int x, int y) => (x == 2 && y == 2) ? 0 : 1,
      );
      final List<DrizzleResult> channels = <DrizzleResult>[
        redChannel,
        _makeChannel(
          width,
          height,
          (int x, int y) => 999999,
          (int x, int y) => 1,
        ),
        _makeChannel(
          width,
          height,
          (int x, int y) => 888888,
          (int x, int y) => 1,
        ),
      ];
      final LinearRawMosaic result = reconstructNativeCfaMosaicFromDrizzle(
        CfaDrizzleResult(width: width, height: height, channels: channels),
        CfaPattern.rggb,
        1,
      );
      expect(result.samples[2 * width + 2], 50);
    },
  );

  test('outputScaleが1以外だとInvalidCfaReconstructionInputを投げる', () {
    const int width = 2;
    const int height = 2;
    final List<DrizzleResult> channels = <DrizzleResult>[
      _makeChannel(width, height, (int x, int y) => 1, (int x, int y) => 1),
      _makeChannel(width, height, (int x, int y) => 1, (int x, int y) => 1),
      _makeChannel(width, height, (int x, int y) => 1, (int x, int y) => 1),
    ];
    expect(
      () => reconstructNativeCfaMosaicFromDrizzle(
        CfaDrizzleResult(width: width, height: height, channels: channels),
        CfaPattern.rggb,
        2,
      ),
      throwsA(isA<InvalidCfaReconstructionInput>()),
    );
  });

  test(
    'チャンネル数が3でない場合はInvalidCfaReconstructionInputを投げる',
    () {
      const int width = 2;
      const int height = 2;
      final List<DrizzleResult> channels = <DrizzleResult>[
        _makeChannel(width, height, (int x, int y) => 1, (int x, int y) => 1),
      ];
      expect(
        () => reconstructNativeCfaMosaicFromDrizzle(
          CfaDrizzleResult(width: width, height: height, channels: channels),
          CfaPattern.rggb,
          1,
        ),
        throwsA(isA<InvalidCfaReconstructionInput>()),
      );
    },
  );

  test('4種類のCFAパターン全てで正しくチャンネルが選ばれる', () {
    const int width = 2;
    const int height = 2;
    final List<DrizzleResult> channels = <DrizzleResult>[
      _makeChannel(width, height, (int x, int y) => 100, (int x, int y) => 1),
      _makeChannel(width, height, (int x, int y) => 200, (int x, int y) => 1),
      _makeChannel(width, height, (int x, int y) => 300, (int x, int y) => 1),
    ];
    final Map<CfaPattern, List<double>> expectations =
        <CfaPattern, List<double>>{
      CfaPattern.rggb: <double>[100, 200, 200, 300],
      CfaPattern.bggr: <double>[300, 200, 200, 100],
      CfaPattern.grbg: <double>[200, 100, 300, 200],
      CfaPattern.gbrg: <double>[200, 300, 100, 200],
    };
    for (final MapEntry<CfaPattern, List<double>> entry
        in expectations.entries) {
      final LinearRawMosaic result = reconstructNativeCfaMosaicFromDrizzle(
        CfaDrizzleResult(width: width, height: height, channels: channels),
        entry.key,
        1,
      );
      expect(
        result.samples,
        orderedEquals(entry.value),
        reason: 'pattern=${entry.key}',
      );
    }
  });
}
