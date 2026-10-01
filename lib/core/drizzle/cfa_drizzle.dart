import 'dart:math' as math;
import 'dart:typed_data';

import '../image/cfa_pattern.dart';
import '../registration/similarity_transform_math.dart';
import 'drizzle_accumulator.dart';

/// Dart port of `tool/raw_samples/cfa_drizzle_reference.mjs`.
///
/// CFA-domain drizzle: combines multiple raw (Bayer) frames onto one
/// supersampled output grid, per Work34's roadmap item "CFA-domain
/// drizzle and weight-map output". Each frame's raw samples are splatted
/// directly onto the output grid — before demosaicing — using one
/// [DrizzleAccumulator] (Work84) per CFA color, so a red sample never
/// blends with a green or blue one. This preserves detail that
/// demosaicing-then-stacking would smear: demosaicing invents values
/// between real sensor samples, and averaging those interpolated values
/// across frames compounds each frame's interpolation error, while
/// drizzling raw samples first and demosaicing the combined, higher-
/// effective-resolution result only interpolates once.
///
/// This is the **whole-frame, in-memory** port — every frame's samples
/// and the entire output grid are held in memory at once, matching the
/// Node reference's own shape exactly for a faithful, directly-testable
/// port. It is deliberately **not yet** the tiled, file-backed pipeline
/// `HANDOFF_WORK84_STATUS_AT_LIMIT.md` describes as the next step ("output
/// tileごとに必要入力CFA範囲だけを読み、ファイルバックドRGB/coverage
/// storeへcommit") — that needs a new streaming/tile-store abstraction
/// for raw CFA mosaics that does not exist yet (`LinearRawMosaic` is
/// itself whole-frame, in-memory only; unlike `LinearRgbTileStore`,
/// there is no file-backed, region-readable raw-mosaic store to build
/// on). Rather than rushing an under-designed tiled wrapper around an
/// unported core algorithm, this work ports and thoroughly verifies the
/// core algorithm first — the part where a subtle error would silently
/// corrupt image quality — and leaves the tiled/file-backed memory-
/// scaling wrapper as clearly-scoped follow-up work (see this project's
/// own `WORK*_PROGRESS.md` convention of not conflating "correct" with
/// "production-scale" in one step).
///
/// This file has not been executed against the Dart SDK. It is a careful
/// line-by-line translation of the Node reference, which has full test
/// coverage (`cfa_drizzle_reference.test.mjs`, including whole-sample-
/// reproduction, flux conservation under translation and rotation,
/// supersampling detail recovery, and per-frame weighting). Run
/// `test/cfa_drizzle_test.dart` (mirroring those fixtures) before relying
/// on this in production.

class InvalidCfaDrizzleInput extends ArgumentError {
  InvalidCfaDrizzleInput(String super.message);
}

/// A rigid, invertible forward transform: given a position in a source
/// frame, returns where it lands on the shared output/reference grid.
/// Use `(x, y) => (x: x, y: y)` for the reference frame itself (the
/// identity), or [invertSimilarityTransform] to build one from a
/// registration estimate (see that function's own doc comment for the
/// direction convention).
typedef CfaDrizzleForwardTransform = ({double x, double y}) Function(
  double sourceX,
  double sourceY,
);

/// One source frame to drizzle: raw (Bayer) [samples] in row-major order
/// (length must equal `width * height`), its [cfaPattern], and the
/// [forwardTransform] mapping this frame's own pixel positions onto the
/// shared output grid. [weight] (default 1) is an optional per-frame
/// quality weight (e.g. lower for a noisier or worse-focused frame),
/// applied uniformly to every sample in this frame.
final class CfaDrizzleFrame {
  const CfaDrizzleFrame({
    required this.width,
    required this.height,
    required this.cfaPattern,
    required this.samples,
    required this.forwardTransform,
    this.weight = 1,
  });

  final int width;
  final int height;
  final CfaPattern cfaPattern;
  final Float32List samples;
  final CfaDrizzleForwardTransform forwardTransform;
  final double weight;
}

/// [cfaDrizzle]'s result: the output grid dimensions and one
/// [DrizzleResult] per CFA channel, indexed to match [CfaColor.index]
/// (0 = red, 1 = green, 2 = blue).
final class CfaDrizzleResult {
  const CfaDrizzleResult({
    required this.width,
    required this.height,
    required this.channels,
  });

  final int width;
  final int height;
  final List<DrizzleResult> channels;
}

const int _channelCount = 3; // red, green, blue -- matches CfaColor.index

