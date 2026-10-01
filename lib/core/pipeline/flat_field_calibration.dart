import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';

/// Dart port of `tool/raw_samples/flat_field_calibration_reference.mjs`.
///
/// Another classic astrophotography correction, alongside dark frame
/// subtraction (`dark_frame_subtraction.dart`, Work96), this project
/// did not have until now (Work98). See the Node reference's own doc
/// comment for the full rationale — in short: lens vignetting and dust
/// shadows are *multiplicative*, *fixed-to-the-optical-path* effects
/// that a "flat frame" (an exposure of something uniformly lit, through
/// the same lens/aperture as the real shots) measures directly, the
/// same way a dark frame measures the sensor's own fixed, additive
/// thermal pattern.
///
/// [computeMasterFlat] combines several flat frames via a per-pixel
/// median (the same outlier-robustness rationale as
/// `computeMasterDark`), then normalizes each CFA color plane to be centered
/// around `1.0`; [applyFlatFieldCorrection] divides one light frame's
/// raw mosaic by the master flat, pixel by pixel, leaving a position
/// unusably close to zero (a heavily vignetted corner) untouched rather
/// than dividing by it and amplifying its own noise wildly.
///
/// Both operate directly on raw (Bayer) CFA mosaics, before
/// demosaicing, matching `dark_frame_subtraction.dart`'s own established
/// practice.
///
/// Flat frames are expected to already be dark-subtracted themselves
/// before being passed to [computeMasterFlat] — this module does not
/// perform that step itself, matching this project's own established
/// practice of keeping each calibration stage a distinct,
/// independently-testable unit.
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/flat_field_calibration_test.dart`
/// before relying on this in production.

class InvalidFlatFrameInput extends ArgumentError {
  InvalidFlatFrameInput(String super.message);
}

void _validateMatchingShape(List<LinearRawMosaic> mosaics, String label) {
  final LinearRawMosaic first = mosaics[0];
  for (int i = 1; i < mosaics.length; i++) {
    final LinearRawMosaic mosaic = mosaics[i];
    if (mosaic.width != first.width || mosaic.height != first.height) {
      throw InvalidFlatFrameInput(
        'All $label must share the same dimensions.',
      );
    }
    if (mosaic.cfaPattern != first.cfaPattern) {
      throw InvalidFlatFrameInput(
        'All $label must share the same CFA pattern.',
      );
    }
  }
}

/// Combines [flatMosaics] into one normalized master flat of the same
/// shape: a per-pixel median across all *non-saturated* observations,
/// then divided by the mean of its own CFA color plane (R, combined G, or B). This removes spatial
/// vignetting/dust gain without using the flat-light source's color cast as a
/// false correction of the camera's native R/G/B response.
///
/// Throws [InvalidFlatFrameInput] if [flatMosaics] is empty, if any two
/// entries have mismatched dimensions or CFA pattern, or if any CFA color
/// plane that is present in the image has no positive finite mean signal.
///
/// Unlike the Node reference (which additionally validates each flat
/// frame's own sample count against its width/height), this Dart port
/// has no such check: [LinearRawMosaic]'s own constructor already
/// enforces that consistency — the same "Node-level validation made
/// unreachable by Dart's own type system" situation this project's
/// other ports have documented before (e.g. `dark_frame_subtraction.
/// dart`, Work96).
LinearRawMosaic computeMasterFlat(List<LinearRawMosaic> flatMosaics) {
  if (flatMosaics.isEmpty) {
    throw InvalidFlatFrameInput('At least one flat frame is required.');
  }
  _validateMatchingShape(flatMosaics, 'flat frames');
  for (final LinearRawMosaic mosaic in flatMosaics) {
    if (mosaic.samples.any((double value) => !value.isFinite)) {
      throw InvalidFlatFrameInput(
        'Flat frames must contain only finite linear RAW samples.',
      );
    }
  }

  final int width = flatMosaics[0].width;
  final int height = flatMosaics[0].height;
  final CfaPattern cfaPattern = flatMosaics[0].cfaPattern;
  final int pixelCount = width * height;
  final int frameCount = flatMosaics.length;
  final Float64List median = Float64List(pixelCount);
  final Uint8List invalid = Uint8List(pixelCount);
  final List<double> columnBuffer = List<double>.filled(frameCount, 0);

  for (int pixel = 0; pixel < pixelCount; pixel++) {
    int validCount = 0;
    for (int frame = 0; frame < frameCount; frame++) {
      final LinearRawMosaic mosaic = flatMosaics[frame];
      if (mosaic.saturationMask?.isSaturatedIndex(pixel) ?? false) {
        continue;
      }
      columnBuffer[validCount++] = mosaic.samples[pixel];
    }
    if (validCount == 0) {
      // No measured sensitivity exists at this site. Keep a neutral
      // placeholder and carry the invalid state downstream.
      median[pixel] = 1;
      invalid[pixel] = 1;
      continue;
    }
    final List<double> sorted = List<double>.of(columnBuffer.take(validCount))
      ..sort();
    final int middle = validCount >> 1;
    median[pixel] = validCount.isOdd
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  final Float64List colorSums = Float64List(3);
  final Uint32List colorCounts = Uint32List(3);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int pixel = y * width + x;
      if (invalid[pixel] != 0) continue;
      final double value = median[pixel];
      if (!value.isFinite) {
        throw InvalidFlatFrameInput(
          'Combined flat frame contains a non-finite sample.',
        );
      }
      final int color = switch (cfaPattern.colorAt(x, y)) {
        CfaColor.red => 0,
        CfaColor.green => 1,
        CfaColor.blue => 2,
      };
      colorSums[color] += value;
      colorCounts[color]++;
    }
  }
  final Float64List colorMeans = Float64List(3);
  for (int color = 0; color < 3; color++) {
    if (colorCounts[color] == 0) continue;
    final double mean = colorSums[color] / colorCounts[color];
    if (!mean.isFinite || !(mean > 0)) {
      throw InvalidFlatFrameInput(
        'Combined flat CFA color plane has no positive finite signal to normalize against.',
      );
    }
    colorMeans[color] = mean;
  }

  final Float32List master = Float32List(pixelCount);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      final int pixel = y * width + x;
      final int color = switch (cfaPattern.colorAt(x, y)) {
        CfaColor.red => 0,
        CfaColor.green => 1,
        CfaColor.blue => 2,
      };
      master[pixel] =
          invalid[pixel] != 0 ? 1 : median[pixel] / colorMeans[color];
    }
  }

  final RawSaturationMask invalidMask = RawSaturationMask.fromPredicate(
    pixelCount,
    (int index) => invalid[index] != 0,
  );
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: cfaPattern,
    samples: master,
    saturationMask: invalidMask.isEmpty ? null : invalidMask,
  );
}

