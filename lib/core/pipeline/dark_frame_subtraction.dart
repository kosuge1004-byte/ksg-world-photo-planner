import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../image/file_backed_linear_raw_mosaic_store.dart';
import '../image/linear_raw_mosaic.dart';
import '../image/raw_saturation_mask.dart';

/// Dart port of `tool/raw_samples/dark_frame_subtraction_reference.mjs`.
///
/// A classic, high-impact astrophotography noise-reduction technique
/// this project has not had at all until now (Work96). See the Node
/// reference's own doc comment for the full rationale — in short: a
/// sensor's hot pixels and fixed thermal noise pattern do not get
/// reduced by stacking (averaging or drizzling) the way genuinely random
/// photon/read noise does, since the pattern is the same, frame after
/// frame; subtracting a measured "dark frame" (an exposure with no
/// light reaching the sensor, at the same settings) removes it directly.
///
/// [computeMasterDark] combines several dark frames via a per-pixel
/// median (robust against a cosmic ray hit or other rare, large,
/// one-off spike in any single dark exposure, unlike a mean);
/// [subtractDarkFrame] subtracts the result from one light frame's raw
/// mosaic while preserving finite negative residuals. Dark subtraction is an
/// additive calibration step; clipping here would bias the near-black noise
/// distribution upward and contradict the rest of the linear RAW pipeline,
/// which intentionally preserves negative values until final rendering.
///
/// Both operate directly on raw (Bayer) CFA mosaics, before demosaicing
/// — matching this project's own established practice for anything
/// involving raw sensor-level correction (see `raw_mosaic_calibrator.
/// dart`, `extract_green_luminance_from_mosaic.dart`).
///
/// This file has not been executed against the Dart SDK. It is a
/// careful line-by-line translation of the Node reference, which has
/// full test coverage. Run `test/dark_frame_subtraction_test.dart`
/// before relying on this in production.

class InvalidDarkFrameInput extends ArgumentError {
  InvalidDarkFrameInput(String super.message);
}

void _validateMatchingShape(List<LinearRawMosaic> mosaics, String label) {
  final LinearRawMosaic first = mosaics[0];
  for (int i = 1; i < mosaics.length; i++) {
    final LinearRawMosaic mosaic = mosaics[i];
    if (mosaic.width != first.width || mosaic.height != first.height) {
      throw InvalidDarkFrameInput(
        'All $label must share the same dimensions.',
      );
    }
    if (mosaic.cfaPattern != first.cfaPattern) {
      throw InvalidDarkFrameInput(
        'All $label must share the same CFA pattern.',
      );
    }
  }
}

