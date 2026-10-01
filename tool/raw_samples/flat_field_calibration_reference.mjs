/// Reference implementation of flat field calibration — another
/// classic astrophotography correction, alongside dark frame
/// subtraction (`dark_frame_subtraction_reference.mjs`, Work96), this
/// project did not have until now (Work98).
///
/// A "flat frame" is an exposure of a uniformly, evenly lit target (a
/// twilight sky, a light panel, or similar) taken through the *same*
/// lens and at the *same* aperture as the real "light frames" being
/// stacked. Even photographing something perfectly uniform, the raw
/// result is never uniform itself: lens vignetting makes the frame's
/// edges and corners read dimmer than its center, and dust specks on
/// the sensor or lens elements cast small, soft shadows at fixed
/// positions. Both effects are *multiplicative* (a given position is
/// consistently, say, 80% as bright as it "should" be, regardless of
/// how bright the actual scene is there) and *fixed to the optical
/// path* (the same lens+aperture always vignettes and shadows dust the
/// same way) — exactly the profile a flat frame is built to measure and
/// correct, the same way `dark_frame_subtraction_reference.mjs`
/// measures and corrects the sensor's own fixed, additive thermal
/// pattern.
///
/// This module has two pieces, mirroring `dark_frame_subtraction_
/// reference.mjs`'s own shape:
/// - [computeMasterFlat]: combines several individual flat frames into
///   one low-noise, **normalized** master flat, via a per-pixel median
///   (the same robustness rationale as `computeMasterDark`'s own choice
///   — a flat exposure can also pick up a rare bright speck or dust
///   mote that moved between shots, which a mean would let permanently
///   distort the correction) followed by dividing each CFA sample by the
///   mean of its own R / combined-G / B plane. This prevents the flat-light
///   source color and Bayer sensitivity ratios from becoming a false color
///   correction. A value of `0.8`
///   means "this position reads 80% as bright as the frame's typical
///   brightness, so light frames need dividing by 0.8 — i.e.
///   brightening by 1/0.8 — here to correct for it").
/// - [applyFlatFieldCorrection]: divides one light frame's raw mosaic
///   by the master flat, pixel by pixel.
///
/// Both operate directly on raw (Bayer) CFA mosaics, before
/// demosaicing, for the same reason `dark_frame_subtraction_
/// reference.mjs` does: vignetting and dust shadows affect each raw
/// sensor site individually and do not respect CFA color boundaries.
///
/// Flat frames are expected to already be dark-subtracted themselves
/// (via `dark_frame_subtraction_reference.mjs`, using a separate master
/// dark taken at the flat frames' own, typically much shorter, exposure
/// settings) before being passed to [computeMasterFlat] — this module
/// does not perform that step itself, matching this project's own
/// established practice of keeping each calibration stage a distinct,
/// independently-testable unit (`raw_mosaic_calibrator_reference.mjs`'s
/// own black level / white level / camera white balance split is the
/// same pattern).

export class InvalidFlatFrameInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidFlatFrameInput';
  }
}

function validateMatchingShape(mosaics, label) {
  const first = mosaics[0];
  for (let i = 1; i < mosaics.length; i++) {
    const mosaic = mosaics[i];
    if (mosaic.width !== first.width || mosaic.height !== first.height) {
      throw new InvalidFlatFrameInput(
        `All ${label} must share the same dimensions.`,
      );
    }
    if (mosaic.cfaPattern !== first.cfaPattern) {
      throw new InvalidFlatFrameInput(
        `All ${label} must share the same CFA pattern.`,
      );
    }
  }
}