/// Divides [lightMosaic] by [masterFlat], pixel by pixel. Returns a new
/// [LinearRawMosaic] of the same shape; [lightMosaic] itself is not
/// modified.
///
/// A [masterFlat] position whose own value is at or below
/// [minimumFlatValue] (default `0.05`) is passed through unchanged and marked
/// invalid so downstream demosaic/registration/stacking can exclude it
/// rather than divided into — see the Node reference's own doc comment
/// for why (dividing by a value near zero would amplify that position's
/// own noise wildly).
///
/// Throws [InvalidFlatFrameInput] if [lightMosaic] and [masterFlat] have
/// mismatched dimensions or CFA pattern.
LinearRawMosaic applyFlatFieldCorrection(
  LinearRawMosaic lightMosaic,
  LinearRawMosaic masterFlat, {
  double minimumFlatValue = 0.05,
}) {
  _validateMatchingShape(
    <LinearRawMosaic>[lightMosaic, masterFlat],
    'the light frame and master flat',
  );
  if (!minimumFlatValue.isFinite || minimumFlatValue < 0) {
    throw InvalidFlatFrameInput(
      'minimumFlatValue must be finite and non-negative.',
    );
  }
  if (lightMosaic.samples.any((double value) => !value.isFinite) ||
      masterFlat.samples.any((double value) => !value.isFinite)) {
    throw InvalidFlatFrameInput(
      'Light and master-flat samples must be finite before flat correction.',
    );
  }
  final int width = lightMosaic.width;
  final int height = lightMosaic.height;
  final int pixelCount = width * height;
  final Float32List result = Float32List(pixelCount);
  final RawSaturationMask? lightInvalid = lightMosaic.saturationMask;
  final RawSaturationMask? flatInvalid = masterFlat.saturationMask;
  final Uint8List combinedInvalid = Uint8List(pixelCount);

  for (int pixel = 0; pixel < pixelCount; pixel++) {
    final double flatValue = masterFlat.samples[pixel];
    final bool unusableFlat = (flatInvalid?.isSaturatedIndex(pixel) ?? false) ||
        !(flatValue > minimumFlatValue);
    final double corrected = unusableFlat
        ? lightMosaic.samples[pixel]
        : lightMosaic.samples[pixel] / flatValue;
    if (!corrected.isFinite) {
      throw InvalidFlatFrameInput(
        'Flat-field correction produced a non-finite sample.',
      );
    }
    result[pixel] = corrected;
    if ((lightInvalid?.isSaturatedIndex(pixel) ?? false) || unusableFlat) {
      combinedInvalid[pixel] = 1;
    }
  }

  final RawSaturationMask outputInvalid = RawSaturationMask.fromPredicate(
    pixelCount,
    (int index) => combinedInvalid[index] != 0,
  );
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: lightMosaic.cfaPattern,
    samples: result,
    saturationMask: outputInvalid.isEmpty ? null : outputInvalid,
  );
}

