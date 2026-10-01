import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/raw_saturation_mask.dart';
import '../registration/luminance_plane.dart';

/// Dart port of `tool/raw_samples/extract_green_luminance_from_mosaic_
/// reference.mjs`.
///
/// Registration (star detection + transform estimation) for a CFA-
/// domain-drizzle-based stacking pipeline (`tiled_cfa_drizzle.dart`,
/// Work87) must happen *before* demosaicing — drizzle itself is what
/// stands in for demosaicing here, applied only after frames are
/// aligned and combined. But every registration tool this project has
/// (`star_detector.dart`, `star_transform_estimator.dart`) expects a
/// plain [LuminancePlane], not raw Bayer data — this function bridges
/// that gap directly from a [LinearRawMosaic], without a full demosaic
/// pass.
///
/// Deliberately *not* a full demosaic: for star detection specifically,
/// only a reasonably sharp, reasonably accurate luminance proxy is
/// needed to find each star's centroid — the full color-aware,
/// gradient-adaptive interpolation this project's real demosaic engine
/// performs is unnecessary work for this purpose, and registration
/// happens once per frame, so keeping this step cheap matters for
/// overall pipeline cost. Green was chosen as the channel to extract
/// (not red, blue, or a weighted luminance combining all three) because
/// it already has the CFA's own highest native sampling density (half
/// of every Bayer-pattern mosaic's pixels are green) — the sharpest,
/// least-interpolated channel directly available from the mosaic —
/// matching every other star/streak detector in this project's own
/// established choice to operate on a green-channel proxy (see
/// `milky_way_pipeline.dart`'s/`meteor_pipeline.dart`'s identical
/// `_greenChannelOf` for already-demosaiced data).
///
/// Unlike the Node reference (which reimplements CFA-pattern-to-color
/// logic locally, then cross-checks it in its own test against this
/// project's already-established `cfaColorAt`), this Dart port simply
/// calls the already-existing, already-tested `CfaPattern.colorAt`
/// directly — no reimplementation, no risk of drifting out of sync with
/// it.
///
/// Unlike the Node reference (which validates `mosaic`'s own dimensions/
/// sample-count consistency and CFA pattern), this Dart port has no
/// input validation of its own to perform: [LinearRawMosaic]'s own
/// constructor already enforces dimension/sample-count consistency (an
/// invalid mosaic object cannot exist to be passed in), and
/// [CfaPattern] is itself a Dart `enum` with exactly the four supported
/// values — there is no "unsupported pattern" value the type system
/// would even let a caller construct. Both of the Node reference's
/// validation branches are therefore unreachable here, the same
/// "Node-level validation made unreachable by Dart's own type system"
/// situation this project's other ports have documented before (e.g.
/// `lighten_blend_combiner.dart`, Work48).
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/extract_green_luminance_from_mosaic_
/// test.dart` before relying on this in production.

/// Extracts a green-channel [LuminancePlane] from a raw CFA [mosaic].
///
/// At every mosaic position that is *itself* a green sample (half of all
/// positions, in any standard Bayer pattern), that sample's own value is
/// used directly and exactly — never smoothed or blended, since it is
/// already real, directly-measured data. At every non-green (red or
/// blue) position, the value is filled in by averaging whichever of its
/// four orthogonal neighbors (up, down, left, right — always green
/// themselves, in every standard Bayer pattern, since green positions
/// form a checkerboard) exist within the mosaic's own bounds; a corner
/// pixel with only two in-bounds neighbors averages just those two,
/// rather than treating a missing out-of-bounds neighbor as zero (which
/// would incorrectly darken every edge and corner pixel).
LuminancePlane extractGreenLuminanceFromMosaic(LinearRawMosaic mosaic) {
  final int width = mosaic.width;
  final int height = mosaic.height;
  final Float32List samples = mosaic.samples;
  final Float32List output = Float32List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int index = y * width + x;
      if (mosaic.cfaPattern.colorAt(x, y) == CfaColor.green) {
        output[index] = samples[index];
        continue;
      }
      double sum = 0;
      int count = 0;
      if (x > 0) {
        sum += samples[index - 1];
        count += 1;
      }
      if (x < width - 1) {
        sum += samples[index + 1];
        count += 1;
      }
      if (y > 0) {
        sum += samples[index - width];
        count += 1;
      }
      if (y < height - 1) {
        sum += samples[index + width];
        count += 1;
      }
      // count is always >= 2 for any mosaic at least 2x2 (a green
      // neighbor exists on at least two sides of any non-green
      // position), so division by zero cannot occur for any mosaic
      // size this project's decoders would ever actually produce.
      output[index] = count > 0 ? sum / count : 0;
    }
  }
  return LuminancePlane(width: width, height: height, samples: output);
}