/// Derives a frame's local rotation angle from its [forwardTransform], by
/// mapping two nearby points and measuring the angle of the vector
/// between them: since the original (pre-transform) vector points along
/// +x, the transformed vector's angle *is* the transform's rotation.
///
/// Computed once per frame (not per pixel) since every forward transform
/// this module receives — the identity, or [invertSimilarityTransform]'s
/// output — is a single rigid (rotation + translation, no scale)
/// transform, so its rotation is constant everywhere; one measurement is
/// exact, not an approximation. This is what feeds
/// [DrizzleAccumulator.addRotatedDrop], letting every splatted sample use
/// its frame's actual footprint orientation instead of an axis-aligned
/// approximation.
double _deriveRotationRadians(CfaDrizzleForwardTransform forwardTransform) {
  final ({double x, double y}) origin = forwardTransform(0, 0);
  final ({double x, double y}) alongX = forwardTransform(1, 0);
  return math.atan2(alongX.y - origin.y, alongX.x - origin.x);
}

/// Drizzles a set of raw (Bayer) [frames] onto one supersampled RGB
/// output grid.
///
/// - [outputWidth], [outputHeight]: output grid dimensions, already
///   scaled up from the input frame size by the caller's chosen
///   supersampling factor (e.g. 2x).
/// - [outputScale] (default 2): output-grid pixels per input-frame
///   pixel; used only to convert [pixfrac] into the accumulator's drop
///   half-extents (see [DrizzleAccumulator.addRotatedDrop]).
/// - [pixfrac] (default 0.7, the common drizzle default balancing noise
///   suppression against resolution): drop size as a fraction of one
///   input pixel.
///
/// Each sample is splatted via [DrizzleAccumulator.addRotatedDrop], using
/// the frame's own local rotation (see [_deriveRotationRadians]) so a
/// rotated frame's footprint is distributed across output pixels
/// exactly, not approximated as axis-aligned — the image-quality-correct
/// choice for any frame with a nonzero registration rotation, which
/// includes essentially every non-reference frame in a real stacking
/// session. See WORK49_PROGRESS.md.
///
/// Throws [InvalidCfaDrizzleInput] if [frames] is empty, if [pixfrac] or
/// [outputScale] is not positive, or if any frame's sample count does
/// not match its own declared width/height.
CfaDrizzleResult cfaDrizzle({
  required List<CfaDrizzleFrame> frames,
  required int outputWidth,
  required int outputHeight,
  double outputScale = 2,
  double pixfrac = 0.7,
}) {
  if (frames.isEmpty) {
    throw InvalidCfaDrizzleInput('At least one frame is required.');
  }
  if (!pixfrac.isFinite ||
      !outputScale.isFinite ||
      !(pixfrac > 0) ||
      !(outputScale > 0)) {
    throw InvalidCfaDrizzleInput(
      'pixfrac and outputScale must be finite and positive.',
    );
  }
  final double dropHalfExtent = 0.5 * pixfrac * outputScale;

  final List<DrizzleAccumulator> accumulators = <DrizzleAccumulator>[
    for (int channel = 0; channel < _channelCount; channel++)
      DrizzleAccumulator(width: outputWidth, height: outputHeight),
  ];

  for (final CfaDrizzleFrame frame in frames) {
    if (frame.samples.length != frame.width * frame.height) {
      throw InvalidCfaDrizzleInput(
        "A frame's sample count does not match its width and height.",
      );
    }
    if (!frame.weight.isFinite || frame.weight < 0) {
      throw InvalidCfaDrizzleInput(
        'Every CFA drizzle frame weight must be finite and non-negative.',
      );
    }
    final double rotationRadians = _deriveRotationRadians(
      frame.forwardTransform,
    );
    for (int y = 0; y < frame.height; y++) {
      for (int x = 0; x < frame.width; x++) {
        final int channel = frame.cfaPattern.colorAt(x, y).index;
        final ({double x, double y}) mapped = frame.forwardTransform(
          x.toDouble(),
          y.toDouble(),
        );
        final double outputX = mapped.x * outputScale;
        final double outputY = mapped.y * outputScale;
        accumulators[channel].addRotatedDrop(
          outputX,
          outputY,
          frame.samples[y * frame.width + x],
          rotationRadians: rotationRadians,
          halfWidth: dropHalfExtent,
          halfHeight: dropHalfExtent,
          weight: frame.weight,
        );
      }
    }
  }

  return CfaDrizzleResult(
    width: outputWidth,
    height: outputHeight,
    channels: <DrizzleResult>[
      for (final DrizzleAccumulator accumulator in accumulators)
        accumulator.finalize(),
    ],
  );
}