/// Memory-bounded variant used by the processing pipeline.
///
/// The correction formula and invalid-site policy are identical to
/// [applyFlatFieldCorrection], but the light frame's Float32 sample plane is
/// updated in place. Invalid bits are packed as they are discovered, avoiding
/// both a second full-frame Float32 result and a one-byte-per-pixel temporary
/// validity plane. Callers must exclusively own [lightMosaic.samples].
LinearRawMosaic applyFlatFieldCorrectionInPlace(
  LinearRawMosaic lightMosaic,
  LinearRawMosaic masterFlat, {
  double minimumFlatValue = 0.05,
}) {
  _validateMatchingShape(
    <LinearRawMosaic>[lightMosaic, masterFlat],
    'the light frame and master flat',
  );
  if (!minimumFlatValue.isFinite || minimumFlatValue < 0) {
    throw InvalidFlatFrameInput(
      'minimumFlatValue must be finite and non-negative.',
    );
  }
  final int pixelCount = lightMosaic.width * lightMosaic.height;
  final RawSaturationMask? lightInvalid = lightMosaic.saturationMask;
  final RawSaturationMask? flatInvalid = masterFlat.saturationMask;
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;

  for (int pixel = 0; pixel < pixelCount; pixel++) {
    final double source = lightMosaic.samples[pixel];
    final double flatValue = masterFlat.samples[pixel];
    if (!source.isFinite || !flatValue.isFinite) {
      throw InvalidFlatFrameInput(
        'Light and master-flat samples must be finite before flat correction.',
      );
    }
    final bool unusableFlat = (flatInvalid?.isSaturatedIndex(pixel) ?? false) ||
        !(flatValue > minimumFlatValue);
    final double corrected = unusableFlat ? source : source / flatValue;
    if (!corrected.isFinite) {
      throw InvalidFlatFrameInput(
        'Flat-field correction produced a non-finite sample.',
      );
    }
    lightMosaic.samples[pixel] = corrected;

    if ((lightInvalid?.isSaturatedIndex(pixel) ?? false) || unusableFlat) {
      packedInvalid[pixel >> 3] |= 1 << (pixel & 7);
      invalidCount++;
    }
  }

  final RawSaturationMask? outputInvalid = invalidCount == 0
      ? null
      : RawSaturationMask.takePackedBytes(
          pixelCount: pixelCount,
          packedBytes: packedInvalid,
          saturatedCount: invalidCount,
        );
  return LinearRawMosaic(
    width: lightMosaic.width,
    height: lightMosaic.height,
    cfaPattern: lightMosaic.cfaPattern,
    samples: lightMosaic.samples,
    saturationMask: outputInvalid,
  );
}

