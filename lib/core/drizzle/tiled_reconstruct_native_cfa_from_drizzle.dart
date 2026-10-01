import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';
import '../image/linear_rgb_tile.dart';
import '../image/linear_rgb_tile_store.dart';
import 'drizzle_accumulator.dart' show DrizzleResult;
import 'drizzle_gap_fill.dart' show fillChannelGaps;
import 'reconstruct_native_cfa_from_drizzle.dart'
    show InvalidCfaReconstructionInput;

/// Tiled-*read* counterpart to `reconstruct_native_cfa_from_drizzle.
/// dart`'s own whole-image function, reading `drizzleCfaTiled`'s
/// (Work87) own `valueStore`/`coverageStore` in row strips (bounding
/// peak read memory, matching `applyLocalToneAdaptationTiled`'s own
/// (Work101) strip-based surround pass) rather than requiring the
/// caller to already have both planes fully materialized as flat
/// arrays.
///
/// The *output*, unlike `fillDrizzleTiledGaps`'s (Work92) own tiled-
/// write design, is still one single, fully-materialized
/// [LinearRawMosaic] — not written tile by tile to a store. This is
/// deliberate, not an oversight: this reconstruction exists specifically
/// to feed the existing demosaic engine (`mobile_stack_adaptive_
/// demosaic_engine.dart`), whose own `DemosaicRequest.mosaic` field
/// already requires the *whole* mosaic in memory at once (neighboring
/// pixels across any internal tile boundary are needed for its own
/// convolution/interpolation) — the same requirement this project's
/// existing RAW decode/calibration stages already carry for an ordinary
/// single camera exposure, at the same native resolution this
/// reconstruction targets (`outputScale = 1`), so this is not a new or
/// larger memory requirement than what already exists elsewhere in this
/// project for a single frame.
///
/// See `reconstruct_native_cfa_from_drizzle.dart`'s own doc comment for
/// the full design rationale (native CFA phase, `outputScale = 1`
/// scope, why other channels' data is intentionally left unused at each
/// position).
///
/// This file has not been executed against the Dart SDK. Its own new
/// logic — strip-based reading combined with the already-tested
/// per-pixel channel-selection math — has direct test coverage in
/// `test/tiled_reconstruct_native_cfa_from_drizzle_test.dart`, which
/// additionally confirms this version's output matches the whole-image
/// `reconstructNativeCfaMosaicFromDrizzle` exactly on the same
/// synthetic value/coverage data, the same "tiled version matches the
/// whole-frame version exactly" discipline established for
/// `tiled_cfa_drizzle.dart` (Work87) and `tiled_drizzle_gap_fill.dart`
/// (Work92).

