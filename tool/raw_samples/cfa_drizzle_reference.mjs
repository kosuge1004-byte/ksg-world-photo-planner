import { cfaColorAt } from './mobile_stack_adaptive_demosaic_reference.mjs';
import { DrizzleAccumulator } from './drizzle_accumulator_reference.mjs';

/// CFA-domain drizzle for Mobile Stack: combines multiple raw (Bayer)
/// frames onto one supersampled output grid, per Work34's roadmap item
/// "CFA-domain drizzle and weight-map output".
///
/// Each frame's raw samples are splatted directly onto the output grid —
/// before demosaicing — using one `DrizzleAccumulator`
/// (`drizzle_accumulator_reference.mjs`) per CFA color, so a red sample
/// never blends with a green or blue one. This preserves detail that
/// demosaicing-then-stacking would smear: demosaicing invents values
/// between real sensor samples, and averaging those interpolated values
/// across frames compounds each frame's interpolation error, while
/// drizzling raw samples first and demosaicing the combined,
/// higher-effective-resolution result only interpolates once.
///
/// Frame alignment: each frame after the first needs a rigid transform
/// mapping *its own* pixel positions onto the reference frame's output
/// grid (the forward direction). `star_similarity_transform_estimator_
/// reference.mjs` produces the *inverse* of that — a mapping from
/// reference positions to this frame's positions, matching
/// `AffineSamplingTransform.similarity`'s resampling convention — so
/// `invertSimilarityTransform` below inverts it back to the forward
/// direction this module needs. The reference frame itself uses the
/// identity transform.

export class InvalidCfaDrizzleInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCfaDrizzleInput';
  }
}

/// Inverts a rigid (rotation + translation, no scale) transform expressed
/// in `AffineSamplingTransform.similarity`'s parameter shape (`source =
/// center + R(rotation) * (output - center) + sourceOffset`), producing
/// the forward transform `output = center + R(-rotation) * (source -
/// center - sourceOffset)` — i.e. given a position in the *source*
/// frame, where it lands in the *output/reference* frame.
///
/// This is a plain rotation-matrix inverse (transpose = negate the
/// angle), exact for any rigid transform; no iteration or approximation
/// is involved.
export function invertSimilarityTransform({
  rotationDegrees,
  sourceOffsetX,
  sourceOffsetY,
  centerX,
  centerY,
}) {
  const radians = -rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return function forwardTransform(sourceX, sourceY) {
    const shiftedX = sourceX - sourceOffsetX - centerX;
    const shiftedY = sourceY - sourceOffsetY - centerY;
    return {
      x: centerX + cosine * shiftedX - sine * shiftedY,
      y: centerY + sine * shiftedX + cosine * shiftedY,
    };
  };
}

const CHANNEL_COUNT = 3; // red, green, blue -- matches cfaColorAt's 0/1/2

/// Derives a frame's local rotation angle from its `forwardTransform`, by
/// mapping two nearby points and measuring the angle of the vector
/// between them: since the original (pre-transform) vector points along
/// +x, the transformed vector's angle *is* the transform's rotation.
///
/// Computed once per frame (not per pixel) since every `forwardTransform`
/// this module receives — the identity, or `invertSimilarityTransform`'s
/// output — is a single rigid (rotation + translation, no scale)
/// transform, so its rotation is constant everywhere; one measurement is
/// exact, not an approximation. This is what feeds `DrizzleAccumulator.
/// addRotatedDrop`, letting every splatted sample use its frame's actual
/// footprint orientation instead of an axis-aligned approximation — see
/// that method's doc comment for why this matters for image quality.
function deriveRotationRadians(forwardTransform) {
  const origin = forwardTransform(0, 0);
  const alongX = forwardTransform(1, 0);
  return Math.atan2(alongX.y - origin.y, alongX.x - origin.x);
}

/// Drizzles a set of raw (Bayer) frames onto one supersampled RGB output
/// grid.
///
/// - `frames`: array of `{ width, height, cfaPattern, samples,
///   forwardTransform, weight? }`. `forwardTransform(sourceX, sourceY)`
///   must return `{x, y}`, the position this frame's `(sourceX,
///   sourceY)` sample lands at on the *output* grid (see
///   `invertSimilarityTransform` for building this from a registration
///   estimate; use `(x, y) => ({x, y})` — the identity — for the
///   reference frame itself). `weight` (default 1) is an optional
///   per-frame quality weight (e.g. lower for a noisier or worse-focused
///   frame), applied uniformly to every sample in that frame.
/// - `outputWidth`, `outputHeight`: output grid dimensions, already
///   scaled up from the input frame size by the caller's chosen
///   supersampling factor (e.g. 2x).
/// - `outputScale` (default 2): output-grid pixels per input-frame
///   pixel; used only to convert `pixfrac` into the accumulator's drop
///   half-extents (see `DrizzleAccumulator.addRotatedDrop`).
/// - `pixfrac` (default 0.7, the common drizzle default balancing noise
///   suppression against resolution): drop size as a fraction of one
///   input pixel.
///
/// Each sample is splatted via `DrizzleAccumulator.addRotatedDrop`,
/// using the frame's own local rotation (see `deriveRotationRadians`) so
/// a rotated frame's footprint is distributed across output pixels
/// exactly, not approximated as axis-aligned — the image-quality-correct
/// choice for any frame with a nonzero registration rotation, which
/// includes essentially every non-reference frame in a real stacking
/// session. See WORK49_PROGRESS.md.
///
/// Returns `{ width, height, channels }`, where `channels` is an array
/// of three `{ value, coverage }` planes (index 0/1/2 = red/green/blue,
/// matching `cfaColorAt`'s convention), each shaped like
/// `DrizzleAccumulator.finalize()`'s result.
export function cfaDrizzle({
  frames,
  outputWidth,
  outputHeight,
  outputScale = 2,
  pixfrac = 0.7,
}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new InvalidCfaDrizzleInput('At least one frame is required.');
  }
  if (!Number.isFinite(pixfrac) ||
      !Number.isFinite(outputScale) ||
      !(pixfrac > 0) ||
      !(outputScale > 0)) {
    throw new InvalidCfaDrizzleInput(
      'pixfrac and outputScale must be finite and positive.',
    );
  }
  const dropHalfExtent = 0.5 * pixfrac * outputScale;

  const accumulators = [];
  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    accumulators.push(
      new DrizzleAccumulator({ width: outputWidth, height: outputHeight }),
    );
  }

  for (const frame of frames) {
    const {
      width,
      height,
      cfaPattern,
      samples,
      forwardTransform,
      weight = 1,
    } = frame;
    if (samples.length !== width * height) {
      throw new InvalidCfaDrizzleInput(
        'A frame\'s sample count does not match its width and height.',
      );
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new InvalidCfaDrizzleInput(
        'Every CFA drizzle frame weight must be finite and non-negative.',
      );
    }
    const rotationRadians = deriveRotationRadians(forwardTransform);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const channel = cfaColorAt(cfaPattern, x, y);
        const mapped = forwardTransform(x, y);
        const outputX = mapped.x * outputScale;
        const outputY = mapped.y * outputScale;
        accumulators[channel].addRotatedDrop(
          outputX,
          outputY,
          samples[y * width + x],
          {
            rotationRadians,
            halfWidth: dropHalfExtent,
            halfHeight: dropHalfExtent,
            weight,
          },
        );
      }
    }
  }

  return {
    width: outputWidth,
    height: outputHeight,
    channels: accumulators.map((accumulator) => accumulator.finalize()),
  };
}
