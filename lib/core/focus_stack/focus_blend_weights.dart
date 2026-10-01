import 'dart:math' as math;
import 'dart:typed_data';

import 'focus_aligned_frame.dart';
import 'focus_winner_map.dart';

final class FocusBlendWeights {
  FocusBlendWeights({
    required this.width,
    required this.height,
    required this.frameCount,
    required Float32List interleavedWeights,
  }) : interleavedWeights = interleavedWeights {
    final int pixels = width * height;
    if (width <= 0 ||
        height <= 0 ||
        frameCount < 2 ||
        interleavedWeights.length != pixels * frameCount) {
      throw ArgumentError(
          'Focus-blend weight buffer does not match dimensions.');
    }
    for (int pixel = 0; pixel < pixels; pixel++) {
      double sum = 0;
      for (int frame = 0; frame < frameCount; frame++) {
        final double value = interleavedWeights[pixel * frameCount + frame];
        if (!value.isFinite || value < 0 || value > 1) {
          throw ArgumentError('Focus-blend weights must be finite in [0,1].');
        }
        sum += value;
      }
      if ((sum - 1).abs() > 1e-5) {
        throw ArgumentError('Focus-blend weights must sum to one per pixel.');
      }
    }
  }

  final int width;
  final int height;
  final int frameCount;
  final Float32List interleavedWeights;

  double weightAt(int x, int y, int frame) {
    if (x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height ||
        frame < 0 ||
        frame >= frameCount) {
      throw RangeError('Focus-blend coordinate is outside range.');
    }
    return interleavedWeights[(y * width + x) * frameCount + frame];
  }
}

FocusBlendWeights buildFocusBlendWeights({
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
  final Float32List weights = Float32List(pixels * frames.length);
  for (int pixel = 0; pixel < pixels; pixel++) {
    computer.writePixel(
      pixel: pixel,
      destination: weights,
      destinationOffset: pixel * frames.length,
    );
  }

  return FocusBlendWeights(
    width: winners.width,
    height: winners.height,
    frameCount: frames.length,
    interleavedWeights: weights,
  );
}

/// Validates one focus-blend input set and writes its Float32-quantized weights
/// one pixel at a time. Callers may therefore reuse a frame-sized scratch
/// vector instead of retaining a full image-sized weight plane.
final class FocusBlendWeightComputer {
  FocusBlendWeightComputer({
    required this.frames,
    required this.winners,
    this.hardWinnerConfidence = 0.65,
    this.maximumSecondaryWeight = 0.45,
    this.haloDifferenceScale = 4.0,
  }) {
    if (frames.length < 2 ||
        !hardWinnerConfidence.isFinite ||
        hardWinnerConfidence < 0 ||
        hardWinnerConfidence > 1 ||
        !maximumSecondaryWeight.isFinite ||
        maximumSecondaryWeight < 0 ||
        maximumSecondaryWeight > 0.5 ||
        !haloDifferenceScale.isFinite ||
        haloDifferenceScale < 0) {
      throw ArgumentError('Invalid focus-blend parameters.');
    }
    for (final FocusAlignedFrame frame in frames) {
      if (frame.width != winners.width || frame.height != winners.height) {
        throw ArgumentError(
          'All aligned focus frames must match winner dimensions.',
        );
      }
    }
  }

  final List<FocusAlignedFrame> frames;
  final FocusWinnerMap winners;
  final double hardWinnerConfidence;
  final double maximumSecondaryWeight;
  final double haloDifferenceScale;

  /// [destination] must be zero in this frame-sized region before the call.
  @pragma('vm:prefer-inline')
  void writePixel({
    required int pixel,
    required Float32List destination,
    required int destinationOffset,
  }) {
    final int pixelCount = winners.width * winners.height;
    if (pixel < 0 || pixel >= pixelCount) {
      throw RangeError.range(pixel, 0, pixelCount - 1, 'pixel');
    }
    if (destinationOffset < 0 ||
        destinationOffset + frames.length > destination.length) {
      throw RangeError('Focus-blend weight destination is too small.');
    }

    final int winner = winners.frameIndices[pixel];
    if (winner < 0 || winner >= frames.length) {
      throw ArgumentError('Winner frame index is outside aligned frame range.');
    }

    if (frames[winner].coverage[pixel] == 0) {
      final int fallback = _nearestCoveredFrame(frames, pixel, winner);
      destination[destinationOffset + fallback] = 1;
      return;
    }

    final double confidence = winners.confidence[pixel];
    if (confidence >= hardWinnerConfidence) {
      destination[destinationOffset + winner] = 1;
      return;
    }

    final int? secondary = _bestAdjacentCoveredFrame(
      frames,
      pixel,
      winner,
    );
    if (secondary == null) {
      destination[destinationOffset + winner] = 1;
      return;
    }

    final double ambiguity =
        ((hardWinnerConfidence - confidence) / hardWinnerConfidence)
            .clamp(0, 1)
            .toDouble();
    final double difference = _relativeRgbDifference(
      frames[winner],
      frames[secondary],
      pixel,
    );
    final double haloAttenuation = 1 / (1 + haloDifferenceScale * difference);
    final double secondaryWeight =
        (maximumSecondaryWeight * ambiguity * haloAttenuation)
            .clamp(0, maximumSecondaryWeight)
            .toDouble();

    destination[destinationOffset + winner] = 1 - secondaryWeight;
    destination[destinationOffset + secondary] = secondaryWeight;
  }
}

int _nearestCoveredFrame(
  List<FocusAlignedFrame> frames,
  int pixel,
  int preferred,
) {
  if (frames[preferred].coverage[pixel] != 0) return preferred;
  for (int distance = 1; distance < frames.length; distance++) {
    final int lower = preferred - distance;
    if (lower >= 0 && frames[lower].coverage[pixel] != 0) return lower;
    final int upper = preferred + distance;
    if (upper < frames.length && frames[upper].coverage[pixel] != 0) {
      return upper;
    }
  }
  throw StateError('No aligned focus frame covers output pixel.');
}

int? _bestAdjacentCoveredFrame(
  List<FocusAlignedFrame> frames,
  int pixel,
  int winner,
) {
  int? best;
  double bestDifference = double.infinity;
  for (final int candidate in <int>[winner - 1, winner + 1]) {
    if (candidate < 0 ||
        candidate >= frames.length ||
        frames[candidate].coverage[pixel] == 0) {
      continue;
    }
    final double difference =
        _relativeRgbDifference(frames[winner], frames[candidate], pixel);
    if (difference < bestDifference) {
      bestDifference = difference;
      best = candidate;
    }
  }
  return best;
}

double _relativeRgbDifference(
  FocusAlignedFrame a,
  FocusAlignedFrame b,
  int pixel,
) {
  final int base = pixel * 3;
  double squaredDifference = 0;
  double referenceEnergy = 0;
  for (int channel = 0; channel < 3; channel++) {
    final double av = a.interleavedRgb[base + channel];
    final double bv = b.interleavedRgb[base + channel];
    final double delta = av - bv;
    squaredDifference += delta * delta;
    referenceEnergy += av * av + bv * bv;
  }
  final double denominator = math.sqrt(referenceEnergy * 0.5) + 1e-12;
  return math.sqrt(squaredDifference / 3) / denominator;
}
