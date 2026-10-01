/// Reference implementation of dark frame subtraction — a classic,
/// high-impact astrophotography noise-reduction technique this project
/// has not had at all until now (Work96).
///
/// A "dark frame" is an exposure taken with no light reaching the
/// sensor (lens cap on, or equivalent), at the *same* exposure settings
/// (ISO, shutter speed, and ideally similar sensor temperature) as the
/// real "light frames" being stacked. Even with the lens cap on, a
/// sensor's raw output is never exactly the black level everywhere:
/// individual pixels leak a small, mostly-fixed amount of extra signal
/// purely from thermal (dark current) noise, and some pixels ("hot
/// pixels") leak substantially more than their neighbors, consistently,
/// frame after frame. Because this pattern is *fixed* (tied to the
/// specific sensor and its specific pixels, not random from frame to
/// frame), averaging or drizzling multiple light frames together does
/// **not** reduce it the way it reduces genuinely random photon/read
/// noise — a hot pixel stays exactly as hot in the final stack as it
/// was in every individual frame. Subtracting a measured dark frame
/// (built from the *same* sensor at the *same* settings) removes this
/// fixed pattern directly, rather than relying on stacking to average
/// it away, which stacking alone cannot do.
///
/// This module has two pieces:
/// - [computeMasterDark]: combines several individual dark frames into
///   one low-noise "master dark", via a per-pixel **median** (not mean).
///   Median was chosen specifically because dark frames are also
///   susceptible to cosmic ray hits and other rare, large, one-off
///   spikes at a handful of pixels in any given exposure — a mean would
///   let a single such spike inflate that pixel's master-dark value
///   for every subsequent light frame's subtraction, while a median
///   simply ignores an outlier that isn't shared by roughly half or
///   more of the dark frames.
/// - [subtractDarkFrame]: subtracts a master dark from one light
///   frame's raw mosaic, pixel by pixel, preserving finite signed
///   residuals. Negative values are valid noise residuals in a linear
///   calibrated pipeline; clamping them here would bias the background
///   distribution upward before stacking.
///
/// Both operate directly on raw (Bayer) CFA mosaics, matching this
/// project's own established practice: dark current affects each raw
/// sensor site individually and does not respect CFA color boundaries,
/// so subtraction must happen before demosaicing, exactly like CFA-
/// domain drizzle's own registration and combining steps
/// (`cfa_drizzle_reference.mjs`).
///
/// Every mosaic accepted or produced here is expected to already be
/// past black-level subtraction (matching `raw_mosaic_calibrator_
/// reference.mjs`'s own stage ordering) — a master dark built this way
/// represents "signal above the black level, from dark current alone",
/// which is exactly what should be removed from an equally black-level-
/// subtracted light frame; subtracting *raw*, not-yet-black-level-
/// corrected dark data would double-subtract the black level itself.

export class InvalidDarkFrameInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDarkFrameInput';
  }
}

function validateMatchingShape(mosaics, label) {
  const first = mosaics[0];
  for (let i = 1; i < mosaics.length; i++) {
    const mosaic = mosaics[i];
    if (mosaic.width !== first.width || mosaic.height !== first.height) {
      throw new InvalidDarkFrameInput(
        `All ${label} must share the same dimensions.`,
      );
    }
    if (mosaic.cfaPattern !== first.cfaPattern) {
      throw new InvalidDarkFrameInput(
        `All ${label} must share the same CFA pattern.`,
      );
    }
  }
}

/// Combines [darkMosaics] (each `{width, height, cfaPattern, samples}`,
/// `samples` a row-major `Float32Array`) into one master dark of the
/// same shape, via a per-pixel median.
///
/// Throws {@link InvalidDarkFrameInput} if [darkMosaics] is empty, if
/// any two entries have mismatched dimensions or CFA pattern, or if any
/// entry's sample count does not match its own declared width/height.
export function computeMasterDark(darkMosaics) {
  if (!Array.isArray(darkMosaics) || darkMosaics.length === 0) {
    throw new InvalidDarkFrameInput('At least one dark frame is required.');
  }
  for (const mosaic of darkMosaics) {
    if (mosaic.samples.length !== mosaic.width * mosaic.height) {
      throw new InvalidDarkFrameInput(
        "A dark frame's sample count does not match its dimensions.",
      );
    }
    if (mosaic.saturationMask != null &&
        mosaic.saturationMask.length !== mosaic.width * mosaic.height) {
      throw new InvalidDarkFrameInput(
        "A dark frame's saturation-mask count does not match its dimensions.",
      );
    }
  }
  validateMatchingShape(darkMosaics, 'dark frames');
  for (const mosaic of darkMosaics) {
    if ([...mosaic.samples].some((value) => !Number.isFinite(value))) {
      throw new InvalidDarkFrameInput(
        'Dark frames must contain only finite linear RAW samples.',
      );
    }
  }

  const { width, height, cfaPattern } = darkMosaics[0];
  const pixelCount = width * height;
  const frameCount = darkMosaics.length;
  const master = new Float32Array(pixelCount);
  const invalid = new Uint8Array(pixelCount);
  const columnBuffer = new Float64Array(frameCount);

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    let validCount = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      const mosaic = darkMosaics[frame];
      if (mosaic.saturationMask?.[pixel]) continue;
      columnBuffer[validCount++] = mosaic.samples[pixel];
    }
    if (validCount === 0) {
      master[pixel] = 0;
      invalid[pixel] = 1;
      continue;
    }
    const sorted = Array.from(columnBuffer.subarray(0, validCount))
      .sort((a, b) => a - b);
    const middle = validCount >> 1;
    master[pixel] = validCount % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return {
    width,
    height,
    cfaPattern,
    samples: master,
    saturationMask: invalid.some((value) => value !== 0) ? invalid : undefined,
  };
}

/// Subtracts [masterDark] from [lightMosaic], pixel by pixel without
/// clipping finite negative residuals. Returns a new mosaic of the same
/// shape; [lightMosaic] itself is not modified.
///
/// Throws {@link InvalidDarkFrameInput} if [lightMosaic] and
/// [masterDark] have mismatched dimensions or CFA pattern.
export function subtractDarkFrame(lightMosaic, masterDark) {
  validateMatchingShape(
    [lightMosaic, masterDark],
    'the light frame and master dark',
  );
  const { width, height, cfaPattern } = lightMosaic;
  const pixelCount = width * height;
  const result = new Float32Array(pixelCount);
  const combinedInvalid = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const unusableDark = Boolean(masterDark.saturationMask?.[pixel]);
    const difference = unusableDark
      ? lightMosaic.samples[pixel]
      : lightMosaic.samples[pixel] - masterDark.samples[pixel];
    if (!Number.isFinite(difference)) {
      throw new InvalidDarkFrameInput(
        'Dark subtraction produced a non-finite sample.',
      );
    }
    result[pixel] = difference;
    if (lightMosaic.saturationMask?.[pixel] || unusableDark) {
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