/// Reconstructs a single, native-resolution [LinearRawMosaic] by
/// reading [valueStore]/[coverageStore] (`drizzleCfaTiled`'s own
/// output, both already committed) in row strips of [stripHeight] rows
/// each.
///
/// - [referenceCfaPattern], [gapFillKernelRadius],
///   [gapFillMinimumCoverage]: as `reconstructNativeCfaMosaicFromDrizzle`.
///
/// Throws [InvalidCfaReconstructionInput] if [valueStore]/
/// [coverageStore] have mismatched dimensions.
Future<LinearRawMosaic> reconstructNativeCfaMosaicFromDrizzleTiled({
  required LinearRgbTileStore valueStore,
  required LinearRgbTileStore coverageStore,
  LinearRgbTileStore? saturationCoverageStore,
  LinearRgbTileStore? saturationDecisionCoverageStore,
  required CfaPattern referenceCfaPattern,
  int stripHeight = 128,
  int gapFillKernelRadius = 2,
  double gapFillMinimumCoverage = 1e-6,
  double minimumSaturationFraction = 0.5,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  if (valueStore.width != coverageStore.width ||
      valueStore.height != coverageStore.height) {
    throw InvalidCfaReconstructionInput(
      'valueStore and coverageStore must have matching dimensions.',
    );
  }
  if (saturationCoverageStore != null &&
      (saturationCoverageStore.width != valueStore.width ||
          saturationCoverageStore.height != valueStore.height)) {
    throw InvalidCfaReconstructionInput(
      'saturationCoverageStore must match the valueStore dimensions.',
    );
  }
  if (saturationDecisionCoverageStore != null &&
      (saturationDecisionCoverageStore.width != valueStore.width ||
          saturationDecisionCoverageStore.height != valueStore.height)) {
    throw InvalidCfaReconstructionInput(
      'saturationDecisionCoverageStore must match the valueStore dimensions.',
    );
  }
  if (saturationDecisionCoverageStore != null &&
      saturationCoverageStore == null) {
    throw InvalidCfaReconstructionInput(
      'saturationDecisionCoverageStore requires saturationCoverageStore.',
    );
  }
  if (!minimumSaturationFraction.isFinite ||
      minimumSaturationFraction <= 0 ||
      minimumSaturationFraction > 1) {
    throw InvalidCfaReconstructionInput(
      'minimumSaturationFraction must be finite and in (0, 1].',
    );
  }
  final int width = valueStore.width;
  final int height = valueStore.height;

  // 3チャンネル分のvalue/coverageを、画像全体でまず1つずつ集める
  // (ギャップ埋め自体が画像全体の近傍を必要とするため、Work92の
  // fillDrizzleTiledGapsと同様、ここは避けられないコスト)。
  final List<Float64List> channelValues = <Float64List>[
    for (int c = 0; c < 3; c++) Float64List(width * height),
  ];
  final List<Float64List> channelCoverages = <Float64List>[
    for (int c = 0; c < 3; c++) Float64List(width * height),
  ];
  final Float32List? nativeSaturationCoverage =
      saturationCoverageStore == null ? null : Float32List(width * height);
  final Float32List? nativeSaturationDecisionCoverage =
      saturationDecisionCoverageStore == null
          ? null
          : Float32List(width * height);

  for (int y = 0; y < height; y += stripHeight) {
    if (isCancelled?.call() ?? false) {
      throw StateError('Native CFA reconstruction was cancelled.');
    }
    final int rowsInStrip =
        (y + stripHeight <= height) ? stripHeight : height - y;
    final LinearRgbTile valueStrip = await valueStore.readRegion(
      x: 0,
      y: y,
      width: width,
      height: rowsInStrip,
    );
    final LinearRgbTile coverageStrip = await coverageStore.readRegion(
      x: 0,
      y: y,
      width: width,
      height: rowsInStrip,
    );
    final LinearRgbTile? saturationStrip = saturationCoverageStore == null
        ? null
        : await saturationCoverageStore.readRegion(
            x: 0,
            y: y,
            width: width,
            height: rowsInStrip,
          );
    final LinearRgbTile? saturationDecisionStrip =
        saturationDecisionCoverageStore == null
            ? null
            : await saturationDecisionCoverageStore.readRegion(
                x: 0,
                y: y,
                width: width,
                height: rowsInStrip,
              );
    for (int localY = 0; localY < rowsInStrip; localY++) {
      final int globalRowStart = (y + localY) * width;
      for (int x = 0; x < width; x++) {
        final int globalIndex = globalRowStart + x;
        final int nativeChannel =
            referenceCfaPattern.colorAt(x, y + localY).index;
        if (saturationStrip != null) {
          final double saturationCoverage =
              saturationStrip.channelAt(x, localY, nativeChannel);
          if (!saturationCoverage.isFinite || saturationCoverage < 0) {
            throw InvalidCfaReconstructionInput(
              'Saturation coverage must be finite and non-negative.',
            );
          }
          nativeSaturationCoverage![globalIndex] = saturationCoverage;
          if (saturationDecisionStrip != null) {
            final double decisionCoverage = saturationDecisionStrip.channelAt(
              x,
              localY,
              nativeChannel,
            );
            if (!decisionCoverage.isFinite || decisionCoverage < 0) {
              throw InvalidCfaReconstructionInput(
                'Saturation decision coverage must be finite and non-negative.',
              );
            }
            nativeSaturationDecisionCoverage![globalIndex] = decisionCoverage;
          }
        }
        for (int c = 0; c < 3; c++) {
          final double value = valueStrip.channelAt(x, localY, c);
          final double coverage = coverageStrip.channelAt(x, localY, c);
          if (!value.isFinite || !coverage.isFinite || coverage < 0) {
            throw InvalidCfaReconstructionInput(
              'Drizzle reconstruction input must contain finite values '
              'and finite non-negative coverage.',
            );
          }
          channelValues[c][globalIndex] = value;
          channelCoverages[c][globalIndex] = coverage;
        }
      }
    }
    reportProgress?.call(0.5 * (y + rowsInStrip) / height);
  }

  final List<DrizzleResult> filledChannels = <DrizzleResult>[
    for (int c = 0; c < 3; c++)
      fillChannelGaps(
        DrizzleResult(
          width: width,
          height: height,
          value: channelValues[c],
          coverage: channelCoverages[c],
        ),
        width,
        height,
        kernelRadius: gapFillKernelRadius,
        minimumCoverage: gapFillMinimumCoverage,
      ),
  ];

  final Float32List samples = Float32List(width * height);
  final Uint8List? saturationFlags =
      nativeSaturationCoverage == null ? null : Uint8List(width * height);
  for (int y = 0; y < height; y++) {
    if (isCancelled?.call() ?? false) {
      throw StateError('Native CFA reconstruction was cancelled.');
    }
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      final int channelIndex = referenceCfaPattern.colorAt(x, y).index;
      samples[index] = filledChannels[channelIndex].value[index];
      if (saturationFlags != null) {
        final double validCoverage = channelCoverages[channelIndex][index];
        final double saturationDecisionCoverage =
            nativeSaturationDecisionCoverage?[index] ?? validCoverage;
        final double saturatedCoverage = nativeSaturationCoverage![index];
        final double observedCoverage =
            saturationDecisionCoverage + saturatedCoverage;
        if (observedCoverage > gapFillMinimumCoverage &&
            saturatedCoverage / observedCoverage >= minimumSaturationFraction) {
          saturationFlags[index] = 1;
        }
      }
    }
    reportProgress?.call(0.5 + 0.5 * (y + 1) / height);
  }

  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: referenceCfaPattern,
    samples: samples,
    saturationMask: saturationFlags == null
        ? null
        : RawSaturationMask.fromPredicate(
            saturationFlags.length,
            (int index) => saturationFlags[index] != 0,
          ),
  );
}

