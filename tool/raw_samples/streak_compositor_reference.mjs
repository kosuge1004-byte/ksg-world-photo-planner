/// Reference selective streak compositor for Mobile Stack's meteor mode.
///
/// Completes the "検出し、選んだ流星だけを背景へ合成します" (detect
/// candidates, composite only the selected one(s) onto the background)
/// workflow described in processing_mode.dart: given a background RGB
/// tile (typically the stack's base frame, or a separately built
/// low-noise composite of the whole sequence) and a foreground RGB tile
/// (the single frame that contains the streak the user picked from
/// `streak_candidate_detector_reference.mjs`'s candidates), this module
/// blends in *only* the pixels near the selected streak(s), leaving the
/// rest of the frame untouched.
///
/// This matters because the foreground frame containing a meteor is just
/// one ordinary frame from the sequence: compositing the *entire* frame
/// (rather than just the streak) would reintroduce that single frame's
/// full noise level, any other transient it happens to contain (a
/// satellite, a plane, a different unselected streak), and any minor
/// framing drift, into what should otherwise stay the clean multi-frame
/// background.

export class InvalidStreakCompositeInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStreakCompositeInput';
  }
}

function validate(background, foreground) {
  if (!(background.rgb instanceof Float32Array)
      || !(foreground.rgb instanceof Float32Array)) {
    throw new InvalidStreakCompositeInput('rgb must be a Float32Array.');
  }
  if (background.width !== foreground.width
      || background.height !== foreground.height) {
    throw new InvalidStreakCompositeInput(
      'Background and foreground must share the same dimensions.',
    );
  }
  const expectedLength = background.width * background.height * 3;
  if (background.rgb.length !== expectedLength
      || foreground.rgb.length !== expectedLength) {
    throw new InvalidStreakCompositeInput(
      'rgb length does not match width * height * 3.',
    );
  }
}

/// Squared distance from point `(px, py)` to the line segment `(x0, y0)`
/// -`(x1, y1)`.
function squaredDistanceToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) {
    const ox = px - x0;
    const oy = py - y0;
    return ox * ox + oy * oy;
  }
  const t = Math.max(
    0,
    Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSquared),
  );
  const closestX = x0 + t * dx;
  const closestY = y0 + t * dy;
  const ox = px - closestX;
  const oy = py - closestY;
  return ox * ox + oy * oy;
}

/// Builds a boolean mask (`Uint8Array`, one entry per pixel, row-major)
/// marking every pixel within `streak.width / 2 + paddingPixels` of any
/// selected streak's `endpoints` line segment.
///
/// Exported separately from `compositeSelectedStreaks` so callers can
/// inspect, visualize, or further edit the affected region (e.g. an
/// interactive "brush to extend/trim the selection" UI) before
/// compositing.
export function buildStreakMask({
  width,
  height,
  streaks,
  paddingPixels = 3,
}) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0) {
    throw new InvalidStreakCompositeInput(
      'Mask dimensions must be positive integers.',
    );
  }
  const mask = new Uint8Array(width * height);
  if (streaks.length === 0) return mask;

  // Bound the search to each streak's own padded bounding box rather
  // than scanning the whole frame per streak; a typical meteor streak
  // covers a small fraction of a full frame's area.
  for (const streak of streaks) {
    const [a, b] = streak.endpoints;
    const radius = streak.width / 2 + paddingPixels;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
    const radiusSquared = radius * radius;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const index = y * width + x;
        if (mask[index]) continue; // already covered by an earlier streak
        const distanceSquared = squaredDistanceToSegment(
          x, y, a.x, a.y, b.x, b.y,
        );
        if (distanceSquared <= radiusSquared) mask[index] = 1;
      }
    }
  }
  return mask;
}

/// Composites `foreground` onto `background`, restricted to pixels near
/// `streaks` (as `buildStreakMask` selects), blending each such pixel via
/// a per-channel lighten (max) — consistent with
/// `lighten_blend_reference.mjs`'s star-trail blend mode, and the
/// natural choice for a meteor: its streak should always be at least as
/// bright as the background sky/foreground behind it, never dimmer.
///
/// - `background`, `foreground`: `{ width, height, rgb: Float32Array
///   (interleaved) }`, matching `LinearRgbTile`'s shape.
/// - `streaks`: the selected `StreakCandidate`-shaped object(s) (only
///   `endpoints` and `width` are read).
/// - `paddingPixels` (default 3): extra margin beyond the streak's own
///   estimated width, so a slightly-underestimated width or a softly
///   anti-aliased streak edge doesn't get a hard cutoff.
///
/// Returns a new `{ width, height, rgb }`; does not mutate either input.
export function compositeSelectedStreaks({
  background,
  foreground,
  streaks,
  paddingPixels = 3,
}) {
  validate(background, foreground);
  if (!Array.isArray(streaks) || streaks.length === 0) {
    throw new InvalidStreakCompositeInput(
      'At least one streak must be selected.',
    );
  }
  const { width, height } = background;
  const mask = buildStreakMask({ width, height, streaks, paddingPixels });
  const rgb = Float32Array.from(background.rgb);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (!mask[pixel]) continue;
    const base = pixel * 3;
    rgb[base] = Math.max(rgb[base], foreground.rgb[base]);
    rgb[base + 1] = Math.max(rgb[base + 1], foreground.rgb[base + 1]);
    rgb[base + 2] = Math.max(rgb[base + 2], foreground.rgb[base + 2]);
  }
  return { width, height, rgb };
}