/// Returns the exact set of green-luminance proxy pixels whose value can be
/// influenced by a sensor-saturated green CFA site.
///
/// A native green output pixel reads only its own sensor site. A red/blue
/// output pixel averages its orthogonal green neighbors, matching
/// [extractGreenLuminanceFromMosaic]. Saturated red/blue sites are not read by
/// this proxy and therefore do not invalidate unrelated registration samples.
RawSaturationMask? greenLuminanceSaturationInfluenceMask(
  LinearRawMosaic mosaic,
) {
  final RawSaturationMask? saturation = mosaic.saturationMask;
  if (saturation == null || saturation.isEmpty) return saturation;
  final int width = mosaic.width;
  final int height = mosaic.height;
  return RawSaturationMask.fromPredicate(
    width * height,
    (int index) {
      final int y = index ~/ width;
      final int x = index - y * width;
      if (mosaic.cfaPattern.colorAt(x, y) == CfaColor.green) {
        return saturation.isSaturatedIndex(index);
      }
      if (x > 0 &&
          mosaic.cfaPattern.colorAt(x - 1, y) == CfaColor.green &&
          saturation.isSaturatedIndex(index - 1)) {
        return true;
      }
      if (x + 1 < width &&
          mosaic.cfaPattern.colorAt(x + 1, y) == CfaColor.green &&
          saturation.isSaturatedIndex(index + 1)) {
        return true;
      }
      if (y > 0 &&
          mosaic.cfaPattern.colorAt(x, y - 1) == CfaColor.green &&
          saturation.isSaturatedIndex(index - width)) {
        return true;
      }
      if (y + 1 < height &&
          mosaic.cfaPattern.colorAt(x, y + 1) == CfaColor.green &&
          saturation.isSaturatedIndex(index + width)) {
        return true;
      }
      return false;
    },
  );
}

final class FileBackedGreenLuminanceResult {
  const FileBackedGreenLuminanceResult({
    required this.luminance,
    required this.saturationInfluenceMask,
  });

  final LuminancePlane luminance;
  final RawSaturationMask? saturationInfluenceMask;
}