/// File-backed result for streamed native-CFA reconstruction.
///
/// [store] owns the reconstructed Float32 CFA plane on disk.  The compact
/// [saturationMask] is retained in memory because it is one bit per sensor
/// pixel and the current native demosaic ABI consumes the full packed mask.
final class FileBackedReconstructedCfa {
  const FileBackedReconstructedCfa({
    required this.store,
    required this.saturationMask,
  });

  final FileBackedLinearRawMosaicStore store;
  final RawSaturationMask? saturationMask;
}

/// Memory-bounded counterpart of [reconstructNativeCfaMosaicFromDrizzleTiled].
///
/// The legacy tiled reconstruction bounded *reads* but still materialized
/// six full Float64 planes (three value + three coverage), optional
/// saturation planes and one final full Float32 CFA plane.  This function
/// preserves the same per-pixel gap-fill rule while processing full-width
/// row strips with only [kernelRadius] halo rows and writing the selected
/// native-CFA channel directly to [FileBackedLinearRawMosaicStore].
///
/// The only image-sized resident side structure is the packed one-bit
/// saturation mask when saturation coverage is present.
Future<FileBackedReconstructedCfa>
    reconstructNativeCfaStoreFromDrizzleStreamed({
  required LinearRgbTileStore valueStore,
  required LinearRgbTileStore coverageStore,
  LinearRgbTileStore? saturationCoverageStore,
  LinearRgbTileStore? saturationDecisionCoverageStore,
  required CfaPattern referenceCfaPattern,
  int stripHeight = 128,
  int kernelRadius = 2,
  double minimumCoverage = 1e-6,
  double minimumSaturationFraction = 0.5,
  bool Function()? isCancelled,
  void Function(double progress)? reportProgress,
}) async {
  if (valueStore.width != coverageStore.width ||
      valueStore.height != coverageStore.height) {
    throw InvalidCfaReconstructionInput(
      'valueStore and coverageStore must have matching dimensions.',
    );
  }
  if (saturationCoverageStore != null &&
      (saturationCoverageStore.width != valueStore.width ||
          saturationCoverageStore.height != valueStore.height)) {
    throw InvalidCfaReconstructionInput(
      'saturationCoverageStore must match the valueStore dimensions.',
    );
  }
  if (saturationDecisionCoverageStore != null &&
      (saturationDecisionCoverageStore.width != valueStore.width ||
          saturationDecisionCoverageStore.height != valueStore.height)) {
    throw InvalidCfaReconstructionInput(
      'saturationDecisionCoverageStore must match the valueStore dimensions.',
    );
  }
  if (saturationDecisionCoverageStore != null &&
      saturationCoverageStore == null) {
    throw InvalidCfaReconstructionInput(
      'saturationDecisionCoverageStore requires saturationCoverageStore.',
    );
  }
  if (stripHeight <= 0) {
    throw InvalidCfaReconstructionInput('stripHeight must be positive.');
  }
  if (kernelRadius < 1) {
    throw InvalidCfaReconstructionInput('kernelRadius must be positive.');
  }
  if (!minimumCoverage.isFinite || minimumCoverage <= 0) {
    throw InvalidCfaReconstructionInput(
      'minimumCoverage must be finite and positive.',
    );
  }
  if (!minimumSaturationFraction.isFinite ||
      minimumSaturationFraction <= 0 ||
      minimumSaturationFraction > 1) {
    throw InvalidCfaReconstructionInput(
      'minimumSaturationFraction must be finite and in (0, 1].',
    );
  }

  final int width = valueStore.width;
  final int height = valueStore.height;
  final int pixelCount = width * height;
  final Uint8List? packedSaturation =
      saturationCoverageStore == null ? null : Uint8List((pixelCount + 7) >> 3);
  int saturatedCount = 0;

  final FileBackedLinearRawMosaicStore output =
      await FileBackedLinearRawMosaicStore.createTemporary(
    width: width,
    height: height,
    cfaPattern: referenceCfaPattern,
  );
  bool committed = false;
  try {
    for (int outputY = 0; outputY < height; outputY += stripHeight) {
      if (isCancelled?.call() ?? false) {
        throw StateError('Native CFA reconstruction was cancelled.');
      }
      final int rows =
          (outputY + stripHeight <= height) ? stripHeight : height - outputY;
      final int regionY = (outputY - kernelRadius).clamp(0, height - 1);
      final int regionBottom =
          (outputY + rows - 1 + kernelRadius).clamp(0, height - 1);
      final int regionHeight = regionBottom - regionY + 1;

      final LinearRgbTile values = await valueStore.readRegion(
        x: 0,
        y: regionY,
        width: width,
        height: regionHeight,
      );
      final LinearRgbTile coverages = await coverageStore.readRegion(
        x: 0,
        y: regionY,
        width: width,
        height: regionHeight,
      );
      final LinearRgbTile? saturation = saturationCoverageStore == null
          ? null
          : await saturationCoverageStore.readRegion(
              x: 0,
              y: regionY,
              width: width,
              height: regionHeight,
            );
      final LinearRgbTile? saturationDecision =
          saturationDecisionCoverageStore == null
              ? null
              : await saturationDecisionCoverageStore.readRegion(
                  x: 0,
                  y: regionY,
                  width: width,
                  height: regionHeight,
                );

      final Float32List outputSamples = Float32List(width * rows);
      for (int localOutputY = 0; localOutputY < rows; localOutputY++) {
        final int globalY = outputY + localOutputY;
        final int localRegionY = globalY - regionY;
        for (int x = 0; x < width; x++) {
          final int channel = referenceCfaPattern.colorAt(x, globalY).index;
          final int center = (localRegionY * width + x) * 3 + channel;
          final double ownCoverage = coverages.interleavedRgb[center];
          final double ownValue = values.interleavedRgb[center];
          if (!ownCoverage.isFinite || ownCoverage < 0 || !ownValue.isFinite) {
            throw InvalidCfaReconstructionInput(
              'Drizzle reconstruction input must contain finite values '
              'and finite non-negative coverage.',
            );
          }

          double filledValue;
          if (ownCoverage >= minimumCoverage) {
            filledValue = ownValue;
          } else {
            double weightedValueSum = 0;
            double coverageSum = 0;
            final int minGlobalY =
                (globalY - kernelRadius).clamp(0, height - 1);
            final int maxGlobalY =
                (globalY + kernelRadius).clamp(0, height - 1);
            final int minX = (x - kernelRadius).clamp(0, width - 1);
            final int maxX = (x + kernelRadius).clamp(0, width - 1);
            for (int sampleY = minGlobalY; sampleY <= maxGlobalY; sampleY++) {
              final int regionLocalY = sampleY - regionY;
              for (int sampleX = minX; sampleX <= maxX; sampleX++) {
                final int neighbor =
                    (regionLocalY * width + sampleX) * 3 + channel;
                final double neighborCoverage =
                    coverages.interleavedRgb[neighbor];
                final double neighborValue = values.interleavedRgb[neighbor];
                if (!neighborCoverage.isFinite ||
                    neighborCoverage < 0 ||
                    !neighborValue.isFinite) {
                  throw InvalidCfaReconstructionInput(
                    'Drizzle reconstruction input must contain finite values '
                    'and finite non-negative coverage.',
                  );
                }
                if (neighborCoverage < minimumCoverage) continue;
                weightedValueSum += neighborValue * neighborCoverage;
                coverageSum += neighborCoverage;
              }
            }
            filledValue = coverageSum > 0 ? weightedValueSum / coverageSum : 0;
          }
          if (!filledValue.isFinite) {
            throw InvalidCfaReconstructionInput(
              'Gap-filled CFA reconstruction produced a non-finite value.',
            );
          }
          outputSamples[localOutputY * width + x] = filledValue;

          if (saturation != null) {
            final double saturatedCoverage = saturation.interleavedRgb[center];
            final double decisionCoverage = saturationDecision == null
                ? ownCoverage
                : saturationDecision.interleavedRgb[center];
            if (!saturatedCoverage.isFinite ||
                saturatedCoverage < 0 ||
                !decisionCoverage.isFinite ||
                decisionCoverage < 0) {
              throw InvalidCfaReconstructionInput(
                'Saturation coverage must be finite and non-negative.',
              );
            }
            final double observedCoverage =
                decisionCoverage + saturatedCoverage;
            if (observedCoverage > minimumCoverage &&
                saturatedCoverage / observedCoverage >=
                    minimumSaturationFraction) {
              final int index = globalY * width + x;
              packedSaturation![index >> 3] |= 1 << (index & 7);
              saturatedCount += 1;
            }
          }
        }
      }

      await output.writeRows(
        y: outputY,
        rowCount: rows,
        samples: outputSamples,
      );
      reportProgress?.call((outputY + rows) / height);
    }

    final RawSaturationMask? mask = packedSaturation == null
        ? null
        : RawSaturationMask.takePackedBytes(
            pixelCount: pixelCount,
            packedBytes: packedSaturation,
            saturatedCount: saturatedCount,
          );
    await output.commitRowWrites(
      packedSaturationMask: packedSaturation,
      hasSaturatedPixels: saturatedCount > 0,
    );
    committed = true;
    return FileBackedReconstructedCfa(
      store: output,
      saturationMask: mask,
    );
  } finally {
    if (!committed) {
      await output.abort();
    }
  }
}
