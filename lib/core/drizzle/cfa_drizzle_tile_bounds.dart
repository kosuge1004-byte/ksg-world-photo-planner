import 'dart:math' as math;

import '../registration/similarity_transform_math.dart';

/// The rectangular sub-region of one source frame's raw CFA mosaic that
/// `FileBackedLinearRawMosaicStore.readRegion` must be asked for to
/// supply every sample whose drizzle "drop" could possibly overlap a
/// given output tile — the piece this project's tiled CFA drizzle
/// pipeline needs to actually bound memory (see `WORK85_PROGRESS.md`'s
/// "未対応" and `file_backed_linear_raw_mosaic_store.dart`'s own doc
/// comment for why this matters).
final class CfaDrizzleSourceBounds {
  const CfaDrizzleSourceBounds({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final int x;
  final int y;
  final int width;
  final int height;
}

/// Computes the source-frame rectangle [CfaDrizzleSourceBounds] (see
/// that class) needs to cover, for one output tile of a `cfaDrizzle`-
/// style combine.
///
/// Mirrors `TiledAffineRgbResampler._sourceBounds`'s exact structure
/// (four-corner bounding box under the transform, then an integer-pixel
/// margin, then clamped to the source frame's own valid extent) — the
/// same shape of problem, "which source pixels could possibly matter for
/// this output tile," solved the same way. Two differences from that
/// resampler's version, both because CFA drizzle's own transform
/// direction and footprint model differ from point-sample resampling:
///
/// - **Transform direction**: `cfaDrizzle`'s `forwardTransform`
///   parameter maps *source -> output* (see that function's own doc
///   comment), the opposite direction `TiledAffineRgbResampler` needs
///   (*output -> source*, for resampling). Conveniently, the *un-
///   inverted* [SimilarityTransformEstimate] a registration pass already
///   produces — the same one [invertSimilarityTransform] would invert to
///   build the drizzle-side `forwardTransform` — is already in the
///   *output -> source* direction via [applySimilarityForward] (matching
///   `AffineSamplingTransform.similarity`'s own resampling convention),
///   so this function uses that directly rather than needing to invert
///   an inverse back again.
/// - **Margin size**: a drizzle drop has a real footprint extent (unlike
///   a resampler's zero-width point sample), so a source sample whose
///   own mapped position falls just *outside* the naively-scaled tile
///   bounds can still contribute to this tile if its drop's footprint
///   reaches in. Since `pixfrac` is defined as "drop size as a fraction
///   of one *input* pixel" (see `DrizzleAccumulator`/`cfa_drizzle.dart`),
///   the needed source-space margin is exactly `0.5 * pixfrac` source
///   pixels — independent of `outputScale`, because a rigid similarity
///   transform preserves distances exactly, so a footprint half-extent
///   measured in output-native units (`0.5 * pixfrac`, before the
///   `outputScale` multiplication `cfaDrizzle` itself applies) equals
///   the same half-extent back in source units.
///
/// - [transformEstimate]: `null` for the reference frame itself (the
///   identity — no rotation, no offset), or the registration estimate
///   for any other frame, in the same *output -> source* direction
///   `AffineSamplingTransform.similarity`/[applySimilarityForward] use.
/// - [outputScale]: the same supersampling factor passed to
///   `cfaDrizzle`; [outputTileX]/[outputTileY]/[outputTileWidth]/
///   [outputTileHeight] are all in the *supersampled* output grid's own
///   units (matching an `OverlappedTile`'s `outputX`/etc, not native
///   frame-scale units) and are converted to native scale internally
///   before the transform is applied, since [applySimilarityForward]
///   (like `cfaDrizzle`'s own `forwardTransform`) operates in native,
///   pre-supersampling units.
/// - [pixfrac]: the same drop-size fraction passed to `cfaDrizzle`.
///
/// Returns `null` if this output tile's required source region does not
/// overlap `[0, sourceWidth) x [0, sourceHeight)` at all — the frame
/// contributes nothing to this tile, and the caller should skip reading
/// from (or splatting samples from) this frame for this tile entirely.
/// - [additionalMargin] (default `0`, Work123): extra source-space
///   margin, in pixels, added on top of the drop-footprint margin
///   above. Exists specifically for local registration
///   (`local_residual_correction.dart`, Work119-122): when a frame's
///   `forwardTransform` includes a position-dependent local correction
///   on top of its global similarity transform, this function's own
///   four-corner bounding box (computed from the *global* transform
///   alone, via [applySimilarityForward]) can be too tight — a source
///   sample whose *locally-corrected* position lands inside this output
///   tile might sit just outside the globally-computed box. Callers
///   using a local correction field should pass that field's own
///   `maximumCorrectionMagnitude` here, so the source region read is
///   guaranteed wide enough regardless of where within the field's own
///   bound the actual local correction happens to land.
CfaDrizzleSourceBounds? cfaDrizzleSourceBounds({
  required int sourceWidth,
  required int sourceHeight,
  required int outputTileX,
  required int outputTileY,
  required int outputTileWidth,
  required int outputTileHeight,
  required double outputScale,
  required double pixfrac,
  SimilarityTransformEstimate? transformEstimate,
  double additionalMargin = 0,
}) {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw ArgumentError('sourceWidth and sourceHeight must be positive.');
  }
  if (outputTileWidth <= 0 || outputTileHeight <= 0) {
    throw ArgumentError(
      'outputTileWidth and outputTileHeight must be positive.',
    );
  }
  if (!(outputScale > 0)) {
    throw ArgumentError('outputScale must be positive.');
  }
  if (!(pixfrac > 0)) {
    throw ArgumentError('pixfrac must be positive.');
  }

  // Output tile corners, converted from supersampled-grid units to the
  // native (pre-outputScale) units applySimilarityForward operates in.
  final double left = outputTileX / outputScale;
  final double top = outputTileY / outputScale;
  final double right = (outputTileX + outputTileWidth - 1) / outputScale;
  final double bottom = (outputTileY + outputTileHeight - 1) / outputScale;

  ({double x, double y}) mapCorner(double x, double y) {
    if (transformEstimate == null) return (x: x, y: y);
    return applySimilarityForward(transformEstimate, x, y);
  }

  final List<({double x, double y})> corners = <({double x, double y})>[
    mapCorner(left, top),
    mapCorner(right, top),
    mapCorner(left, bottom),
    mapCorner(right, bottom),
  ];
  if (corners.any(
    (({double x, double y}) c) => !c.x.isFinite || !c.y.isFinite,
  )) {
    throw StateError('Transform produced a non-finite coordinate.');
  }

  final double minimumX = corners.map((c) => c.x).reduce(math.min);
  final double maximumX = corners.map((c) => c.x).reduce(math.max);
  final double minimumY = corners.map((c) => c.y).reduce(math.min);
  final double maximumY = corners.map((c) => c.y).reduce(math.max);

  if (!(additionalMargin >= 0)) {
    throw ArgumentError('additionalMargin must be non-negative.');
  }

  final int marginPixels = (0.5 * pixfrac + additionalMargin).ceil();

  if (maximumX + marginPixels < 0 ||
      maximumY + marginPixels < 0 ||
      minimumX - marginPixels > sourceWidth - 1 ||
      minimumY - marginPixels > sourceHeight - 1) {
    return null;
  }

  final int x = (minimumX.floor() - marginPixels).clamp(0, sourceWidth - 1);
  final int y = (minimumY.floor() - marginPixels).clamp(0, sourceHeight - 1);
  final int rightInclusive =
      (maximumX.floor() + marginPixels).clamp(0, sourceWidth - 1);
  final int bottomInclusive =
      (maximumY.floor() + marginPixels).clamp(0, sourceHeight - 1);

  return CfaDrizzleSourceBounds(
    x: x,
    y: y,
    width: rightInclusive - x + 1,
    height: bottomInclusive - y + 1,
  );
}