/// Work307: file-backed equivalent of:
///
///   optional phase-scale harmonization
///   -> extractGreenLuminanceFromMosaic
///   -> greenLuminanceSaturationInfluenceMask
///
/// The final full-resolution single-channel green plane is retained because
/// the established star detector requires random access to it.  The original
/// full-resolution CFA Float32 plane is never materialized in Dart memory.
///
/// [phaseScales], when supplied, are applied to the raw strip in-place before
/// green interpolation. Because the strip samples are Float32, every
/// multiplication is rounded back to Float32 at the same stage as
/// `_applyPhaseScalesInPlace` in the CFA drizzle pipeline.
Future<FileBackedGreenLuminanceResult>
    extractGreenLuminanceFromFileBackedMosaic({
  required FileBackedLinearRawMosaicStore store,
  List<double>? phaseScales,
  int rowsPerStrip = 128,
  bool Function()? isCancelled,
}) async {
  if (rowsPerStrip <= 0) {
    throw ArgumentError.value(rowsPerStrip, 'rowsPerStrip');
  }
  if (phaseScales != null &&
      (phaseScales.length != 4 ||
          phaseScales.any((double value) => !value.isFinite))) {
    throw ArgumentError('RAW white-balance phase scales must be finite.');
  }

  const double maximumFloat32 = 3.4028234663852886e38;
  final int width = store.width;
  final int height = store.height;
  final int pixelCount = width * height;
  final Float32List output = Float32List(pixelCount);

  final Uint8List? packedInfluence =
      !store.hasSaturationMask ? null : Uint8List((pixelCount + 7) >> 3);
  int influencedCount = 0;

  for (int y = 0; y < height; y += rowsPerStrip) {
    if (isCancelled?.call() ?? false) {
      throw StateError('CFA green-luminance extraction was cancelled.');
    }
    final int rows = (y + rowsPerStrip <= height) ? rowsPerStrip : height - y;
    final int readY = y > 0 ? y - 1 : y;
    final int readBottom = (y + rows < height) ? y + rows : height - 1;
    final int readRows = readBottom - readY + 1;

    final Float32List region = await store.readRegion(
      x: 0,
      y: readY,
      width: width,
      height: readRows,
    );

    // Match the old full-frame harmonization rounding boundary exactly:
    // multiply, range-check, assign back into Float32List, then consume.
    if (phaseScales != null) {
      for (int localY = 0; localY < readRows; localY++) {
        final int globalY = readY + localY;
        final int rowStart = localY * width;
        for (int x = 0; x < width; x++) {
          final int index = rowStart + x;
          final double scaled =
              region[index] * phaseScales[((globalY & 1) << 1) | (x & 1)];
          if (!scaled.isFinite || scaled.abs() > maximumFloat32) {
            throw StateError(
              'White-balance harmonization exceeds finite Float32 range.',
            );
          }
          region[index] = scaled;
        }
      }
    }

    final RawSaturationMask? sat = store.hasSaturationMask
        ? await store.readSaturationRegion(
            x: 0,
            y: readY,
            width: width,
            height: readRows,
          )
        : null;

    for (int localOutputY = 0; localOutputY < rows; localOutputY++) {
      final int globalY = y + localOutputY;
      final int regionY = globalY - readY;
      final int regionRow = regionY * width;
      final int outputRow = globalY * width;

      for (int x = 0; x < width; x++) {
        final int regionIndex = regionRow + x;
        final int outputIndex = outputRow + x;
        final bool isGreen =
            store.cfaPattern.colorAt(x, globalY) == CfaColor.green;

        if (isGreen) {
          output[outputIndex] = region[regionIndex];
        } else {
          double sum = 0;
          int count = 0;
          if (x > 0) {
            sum += region[regionIndex - 1];
            count += 1;
          }
          if (x < width - 1) {
            sum += region[regionIndex + 1];
            count += 1;
          }
          if (globalY > 0) {
            sum += region[regionIndex - width];
            count += 1;
          }
          if (globalY < height - 1) {
            sum += region[regionIndex + width];
            count += 1;
          }
          output[outputIndex] = count > 0 ? sum / count : 0;
        }

        if (sat != null) {
          bool influenced = false;
          if (isGreen) {
            influenced = sat.isSaturatedIndex(regionIndex);
          } else {
            if (x > 0 &&
                store.cfaPattern.colorAt(x - 1, globalY) == CfaColor.green &&
                sat.isSaturatedIndex(regionIndex - 1)) {
              influenced = true;
            }
            if (!influenced &&
                x + 1 < width &&
                store.cfaPattern.colorAt(x + 1, globalY) == CfaColor.green &&
                sat.isSaturatedIndex(regionIndex + 1)) {
              influenced = true;
            }
            if (!influenced &&
                globalY > 0 &&
                store.cfaPattern.colorAt(x, globalY - 1) == CfaColor.green &&
                sat.isSaturatedIndex(regionIndex - width)) {
              influenced = true;
            }
            if (!influenced &&
                globalY + 1 < height &&
                store.cfaPattern.colorAt(x, globalY + 1) == CfaColor.green &&
                sat.isSaturatedIndex(regionIndex + width)) {
              influenced = true;
            }
          }
          if (influenced) {
            packedInfluence![outputIndex >> 3] |= 1 << (outputIndex & 7);
            influencedCount += 1;
          }
        }
      }
    }
  }

  final RawSaturationMask? influence = packedInfluence == null
      ? null
      : RawSaturationMask.takePackedBytes(
          pixelCount: pixelCount,
          packedBytes: packedInfluence,
          saturatedCount: influencedCount,
        );
  return FileBackedGreenLuminanceResult(
    luminance: LuminancePlane(
      width: width,
      height: height,
      samples: output,
    ),
    saturationInfluenceMask: influence,
  );
}