/// File-backed master-flat variant for long background jobs.
///
/// [masterFlatStore] is read in bounded row chunks while the light CFA plane
/// is corrected in place. The numerical formula, minimum-flat threshold and
/// invalid-mask propagation are identical to [applyFlatFieldCorrectionInPlace].
Future<LinearRawMosaic> applyFlatFieldCorrectionFromStoreInPlace(
  LinearRawMosaic lightMosaic,
  FileBackedLinearRawMosaicStore masterFlatStore, {
  double minimumFlatValue = 0.05,
  int rowChunk = 64,
}) async {
  if (rowChunk <= 0) {
    throw ArgumentError.value(rowChunk, 'rowChunk', 'must be positive');
  }
  if (!minimumFlatValue.isFinite || minimumFlatValue < 0) {
    throw InvalidFlatFrameInput(
      'minimumFlatValue must be finite and non-negative.',
    );
  }
  if (lightMosaic.width != masterFlatStore.width ||
      lightMosaic.height != masterFlatStore.height) {
    throw InvalidFlatFrameInput(
      'The light frame and master flat must share the same dimensions.',
    );
  }
  if (lightMosaic.cfaPattern != masterFlatStore.cfaPattern) {
    throw InvalidFlatFrameInput(
      'The light frame and master flat must share the same CFA pattern.',
    );
  }

  final int width = lightMosaic.width;
  final int height = lightMosaic.height;
  final int pixelCount = width * height;
  final RawSaturationMask? lightInvalid = lightMosaic.saturationMask;
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;

  for (int y = 0; y < height; y += rowChunk) {
    final int rows = (height - y) < rowChunk ? height - y : rowChunk;
    final Float32List flatSamples = await masterFlatStore.readRegion(
      x: 0,
      y: y,
      width: width,
      height: rows,
    );
    final RawSaturationMask? flatInvalid =
        await masterFlatStore.readSaturationRegion(
      x: 0,
      y: y,
      width: width,
      height: rows,
    );
    final int chunkPixels = width * rows;
    final int globalBase = y * width;
    for (int local = 0; local < chunkPixels; local++) {
      final int pixel = globalBase + local;
      final double source = lightMosaic.samples[pixel];
      final double flatValue = flatSamples[local];
      if (!source.isFinite || !flatValue.isFinite) {
        throw InvalidFlatFrameInput(
          'Light and master-flat samples must be finite before flat correction.',
        );
      }
      final bool unusableFlat =
          (flatInvalid?.isSaturatedIndex(local) ?? false) ||
              !(flatValue > minimumFlatValue);
      final double corrected = unusableFlat ? source : source / flatValue;
      if (!corrected.isFinite) {
        throw InvalidFlatFrameInput(
          'Flat-field correction produced a non-finite sample.',
        );
      }
      lightMosaic.samples[pixel] = corrected;
      if ((lightInvalid?.isSaturatedIndex(pixel) ?? false) || unusableFlat) {
        packedInvalid[pixel >> 3] |= 1 << (pixel & 7);
        invalidCount++;
      }
    }
  }

  final RawSaturationMask? outputInvalid = invalidCount == 0
      ? null
      : RawSaturationMask.takePackedBytes(
          pixelCount: pixelCount,
          packedBytes: packedInvalid,
          saturatedCount: invalidCount,
        );
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: lightMosaic.cfaPattern,
    samples: lightMosaic.samples,
    saturationMask: outputInvalid,
  );
}
