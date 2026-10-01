import 'dart:typed_data';

import 'focus_aligned_frame.dart';
import 'focus_blend_weights.dart';
import 'focus_winner_map.dart';

final class FocusBlendResult {
  FocusBlendResult({
    required this.width,
    required this.height,
    required Float32List interleavedRgb,
    required Uint8List coverage,
  })  : interleavedRgb = interleavedRgb,
        coverage = coverage {
    final int pixels = width * height;
    if (interleavedRgb.length != pixels * 3 || coverage.length != pixels) {
      throw ArgumentError('Focus-blend result dimensions are inconsistent.');
    }
  }

  final int width;
  final int height;
  final Float32List interleavedRgb;
  final Uint8List coverage;
}

FocusBlendResult blendAlignedFocusFrames({
  required List<FocusAlignedFrame> frames,
  required FocusBlendWeights weights,
}) {
  if (frames.length != weights.frameCount || frames.length < 2) {
    throw ArgumentError('Focus frames and weight frame count do not match.');
  }
  for (final FocusAlignedFrame frame in frames) {
    if (frame.width != weights.width || frame.height != weights.height) {
      throw ArgumentError('Focus frames and weights must share dimensions.');
    }
  }

  final int pixels = weights.width * weights.height;
  final Float32List output = Float32List(pixels * 3);
  final Uint8List coverage = Uint8List(pixels);

  for (int pixel = 0; pixel < pixels; pixel++) {
    double r = 0;
    double g = 0;
    double b = 0;
    double usedWeight = 0;
    for (int frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      final double weight =
          weights.interleavedWeights[pixel * frames.length + frameIndex];
      if (!(weight > 0)) continue;
      final FocusAlignedFrame frame = frames[frameIndex];
      if (frame.coverage[pixel] == 0) continue;
      final int base = pixel * 3;
      r += frame.interleavedRgb[base] * weight;
      g += frame.interleavedRgb[base + 1] * weight;
      b += frame.interleavedRgb[base + 2] * weight;
      usedWeight += weight;
    }
    if (!(usedWeight > 0)) continue;

    final int outBase = pixel * 3;
    final double inverse = 1 / usedWeight;
    final double rr = r * inverse;
    final double gg = g * inverse;
    final double bb = b * inverse;
    if (!rr.isFinite || !gg.isFinite || !bb.isFinite) {
      throw StateError('Focus blending produced a non-finite pixel.');
    }
    output[outBase] = rr;
    output[outBase + 1] = gg;
    output[outBase + 2] = bb;
    coverage[pixel] = 1;
  }

  return FocusBlendResult(
    width: weights.width,
    height: weights.height,
    interleavedRgb: output,
    coverage: coverage,
  );
}

/// Produces the same Float32 focus blend as
/// [buildFocusBlendWeights] followed by [blendAlignedFocusFrames], but keeps
/// only one frame-sized weight vector instead of a full-resolution weight
/// plane.
FocusBlendResult blendAlignedFocusFramesMemoryBounded({
  required List<FocusAlignedFrame> frames,
  required FocusWinnerMap winners,
  double hardWinnerConfidence = 0.65,
  double maximumSecondaryWeight = 0.45,
  double haloDifferenceScale = 4.0,
}) {
  final FocusBlendWeightComputer computer = FocusBlendWeightComputer(
    frames: frames,
    winners: winners,
    hardWinnerConfidence: hardWinnerConfidence,
    maximumSecondaryWeight: maximumSecondaryWeight,
    haloDifferenceScale: haloDifferenceScale,
  );
  final int pixels = winners.width * winners.height;
  final Float32List frameWeights = Float32List(frames.length);
  // The blend is a per-pixel reduction. writePixel and the accumulation below
  // consume frame zero at the current pixel before that same pixel is
  // overwritten, and no later iteration reads it again. Reusing the reference
  // tile therefore preserves values while removing another tile-sized RGB and
  // coverage allocation from the production memory-bounded path.
  final Float32List output = frames[0].interleavedRgb;
  final Uint8List coverage = frames[0].coverage;

  for (int pixel = 0; pixel < pixels; pixel++) {
    frameWeights.fillRange(0, frameWeights.length, 0);
    computer.writePixel(
      pixel: pixel,
      destination: frameWeights,
      destinationOffset: 0,
    );

    double r = 0;
    double g = 0;
    double b = 0;
    double usedWeight = 0;
    for (int frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      final double weight = frameWeights[frameIndex];
      if (!(weight > 0)) continue;
      final FocusAlignedFrame frame = frames[frameIndex];
      if (frame.coverage[pixel] == 0) continue;
      final int base = pixel * 3;
      r += frame.interleavedRgb[base] * weight;
      g += frame.interleavedRgb[base + 1] * weight;
      b += frame.interleavedRgb[base + 2] * weight;
      usedWeight += weight;
    }
    final int outBase = pixel * 3;
    if (!(usedWeight > 0)) {
      output[outBase] = 0;
      output[outBase + 1] = 0;
      output[outBase + 2] = 0;
      coverage[pixel] = 0;
      continue;
    }

    final double inverse = 1 / usedWeight;
    final double rr = r * inverse;
    final double gg = g * inverse;
    final double bb = b * inverse;
    if (!rr.isFinite || !gg.isFinite || !bb.isFinite) {
      throw StateError('Focus blending produced a non-finite pixel.');
    }
    output[outBase] = rr;
    output[outBase + 1] = gg;
    output[outBase + 2] = bb;
    coverage[pixel] = 1;
  }

  return FocusBlendResult(
    width: winners.width,
    height: winners.height,
    interleavedRgb: output,
    coverage: coverage,
  );
}