/// Combines [flatMosaics] (each `{width, height, cfaPattern, samples}`)
/// into one normalized master flat of the same shape: a per-pixel
/// median across all frames, then divided by that median image's own
/// overall mean, so the result is centered around `1.0`.
///
/// Throws {@link InvalidFlatFrameInput} if [flatMosaics] is empty, if
/// any two entries have mismatched dimensions or CFA pattern, if any
/// entry's sample count does not match its own declared width/height,
/// or if the combined median's own CFA-color mean is not positive (a flat
/// frame with no signal at all cannot be normalized into a meaningful
/// correction factor).
export function computeMasterFlat(flatMosaics) {
  if (!Array.isArray(flatMosaics) || flatMosaics.length === 0) {
    throw new InvalidFlatFrameInput('At least one flat frame is required.');
  }
  for (const mosaic of flatMosaics) {
    if (mosaic.samples.length !== mosaic.width * mosaic.height) {
      throw new InvalidFlatFrameInput(
        "A flat frame's sample count does not match its dimensions.",
      );
    }
    if (mosaic.saturationMask != null &&
        mosaic.saturationMask.length !== mosaic.width * mosaic.height) {
      throw new InvalidFlatFrameInput(
        "A flat frame's saturation-mask count does not match its dimensions.",
      );
    }
  }
  validateMatchingShape(flatMosaics, 'flat frames');
  for (const mosaic of flatMosaics) {
    if ([...mosaic.samples].some((value) => !Number.isFinite(value))) {
      throw new InvalidFlatFrameInput(
        'Flat frames must contain only finite linear RAW samples.',
      );
    }
  }

  const { width, height, cfaPattern } = flatMosaics[0];
  const pixelCount = width * height;
  const frameCount = flatMosaics.length;
  const median = new Float64Array(pixelCount);
  const invalid = new Uint8Array(pixelCount);
  const columnBuffer = new Float64Array(frameCount);

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    let validCount = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      const mosaic = flatMosaics[frame];
      if (mosaic.saturationMask?.[pixel]) continue;
      columnBuffer[validCount++] = mosaic.samples[pixel];
    }
    if (validCount === 0) {
      median[pixel] = 1;
      invalid[pixel] = 1;
      continue;
    }
    const sorted = Array.from(columnBuffer.subarray(0, validCount))
      .sort((a, b) => a - b);
    const middle = validCount >> 1;
    median[pixel] = validCount % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  const colorIndexAt = (x, y) => {
    const evenX = (x & 1) === 0;
    const evenY = (y & 1) === 0;
    if (cfaPattern === 'rggb') {
      if (evenX && evenY) return 0;
      if (!evenX && !evenY) return 2;
      return 1;
    }
    if (cfaPattern === 'bggr') {
      if (evenX && evenY) return 2;
      if (!evenX && !evenY) return 0;
      return 1;
    }
    if (cfaPattern === 'grbg') {
      if (!evenX && evenY) return 0;
      if (evenX && !evenY) return 2;
      return 1;
    }
    if (cfaPattern === 'gbrg') {
      if (evenX && !evenY) return 0;
      if (!evenX && evenY) return 2;
      return 1;
    }
    throw new InvalidFlatFrameInput('Unsupported CFA pattern.');
  };

  const sums = new Float64Array(3);
  const counts = new Uint32Array(3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (invalid[pixel]) continue;
      const value = median[pixel];
      if (!Number.isFinite(value)) {
        throw new InvalidFlatFrameInput(
          'Combined flat frame contains a non-finite sample.',
        );
      }
      const color = colorIndexAt(x, y);
      sums[color] += value;
      counts[color]++;
    }
  }
  const means = new Float64Array(3);
  for (let color = 0; color < 3; color++) {
    if (counts[color] === 0) continue;
    const mean = sums[color] / counts[color];
    if (!(mean > 0) || !Number.isFinite(mean)) {
      throw new InvalidFlatFrameInput(
        'Combined flat CFA color plane has no positive finite signal to normalize against.',
      );
    }
    means[color] = mean;
  }

  const master = new Float32Array(pixelCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      master[pixel] = invalid[pixel]
        ? 1
        : median[pixel] / means[colorIndexAt(x, y)];
    }
  }

  return {
    width,
    height,
    cfaPattern,
    samples: master,
    saturationMask: invalid.some((value) => value !== 0) ? invalid : undefined,
  };
}

/// Divides [lightMosaic] by [masterFlat], pixel by pixel. Returns a new
/// mosaic of the same shape; [lightMosaic] itself is not modified.
///
/// A [masterFlat] position whose own value is at or below
/// [minimumFlatValue] (default `0.05` — a position vignetted or
/// shadowed down to 5% or less of the frame's typical brightness) is
/// treated as unusable rather than divided into: dividing by a value
/// near zero would amplify that position's own noise wildly (a division
/// by a genuinely tiny number turns any small amount of read noise into
/// an enormous swing), doing more harm than the vignetting/dust
/// correction is worth there. That position's light-frame value is
/// passed through unchanged instead — a real but likely already very
/// dim corner is left slightly under-corrected, rather than an
/// astronomically noisy, meaningless "corrected" value in its place.
///
/// Throws {@link InvalidFlatFrameInput} if [lightMosaic] and
/// [masterFlat] have mismatched dimensions or CFA pattern.
export function applyFlatFieldCorrection(lightMosaic, masterFlat, {
  minimumFlatValue = 0.05,
} = {}) {
  validateMatchingShape(
    [lightMosaic, masterFlat],
    'the light frame and master flat',
  );
  if (!Number.isFinite(minimumFlatValue) || minimumFlatValue < 0) {
    throw new InvalidFlatFrameInput(
      'minimumFlatValue must be finite and non-negative.',
    );
  }
  if ([...lightMosaic.samples, ...masterFlat.samples]
      .some((value) => !Number.isFinite(value))) {
    throw new InvalidFlatFrameInput(
      'Light and master-flat samples must be finite before flat correction.',
    );
  }
  const { width, height, cfaPattern } = lightMosaic;
  const pixelCount = width * height;
  const result = new Float32Array(pixelCount);
  const combinedInvalid = new Uint8Array(pixelCount);

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const flatValue = masterFlat.samples[pixel];
    const unusableFlat = Boolean(masterFlat.saturationMask?.[pixel]) ||
      !(flatValue > minimumFlatValue);
    const corrected = unusableFlat
      ? lightMosaic.samples[pixel]
      : lightMosaic.samples[pixel] / flatValue;
    if (!Number.isFinite(corrected)) {
      throw new InvalidFlatFrameInput(
        'Flat-field correction produced a non-finite sample.',
      );
    }
    result[pixel] = corrected;
    if (lightMosaic.saturationMask?.[pixel] || unusableFlat) {
      combinedInvalid[pixel] = 1;
    }
  }
  return {
    width,
    height,
    cfaPattern,
    samples: result,
    saturationMask: combinedInvalid.some((value) => value !== 0)
      ? combinedInvalid
      : undefined,
  };
}
