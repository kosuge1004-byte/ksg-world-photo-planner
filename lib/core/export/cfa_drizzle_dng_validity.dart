import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/linear_rgb_tile_store.dart';
import '../image/raw_saturation_mask.dart';
import 'linear_dng_writer.dart';

void _validateCoverageInputs({
  required LinearRgbTileStore coverageStore,
  required double minimumCoverage,
}) {
  if (!minimumCoverage.isFinite || minimumCoverage <= 0) {
    throw ArgumentError(
      'minimumCoverage must be finite and positive.',
    );
  }
  if (coverageStore.width <= 0 || coverageStore.height <= 0) {
    throw ArgumentError('Coverage-store dimensions must be positive.');
  }
}

/// Streaming validity source for direct-RGB CFA drizzle Linear DNG export.
///
/// This computes the same validity predicate as
/// [buildCfaDrizzleRgbTransparencyMask] but only for the requested rows, so a
/// 24 MP export does not need an additional ~24 MB full-frame Uint8 mask.
final class CfaDrizzleRgbTransparencyMaskSource
    implements LinearDngTransparencyMaskSource {
  CfaDrizzleRgbTransparencyMaskSource({
    required this.coverageStore,
    this.saturationCoverageStore,
    this.saturationDecisionCoverageStore,
    required this.minimumCoverage,
    this.minimumSaturationFraction = 0.5,
    this.isCancelled,
  }) {
    _validateCoverageInputs(
      coverageStore: coverageStore,
      minimumCoverage: minimumCoverage,
    );
    if (!minimumSaturationFraction.isFinite ||
        minimumSaturationFraction <= 0 ||
        minimumSaturationFraction > 1) {
      throw ArgumentError(
        'minimumSaturationFraction must be finite and in (0, 1].',
      );
    }
    if (saturationCoverageStore != null &&
        (saturationCoverageStore!.width != coverageStore.width ||
            saturationCoverageStore!.height != coverageStore.height)) {
      throw ArgumentError(
        'saturationCoverageStore must match coverageStore dimensions.',
      );
    }
    if (saturationDecisionCoverageStore != null &&
        (saturationDecisionCoverageStore!.width != coverageStore.width ||
            saturationDecisionCoverageStore!.height != coverageStore.height)) {
      throw ArgumentError(
        'saturationDecisionCoverageStore must match coverageStore dimensions.',
      );
    }
    if (saturationDecisionCoverageStore != null &&
        saturationCoverageStore == null) {
      throw ArgumentError(
        'saturationDecisionCoverageStore requires saturationCoverageStore.',
      );
    }
  }

  final LinearRgbTileStore coverageStore;
  final LinearRgbTileStore? saturationCoverageStore;
  final LinearRgbTileStore? saturationDecisionCoverageStore;
  final double minimumCoverage;
  final double minimumSaturationFraction;
  final bool Function()? isCancelled;

  @override
  int get width => coverageStore.width;

  @override
  int get height => coverageStore.height;

  @override
  Future<Uint8List> readRows({
    required int startY,
    required int rowCount,
  }) async {
    if (startY < 0 || rowCount <= 0 || startY + rowCount > height) {
      throw RangeError('Requested CFA drizzle mask rows are out of range.');
    }
    if (isCancelled?.call() ?? false) {
      throw const LinearDngExportCancelled();
    }
    final coverageTile = await coverageStore.readRegion(
      x: 0,
      y: startY,
      width: width,
      height: rowCount,
    );
    final saturationTile = saturationCoverageStore == null
        ? null
        : await saturationCoverageStore!.readRegion(
            x: 0,
            y: startY,
            width: width,
            height: rowCount,
          );
    final saturationDecisionTile = saturationDecisionCoverageStore == null
        ? null
        : await saturationDecisionCoverageStore!.readRegion(
            x: 0,
            y: startY,
            width: width,
            height: rowCount,
          );
    final int pixels = width * rowCount;
    final Uint8List mask = Uint8List(pixels);
    for (int pixel = 0; pixel < pixels; pixel++) {
      if ((pixel & 0x3ffff) == 0 && (isCancelled?.call() ?? false)) {
        throw const LinearDngExportCancelled();
      }
      final int base = pixel * 3;
      bool valid = true;
      for (int channel = 0; channel < 3; channel++) {
        final double survivingCoverage =
            coverageTile.interleavedRgb[base + channel];
        if (!survivingCoverage.isFinite || survivingCoverage < 0) {
          throw ArgumentError('Coverage must be finite and non-negative.');
        }
        if (survivingCoverage < minimumCoverage) {
          valid = false;
          break;
        }
        if (saturationTile != null) {
          final double saturatedCoverage =
              saturationTile.interleavedRgb[base + channel];
          final double decisionCoverage = saturationDecisionTile == null
              ? survivingCoverage
              : saturationDecisionTile.interleavedRgb[base + channel];
          if (!saturatedCoverage.isFinite ||
              saturatedCoverage < 0 ||
              !decisionCoverage.isFinite ||
              decisionCoverage < 0) {
            throw ArgumentError(
              'Saturation coverage must be finite and non-negative.',
            );
          }
          final double observedCoverage = decisionCoverage + saturatedCoverage;
          if (observedCoverage > minimumCoverage &&
              saturatedCoverage / observedCoverage >=
                  minimumSaturationFraction) {
            valid = false;
            break;
          }
        }
      }
      mask[pixel] = valid ? 255 : 0;
    }
    return mask;
  }
}

