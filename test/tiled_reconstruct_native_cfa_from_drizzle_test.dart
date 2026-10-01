import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';
import 'package:mobile_stack/core/drizzle/reconstruct_native_cfa_from_drizzle.dart';
import 'package:mobile_stack/core/drizzle/tiled_reconstruct_native_cfa_from_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';

import 'support/in_memory_rgb_tile_store.dart';

/// The key correctness check for
/// `tiled_reconstruct_native_cfa_from_drizzle.dart`: confirms the
/// strip-based reading restructuring produces numerically identical
/// results to the already-tested whole-image
/// `reconstructNativeCfaMosaicFromDrizzle` on the same synthetic
/// value/coverage data — the same "tiled version matches the
/// whole-frame version exactly" discipline established for
/// `tiled_cfa_drizzle.dart` (Work87).

DrizzleResult _seededChannel(int width, int height, {required int seed}) {
  final Float64List value = Float64List(width * height);
  final Float64List coverage = Float64List(width * height);
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < value.length; i++) {
    value[i] = next() * 100;
    // coverageの約半分をギャップ(0)にし、実際のdrizzle出力に近い
    // 不規則な疎密パターンを模す。
    final double rawCoverage = next();
    coverage[i] = rawCoverage < 0.5 ? 0 : rawCoverage * 5;
  }
  return DrizzleResult(
    width: width,
    height: height,
    value: value,
    coverage: coverage,
  );
}

Float32List _seededSamples(int width, int height, int seed) {
  final Float32List samples = Float32List(width * height * 3);
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < samples.length; i++) {
    samples[i] = next() * 10;
  }
  return samples;
}

void main() {
  for (final int stripHeight in <int>[3, 7, 100]) {
    test(
      'stripHeight=$stripHeightでの結果が、全画像一括版の'
      'reconstructNativeCfaMosaicFromDrizzleと数値的に一致する',
      () async {
        const int width = 13;
        const int height = 11;
        final List<DrizzleResult> channels = <DrizzleResult>[
          for (int c = 0; c < 3; c++)
            _seededChannel(width, height, seed: 100 + c * 37),
        ];

        // --- 全画像一括版を「正解」として計算 ---
        final LinearRawMosaic reference = reconstructNativeCfaMosaicFromDrizzle(
          CfaDrizzleResult(width: width, height: height, channels: channels),
          CfaPattern.rggb,
          1,
        );

        // --- タイル方式版(今回の実装) ---
        final Float32List valueSamples = Float32List(width * height * 3);
        final Float32List coverageSamples = Float32List(width * height * 3);
        for (int c = 0; c < 3; c++) {
          for (int i = 0; i < width * height; i++) {
            valueSamples[i * 3 + c] = channels[c].value[i];
            coverageSamples[i * 3 + c] = channels[c].coverage[i];
          }
        }
        final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: valueSamples,
        );
        final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
          width: width,
          height: height,
          interleavedRgb: coverageSamples,
        );

        final LinearRawMosaic tiled =
            await reconstructNativeCfaMosaicFromDrizzleTiled(
          valueStore: valueStore,
          coverageStore: coverageStore,
          referenceCfaPattern: CfaPattern.rggb,
          stripHeight: stripHeight,
        );

        expect(tiled.width, reference.width);
        expect(tiled.height, reference.height);
        expect(tiled.cfaPattern, reference.cfaPattern);
        for (int i = 0; i < reference.samples.length; i++) {
          expect(
            (tiled.samples[i] - reference.samples[i]).abs(),
            lessThan(1e-5),
            reason: 'mismatch at index $i: tiled=${tiled.samples[i]} '
                'ref=${reference.samples[i]} (stripHeight=$stripHeight)',
          );
        }
      },
    );
  }

  test(
    'valueStoreとcoverageStoreの寸法が異なると'
    'InvalidCfaReconstructionInputを投げる',
    () async {
      final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
        width: 4,
        height: 4,
        interleavedRgb: Float32List(4 * 4 * 3),
      );
      final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
        width: 5,
        height: 5,
        interleavedRgb: Float32List(5 * 5 * 3),
      );
      await expectLater(
        reconstructNativeCfaMosaicFromDrizzleTiled(
          valueStore: valueStore,
          coverageStore: coverageStore,
          referenceCfaPattern: CfaPattern.rggb,
        ),
        throwsA(isA<InvalidCfaReconstructionInput>()),
      );
    },
  );

  test('キャンセルされるとStateErrorを投げる', () async {
    const int width = 8;
    const int height = 8;
    final InMemoryRgbTileStore valueStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: _seededSamples(width, height, 1),
    );
    final InMemoryRgbTileStore coverageStore = InMemoryRgbTileStore(
      width: width,
      height: height,
      interleavedRgb: _seededSamples(width, height, 2),
    );
    await expectLater(
      reconstructNativeCfaMosaicFromDrizzleTiled(
        valueStore: valueStore,
        coverageStore: coverageStore,
        referenceCfaPattern: CfaPattern.rggb,
        stripHeight: 2,
        isCancelled: () => true,
      ),
      throwsA(isA<StateError>()),
    );
  });
}