/// Combines [darkMosaics] into one master dark of the same shape, via a
/// per-pixel median.
///
/// Throws [InvalidDarkFrameInput] if [darkMosaics] is empty or if any
/// two entries have mismatched dimensions or CFA pattern.
///
/// Unlike the Node reference (which additionally validates each dark
/// frame's own sample count against its width/height), this Dart port
/// has no such check: [LinearRawMosaic]'s own constructor already
/// enforces that consistency — an invalid mosaic object cannot exist to
/// be passed in — the same "Node-level validation made unreachable by
/// Dart's own type system" situation this project's other ports have
/// documented before (e.g. `extract_green_luminance_from_mosaic.dart`,
/// Work88).
LinearRawMosaic computeMasterDark(List<LinearRawMosaic> darkMosaics) {
  if (darkMosaics.isEmpty) {
    throw InvalidDarkFrameInput('At least one dark frame is required.');
  }
  _validateMatchingShape(darkMosaics, 'dark frames');
  for (final LinearRawMosaic mosaic in darkMosaics) {
    if (mosaic.samples.any((double value) => !value.isFinite)) {
      throw InvalidDarkFrameInput(
        'Dark frames must contain only finite linear RAW samples.',
      );
    }
  }

  final int width = darkMosaics[0].width;
  final int height = darkMosaics[0].height;
  final CfaPattern cfaPattern = darkMosaics[0].cfaPattern;
  final int pixelCount = width * height;
  final int frameCount = darkMosaics.length;
  final Float32List master = Float32List(pixelCount);
  final Uint8List invalid = Uint8List(pixelCount);
  final List<double> columnBuffer = List<double>.filled(frameCount, 0);

  for (int pixel = 0; pixel < pixelCount; pixel++) {
    int validCount = 0;
    for (int frame = 0; frame < frameCount; frame++) {
      final LinearRawMosaic mosaic = darkMosaics[frame];
      if (mosaic.saturationMask?.isSaturatedIndex(pixel) ?? false) {
        continue;
      }
      columnBuffer[validCount++] = mosaic.samples[pixel];
    }
    if (validCount == 0) {
      // There is no measured dark-current value at this site. Keep a neutral
      // placeholder and carry the invalid state so subtraction can exclude it.
      master[pixel] = 0;
      invalid[pixel] = 1;
      continue;
    }
    final List<double> sorted = List<double>.of(columnBuffer.take(validCount))
      ..sort();
    final int middle = validCount >> 1;
    master[pixel] = validCount.isOdd
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
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

/// Subtracts [masterDark] from [lightMosaic], pixel by pixel without
/// clipping finite negative residuals. Returns a new [LinearRawMosaic] of the
/// same shape; [lightMosaic] itself is not modified.
///
/// Preserving signed residuals matters for high-quality stacking: a zero clamp
/// after an additive subtraction changes the background-noise distribution and
/// introduces a positive bias. The project's [RawMosaicCalibrator] follows the
/// same rule for black-level subtraction.
///
/// Throws [InvalidDarkFrameInput] if [lightMosaic] and [masterDark] have
/// mismatched dimensions or CFA pattern.
LinearRawMosaic subtractDarkFrame(
  LinearRawMosaic lightMosaic,
  LinearRawMosaic masterDark,
) {
  _validateMatchingShape(
    <LinearRawMosaic>[lightMosaic, masterDark],
    'the light frame and master dark',
  );
  final int width = lightMosaic.width;
  final int height = lightMosaic.height;
  final int pixelCount = width * height;
  final Float32List result = Float32List(pixelCount);
  final RawSaturationMask? lightInvalid = lightMosaic.saturationMask;
  final RawSaturationMask? darkInvalid = masterDark.saturationMask;
  for (int pixel = 0; pixel < pixelCount; pixel++) {
    final bool unusableDark = darkInvalid?.isSaturatedIndex(pixel) ?? false;
    final double difference = unusableDark
        ? lightMosaic.samples[pixel]
        : lightMosaic.samples[pixel] - masterDark.samples[pixel];
    if (!difference.isFinite) {
      throw InvalidDarkFrameInput(
        'Dark subtraction produced a non-finite sample.',
      );
    }
    result[pixel] = difference;
  }
  final RawSaturationMask combinedInvalid = RawSaturationMask.fromPredicate(
    pixelCount,
    (int index) =>
        (lightInvalid?.isSaturatedIndex(index) ?? false) ||
        (darkInvalid?.isSaturatedIndex(index) ?? false),
  );
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: lightMosaic.cfaPattern,
    samples: result,
    saturationMask: combinedInvalid.isEmpty ? null : combinedInvalid,
  );
}

/// Memory-bounded variant used by the processing pipeline.
///
/// The numerical operation and invalid-mask semantics are identical to
/// [subtractDarkFrame], but the light frame's already-owned Float32 sample
/// plane is updated in place instead of allocating a second full-frame plane.
/// A new [LinearRawMosaic] wrapper is returned only so the immutable mask
/// reference can be replaced. Callers must have exclusive ownership of
/// [lightMosaic.samples] while this function runs.
LinearRawMosaic subtractDarkFrameInPlace(
  LinearRawMosaic lightMosaic,
  LinearRawMosaic masterDark,
) {
  _validateMatchingShape(
    <LinearRawMosaic>[lightMosaic, masterDark],
    'the light frame and master dark',
  );
  final int pixelCount = lightMosaic.width * lightMosaic.height;
  final RawSaturationMask? lightInvalid = lightMosaic.saturationMask;
  final RawSaturationMask? darkInvalid = masterDark.saturationMask;
  final Uint8List packedInvalid = Uint8List((pixelCount + 7) >> 3);
  int invalidCount = 0;

  for (int pixel = 0; pixel < pixelCount; pixel++) {
    final bool unusableDark = darkInvalid?.isSaturatedIndex(pixel) ?? false;
    final double difference = unusableDark
        ? lightMosaic.samples[pixel]
        : lightMosaic.samples[pixel] - masterDark.samples[pixel];
    if (!difference.isFinite) {
      throw InvalidDarkFrameInput(
        'Dark subtraction produced a non-finite sample.',
      );
    }
    lightMosaic.samples[pixel] = difference;

    if ((lightInvalid?.isSaturatedIndex(pixel) ?? false) || unusableDark) {
      packedInvalid[pixel >> 3] |= 1 << (pixel & 7);
      invalidCount++;
    }
  }

  final RawSaturationMask? combinedInvalid = invalidCount == 0
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
    saturationMask: combinedInvalid,
  );
}

/// File-backed master-dark variant for long background jobs.
///
/// The light frame remains the only full-size Float32 CFA plane in memory.
/// [masterDarkStore] is read a small row chunk at a time and the exact same
/// subtraction/invalid-site semantics as [subtractDarkFrameInPlace] are
/// applied to [lightMosaic.samples] in place.
Future<LinearRawMosaic> subtractDarkFrameFromStoreInPlace(
  LinearRawMosaic lightMosaic,
  FileBackedLinearRawMosaicStore masterDarkStore, {
  int rowChunk = 64,
}) async {
  if (rowChunk <= 0) {
    throw ArgumentError.value(rowChunk, 'rowChunk', 'must be positive');
  }
  if (lightMosaic.width != masterDarkStore.width ||
      lightMosaic.height != masterDarkStore.height) {
    throw InvalidDarkFrameInput(
      'The light frame and master dark must share the same dimensions.',
    );
  }
  if (lightMosaic.cfaPattern != masterDarkStore.cfaPattern) {
    throw InvalidDarkFrameInput(
      'The light frame and master dark must share the same CFA pattern.',
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
    final Float32List darkSamples = await masterDarkStore.readRegion(
      x: 0,
      y: y,
      width: width,
      height: rows,
    );
    final RawSaturationMask? darkInvalid =
        await masterDarkStore.readSaturationRegion(
      x: 0,
      y: y,
      width: width,
      height: rows,
    );
    final int chunkPixels = width * rows;
    final int globalBase = y * width;
    for (int local = 0; local < chunkPixels; local++) {
      final int pixel = globalBase + local;
      final double lightValue = lightMosaic.samples[pixel];
      final double darkValue = darkSamples[local];
      if (!lightValue.isFinite || !darkValue.isFinite) {
        throw InvalidDarkFrameInput(
          'Dark subtraction requires finite light and master-dark samples.',
        );
      }
      final bool unusableDark = darkInvalid?.isSaturatedIndex(local) ?? false;
      final double difference =
          unusableDark ? lightValue : lightValue - darkValue;
      if (!difference.isFinite) {
        throw InvalidDarkFrameInput(
          'Dark subtraction produced a non-finite sample.',
        );
      }
      lightMosaic.samples[pixel] = difference;
      if ((lightInvalid?.isSaturatedIndex(pixel) ?? false) || unusableDark) {
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