/// Direct RGB CFA-Drizzle export validity.
///
/// A final RGB pixel is source-supported only when each of its R/G/B drizzle
/// planes has its own coverage >= the exact threshold already used by the
/// gap-fill stage. Gap-filled RGB values remain useful for display, but are
/// marked undefined in the DNG transparency mask because they are synthesized
/// rather than directly supported by all three source planes.
Future<Uint8List> buildCfaDrizzleRgbTransparencyMask({
  required LinearRgbTileStore coverageStore,
  LinearRgbTileStore? saturationCoverageStore,
  LinearRgbTileStore? saturationDecisionCoverageStore,
  required double minimumCoverage,
  double minimumSaturationFraction = 0.5,
  int rowsPerRead = 256,
  bool Function()? isCancelled,
}) async {
  _validateCoverageInputs(
    coverageStore: coverageStore,
    minimumCoverage: minimumCoverage,
  );
  if (rowsPerRead <= 0) {
    throw ArgumentError.value(rowsPerRead, 'rowsPerRead', 'must be positive');
  }
  if (!minimumSaturationFraction.isFinite ||
      minimumSaturationFraction <= 0 ||
      minimumSaturationFraction > 1) {
    throw ArgumentError(
      'minimumSaturationFraction must be finite and in (0, 1].',
    );
  }
  if (saturationCoverageStore != null &&
      (saturationCoverageStore.width != coverageStore.width ||
          saturationCoverageStore.height != coverageStore.height)) {
    throw ArgumentError(
      'saturationCoverageStore must match coverageStore dimensions.',
    );
  }
  if (saturationDecisionCoverageStore != null &&
      (saturationDecisionCoverageStore.width != coverageStore.width ||
          saturationDecisionCoverageStore.height != coverageStore.height)) {
    throw ArgumentError(
      'saturationDecisionCoverageStore must match coverageStore dimensions.',
    );
  }
  if (saturationDecisionCoverageStore != null &&
      saturationCoverageStore == null) {
    throw ArgumentError(
      'saturationDecisionCoverageStore requires saturationCoverageStore.',
    );
  }

  final int width = coverageStore.width;
  final int height = coverageStore.height;
  final Uint8List mask = Uint8List(width * height);

  for (int startY = 0; startY < height; startY += rowsPerRead) {
    if (isCancelled?.call() ?? false) {
      throw const LinearDngExportCancelled();
    }
    final int rows = (height - startY).clamp(0, rowsPerRead).toInt();
    final coverageTile = await coverageStore.readRegion(
      x: 0,
      y: startY,
      width: width,
      height: rows,
    );
    final saturationTile = saturationCoverageStore == null
        ? null
        : await saturationCoverageStore.readRegion(
            x: 0,
            y: startY,
            width: width,
            height: rows,
          );
    final saturationDecisionTile = saturationDecisionCoverageStore == null
        ? null
        : await saturationDecisionCoverageStore.readRegion(
            x: 0,
            y: startY,
            width: width,
            height: rows,
          );
    for (int pixel = 0; pixel < width * rows; pixel++) {
      final int base = pixel * 3;
      bool valid = true;
      for (int channel = 0; channel < 3; channel++) {
        final double survivingCoverage =
            coverageTile.interleavedRgb[base + channel];
        if (!survivingCoverage.isFinite || survivingCoverage < 0) {
          throw ArgumentError(
            'Coverage must be finite and non-negative.',
          );
        }
        if (survivingCoverage < minimumCoverage) {
          valid = false;
          break;
        }
        if (saturationTile != null) {
          final double saturatedCoverage =
              saturationTile.interleavedRgb[base + channel];
          final double decisionCoverage = saturationDecisionTile == null
              ? survivingCoverage
              : saturationDecisionTile.interleavedRgb[base + channel];
          if (!saturatedCoverage.isFinite ||
              saturatedCoverage < 0 ||
              !decisionCoverage.isFinite ||
              decisionCoverage < 0) {
            throw ArgumentError(
              'Saturation coverage must be finite and non-negative.',
            );
          }
          final double observedCoverage = decisionCoverage + saturatedCoverage;
          if (observedCoverage > minimumCoverage &&
              saturatedCoverage / observedCoverage >=
                  minimumSaturationFraction) {
            valid = false;
            break;
          }
        }
      }
      mask[startY * width + pixel] = valid ? 255 : 0;
    }
  }
  return mask;
}

