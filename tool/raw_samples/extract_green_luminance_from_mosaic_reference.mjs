/// Reference implementation of green-channel luminance extraction from a
/// raw (Bayer) CFA mosaic, for Mobile Stack's CFA-domain drizzle
/// pipeline (Work87's `drizzleCfaTiled`).
///
/// Registration (star detection + transform estimation) for a CFA-
/// domain-drizzle-based stacking pipeline must happen *before*
/// demosaicing — drizzle itself is the thing standing in for
/// demosaicing here, applied only *after* frames are aligned and
/// combined (see `cfa_drizzle_reference.mjs`'s own doc comment for why:
/// combining raw samples first, demosaicing once at the end, avoids
/// compounding each frame's own demosaic interpolation error). But
/// every registration tool this project has (`star_detector_reference.
/// mjs`, `star_transform_estimator_reference.mjs`) expects a plain
/// single-channel luminance plane as input, not raw Bayer data — this
/// module bridges that gap, extracting a usable luminance plane
/// straight from the raw mosaic, without a full demosaic pass.
///
/// Deliberately *not* a full demosaic: for star detection specifically,
/// only a reasonably sharp, reasonably accurate luminance proxy is
/// needed to find each star's centroid — the full color-aware,
/// gradient-adaptive interpolation `mobile_stack_adaptive_demosaic_
/// reference.mjs` performs is unnecessary work for this purpose (and
/// registration happens once per frame, so keeping this step cheap
/// matters for overall pipeline cost). Green was chosen as the channel
/// to extract (not red, blue, or a weighted luminance combining all
/// three) because it already has the CFA's own highest native sampling
/// density (half of every Bayer-pattern mosaic's pixels are green,
/// versus a quarter each for red and blue) — the sharpest, least-
/// interpolated channel available directly from the mosaic — matching
/// every other star/streak detector in this project's own established
/// choice to operate on a green-channel proxy (see `milky_way_
/// pipeline.dart`'s `_greenChannelOf` and `meteor_pipeline.dart`'s
/// identical choice for already-demosaiced data).

import { cfaColorAt } from './mobile_stack_adaptive_demosaic_reference.mjs';

export class InvalidMosaicInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidMosaicInput';
  }
}

const GREEN = 1;

/// Extracts a green-channel luminance plane from a raw CFA `mosaic`
/// (`{width, height, cfaPattern, samples}`, `samples` a row-major
/// `Float32Array` of length `width * height`).
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
///
/// Throws {@link InvalidMosaicInput} if `mosaic`'s dimensions don't
/// match its own sample count, or its `cfaPattern` is not one of the
/// four standard Bayer patterns.
export function extractGreenLuminanceFromMosaic(mosaic) {
  const {
    width, height, cfaPattern, samples,
  } = mosaic;
  if (width <= 0 || height <= 0 || samples.length !== width * height) {
    throw new InvalidMosaicInput('Invalid mosaic dimensions or sample count.');
  }
  if (!['rggb', 'bggr', 'grbg', 'gbrg'].includes(cfaPattern)) {
    throw new InvalidMosaicInput(`Unsupported CFA pattern: ${cfaPattern}`);
  }
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (cfaColorAt(cfaPattern, x, y) === GREEN) {
        output[index] = samples[index];
        continue;
      }
      let sum = 0;
      let count = 0;
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
  return { width, height, samples: output };
}
