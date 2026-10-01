import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/tiled_cfa_drizzle.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/file_backed_linear_raw_mosaic_store.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';
import 'package:mobile_stack/core/registration/similarity_transform_math.dart';

import 'support/recording_rgb_tile_store.dart';

/// Tests that [CfaDrizzleTiledFrame.localCorrectionField] is actually
/// wired into `drizzleCfaTiled`'s own forward-transform construction
/// (Work122). The underlying local-correction/inversion math itself is
/// already tested directly (`local_residual_correction_test.dart`,
/// Work119; `invert_similarity_transform_with_local_correction_
/// test.dart`, Work121) — this file's job is only the wiring.

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

Float32List _seededSamples(int width, int height, int seed) {
  final Float32List samples = Float32List(width * height);
  int state = seed;
  double next() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }

  for (int i = 0; i < samples.length; i++) {
    samples[i] = 50 + next() * 100;
  }
  return samples;
}

/// 空(マッチ数不足)のフィールドを構築することで、常に補正0を返す
/// フィールドを得る(Work120/121のテストと同じ手法)。
LocalResidualCorrectionField _zeroCorrectionField() {
  return fitLocalResidualCorrectionField(const <LocalResidualMatch>[]);
}

Future<Float32List> _flattenValues(
  RecordingRgbTileStore store,
  int width,
  int height,
) async {
  final Float32List flat = Float32List(width * height * 3);
  for (final tile in store.writtenTiles) {
    for (int ly = 0; ly < tile.height; ly++) {
      for (int lx = 0; lx < tile.width; lx++) {
        final int gx = tile.x + lx;
        final int gy = tile.y + ly;
        for (int c = 0; c < 3; c++) {
          flat[(gy * width + gx) * 3 + c] = tile.channelAt(lx, ly, c);
        }
      }
    }
  }
  return flat;
}

void main() {
  test(
    'localCorrectionFieldが常にゼロ補正のフィールドの場合、'
    'localCorrectionFieldを指定しない(null)場合と数値的に完全に'
    '一致する(後方互換性の検証)',
    () async {
      const int width = 40;
      const int height = 32;
      const int outputWidth = 40;
      const int outputHeight = 32;

      final Float32List samplesA = _seededSamples(width, height, 11);
      final Float32List samplesB = _seededSamples(width, height, 22);
      const _Estimate estimateB = _Estimate(
        rotationDegrees: 2,
        sourceOffsetX: 1.5,
        sourceOffsetY: -0.8,
        centerX: width / 2,
        centerY: height / 2,
      );

      final FileBackedLinearRawMosaicStore storeA =
          await FileBackedLinearRawMosaicStore.createTemporary(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
      );
      final FileBackedLinearRawMosaicStore storeB =
          await FileBackedLinearRawMosaicStore.createTemporary(
        width: width,
        height: height,
        cfaPattern: CfaPattern.rggb,
      );
      try {
        await storeA.writeFull(
          LinearRawMosaic(
            width: width,
            height: height,
            cfaPattern: CfaPattern.rggb,
            samples: samplesA,
          ),
        );
        await storeB.writeFull(
          LinearRawMosaic(
            width: width,
            height: height,
            cfaPattern: CfaPattern.rggb,
            samples: samplesB,
          ),
        );

        final CfaDrizzleTiledResult withoutField = await drizzleCfaTiled(
          frames: <CfaDrizzleTiledFrame>[
            CfaDrizzleTiledFrame(mosaicStore: storeA),
            CfaDrizzleTiledFrame(
              mosaicStore: storeB,
              transformEstimate: estimateB,
            ),
          ],
          outputWidth: outputWidth,
          outputHeight: outputHeight,
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
          tileSize: 16,
        );
        final CfaDrizzleTiledResult withZeroField = await drizzleCfaTiled(
          frames: <CfaDrizzleTiledFrame>[
            CfaDrizzleTiledFrame(mosaicStore: storeA),
            CfaDrizzleTiledFrame(
              mosaicStore: storeB,
              transformEstimate: estimateB,
              localCorrectionField: _zeroCorrectionField(),
            ),
          ],
          outputWidth: outputWidth,
          outputHeight: outputHeight,
          valueStoreFactory: RecordingRgbTileStoreFactory().call,
          coverageStoreFactory: RecordingRgbTileStoreFactory().call,
          tileSize: 16,
        );

        final Float32List valueWithout = await _flattenValues(
          withoutField.valueStore as RecordingRgbTileStore,
          outputWidth,
          outputHeight,
        );
        final Float32List valueWithZero = await _flattenValues(
          withZeroField.valueStore as RecordingRgbTileStore,
          outputWidth,
          outputHeight,
        );

        for (int i = 0; i < valueWithout.length; i++) {
          expect(
            (valueWithout[i] - valueWithZero[i]).abs(),
            lessThan(1e-4),
            reason: 'mismatch at flat index $i',
          );
        }
      } finally {
        await storeA.dispose();
        await storeB.dispose();
      }
    },
  );
}