/// Native-CFA reconstruction + adaptive-demosaic export validity.
///
/// Each CFA output site has one physically sampled color plane. If that native
/// plane lacks the same minimum coverage used by reconstruction gap filling,
/// the site is source-undefined. Existing reconstructed saturation/invalid
/// state is unioned with that condition. The adaptive demosaic engine reads a
/// radius reported by the production demosaic backend, so the undefined
/// influence mask is expanded by that exact support before
/// being converted to the final RGB transparency mask.
Future<Uint8List> buildCfaDrizzleDemosaicTransparencyMask({
  required LinearRgbTileStore coverageStore,
  required CfaPattern referenceCfaPattern,
  required double minimumCoverage,
  RawSaturationMask? reconstructedInvalidMask,
  required int requiredInputRadius,
  int rowsPerRead = 256,
  bool Function()? isCancelled,
}) async {
  _validateCoverageInputs(
    coverageStore: coverageStore,
    minimumCoverage: minimumCoverage,
  );
  if (rowsPerRead <= 0) {
    throw ArgumentError.value(rowsPerRead, 'rowsPerRead', 'must be positive');
  }
  if (requiredInputRadius < 0) {
    throw ArgumentError.value(
      requiredInputRadius,
      'requiredInputRadius',
      'must be non-negative',
    );
  }

  final int width = coverageStore.width;
  final int height = coverageStore.height;
  if (reconstructedInvalidMask != null &&
      reconstructedInvalidMask.pixelCount != width * height) {
    throw ArgumentError(
      'Reconstructed invalid-mask dimensions do not match coverage store.',
    );
  }

  final Uint8List sourceInvalid = Uint8List(width * height);
  for (int startY = 0; startY < height; startY += rowsPerRead) {
    if (isCancelled?.call() ?? false) {
      throw const LinearDngExportCancelled();
    }
    final int rows = (height - startY).clamp(0, rowsPerRead).toInt();
    final tile = await coverageStore.readRegion(
      x: 0,
      y: startY,
      width: width,
      height: rows,
    );
    for (int localY = 0; localY < rows; localY++) {
      final int globalY = startY + localY;
      for (int x = 0; x < width; x++) {
        final int globalIndex = globalY * width + x;
        final int channel = referenceCfaPattern.colorAt(x, globalY).index;
        final double coverage = tile.channelAt(x, localY, channel);
        if (!coverage.isFinite || coverage < 0) {
          throw ArgumentError(
            'Coverage must be finite and non-negative.',
          );
        }
        if (coverage < minimumCoverage ||
            (reconstructedInvalidMask?.isSaturatedIndex(globalIndex) ??
                false)) {
          sourceInvalid[globalIndex] = 1;
        }
      }
    }
  }

  final RawSaturationMask rawInvalid = RawSaturationMask.fromPredicate(
    width * height,
    (int index) => sourceInvalid[index] != 0,
  );
  final RawSaturationMask influenced = rawInvalid.dilatedChebyshev(
    width: width,
    height: height,
    radius: requiredInputRadius,
  );

  final Uint8List mask = Uint8List(width * height);
  for (int index = 0; index < mask.length; index++) {
    mask[index] = influenced.isSaturatedIndex(index) ? 0 : 255;
  }
  return mask;
}

/// Streaming counterpart of [buildCfaDrizzleDemosaicTransparencyMask].
///
/// For each requested output row block, this reads only the coverage rows
/// needed by the production demosaic support radius and evaluates the exact
/// same source-invalid predicate:
///
///   native-CFA coverage < minimumCoverage
///   OR reconstructedInvalidMask bit set
///
/// The final RGB pixel is invalid iff any source-invalid site lies within the
/// Chebyshev support radius.  This is exactly the boolean result of
/// `RawSaturationMask.dilatedChebyshev`, but no full-image sourceInvalid,
/// dilated mask, or output Uint8 mask is materialized.
final class CfaDrizzleDemosaicTransparencyMaskSource
    implements LinearDngTransparencyMaskSource {
  CfaDrizzleDemosaicTransparencyMaskSource({
    required this.coverageStore,
    required this.referenceCfaPattern,
    required this.minimumCoverage,
    this.reconstructedInvalidMask,
    required this.requiredInputRadius,
    this.isCancelled,
  }) {
    _validateCoverageInputs(
      coverageStore: coverageStore,
      minimumCoverage: minimumCoverage,
    );
    if (requiredInputRadius < 0) {
      throw ArgumentError.value(
        requiredInputRadius,
        'requiredInputRadius',
        'must be non-negative',
      );
    }
    if (reconstructedInvalidMask != null &&
        reconstructedInvalidMask!.pixelCount !=
            coverageStore.width * coverageStore.height) {
      throw ArgumentError(
        'Reconstructed invalid-mask dimensions do not match coverage store.',
      );
    }
  }

  final LinearRgbTileStore coverageStore;
  final CfaPattern referenceCfaPattern;
  final double minimumCoverage;
  final RawSaturationMask? reconstructedInvalidMask;
  final int requiredInputRadius;
  final bool Function()? isCancelled;

  @override
  int get width => coverageStore.width;

  @override
  int get height => coverageStore.height;

  @override
  Future<Uint8List> readRows({
    required int startY,
    required int rowCount,
  }) async {
    if (startY < 0 || rowCount <= 0 || startY + rowCount > height) {
      throw RangeError('Requested CFA demosaic mask rows are out of range.');
    }
    if (isCancelled?.call() ?? false) {
      throw const LinearDngExportCancelled();
    }

    final int haloTop =
        (startY - requiredInputRadius).clamp(0, height - 1).toInt();
    final int haloBottom = (startY + rowCount - 1 + requiredInputRadius)
        .clamp(0, height - 1)
        .toInt();
    final int haloRows = haloBottom - haloTop + 1;

    final coverage = await coverageStore.readRegion(
      x: 0,
      y: haloTop,
      width: width,
      height: haloRows,
    );

    // One bit per source site for just this haloed row block.
    final int haloPixels = width * haloRows;
    final Uint8List invalidBits = Uint8List((haloPixels + 7) >> 3);

    bool localInvalid(int localIndex) =>
        (invalidBits[localIndex >> 3] & (1 << (localIndex & 7))) != 0;

    void setLocalInvalid(int localIndex) {
      invalidBits[localIndex >> 3] |= 1 << (localIndex & 7);
    }

    // Build the exact native-CFA source-invalid predicate.
    for (int localY = 0; localY < haloRows; localY++) {
      if ((localY & 0x0f) == 0 && (isCancelled?.call() ?? false)) {
        throw const LinearDngExportCancelled();
      }
      final int globalY = haloTop + localY;
      for (int x = 0; x < width; x++) {
        final int globalIndex = globalY * width + x;
        final int channel = referenceCfaPattern.colorAt(x, globalY).index;
        final double value = coverage.channelAt(x, localY, channel);
        if (!value.isFinite || value < 0) {
          throw ArgumentError(
            'Coverage must be finite and non-negative.',
          );
        }
        if (value < minimumCoverage ||
            (reconstructedInvalidMask?.isSaturatedIndex(globalIndex) ??
                false)) {
          setLocalInvalid(localY * width + x);
        }
      }
    }

    final Uint8List output = Uint8List(width * rowCount);

    // Exact Chebyshev dilation, limited to the requested output rows.
    for (int outputLocalY = 0; outputLocalY < rowCount; outputLocalY++) {
      if ((outputLocalY & 0x0f) == 0 && (isCancelled?.call() ?? false)) {
        throw const LinearDngExportCancelled();
      }
      final int globalY = startY + outputLocalY;
      final int y0 =
          (globalY - requiredInputRadius).clamp(0, height - 1).toInt();
      final int y1 =
          (globalY + requiredInputRadius).clamp(0, height - 1).toInt();

      for (int x = 0; x < width; x++) {
        final int x0 = (x - requiredInputRadius).clamp(0, width - 1).toInt();
        final int x1 = (x + requiredInputRadius).clamp(0, width - 1).toInt();
        bool invalid = false;
        for (int yy = y0; yy <= y1 && !invalid; yy++) {
          final int localRow = (yy - haloTop) * width;
          for (int xx = x0; xx <= x1; xx++) {
            if (localInvalid(localRow + xx)) {
              invalid = true;
              break;
            }
          }
        }
        output[outputLocalY * width + x] = invalid ? 0 : 255;
      }
    }
    return output;
  }
}
