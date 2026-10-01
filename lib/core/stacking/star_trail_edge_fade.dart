import 'dart:math' as math;

/// Which end(s) of the star-trail sequence should be faded.
///
/// Star trail mode combines frames with an unweighted lighten blend (see
/// `lighten_blend_combiner.dart`): every frame contributes its full
/// brightness to the max at every pixel. This feature scales down the
/// contribution of frames near the start and/or end of the sequence
/// before that max is taken, so the trail tapers off rather than ending
/// abruptly. It changes only the blend *weighting*, never resolution,
/// bit depth, or which frames are decoded — consistent with this app's
/// no-quality-fallback policy.
enum StarTrailFadeMode {
  /// No fade. Every frame contributes at full weight (unchanged
  /// behavior).
  off,

  /// Fade both the first and last portion of the sequence.
  both,

  /// Fade only the first portion of the sequence (the trail's start).
  startOnly,

  /// Fade only the last portion of the sequence (the trail's end).
  endOnly,
}

/// The shape of the brightness ramp within the faded portion.
enum StarTrailFadeCurve {
  /// Constant-rate ramp from [StarTrailFadeSettings.minWeight] up to 1.0.
  linear,

  /// Smooth ease (slow-fast-slow, via a raised-cosine/"smoothstep" curve)
  /// between the same endpoints. Avoids the small kink a linear ramp
  /// leaves where it meets the unfaded portion of the trail.
  ease,
}

/// User-facing settings for [computeStarTrailFadeWeights].
final class StarTrailFadeSettings {
  const StarTrailFadeSettings({
    this.mode = StarTrailFadeMode.off,
    this.curve = StarTrailFadeCurve.ease,
    this.fadeLengthFraction = 0.1,
    this.minWeight = 0.0,
  })  : assert(fadeLengthFraction >= 0 && fadeLengthFraction <= 0.5),
        assert(minWeight >= 0 && minWeight <= 1);

  /// Which end(s) to fade. [StarTrailFadeMode.off] disables the feature
  /// entirely (every frame keeps weight 1.0).
  final StarTrailFadeMode mode;

  /// The shape of the ramp inside the faded portion.
  final StarTrailFadeCurve curve;

  /// How much of the sequence the fade spans at each faded end, as a
  /// fraction of the total frame count (0.0–0.5). `0.1` fades the first
  /// (and/or last) 10% of frames; the remaining frames keep full weight.
  final double fadeLengthFraction;

  /// The weight applied to the very first (or very last) frame of a
  /// faded end: `0.0` fades all the way to invisible, `1.0` disables the
  /// fade (every frame stays full-weight even though [mode] is not
  /// `off`). Values in between leave a dim, thin line rather than a hard
  /// cutoff.
  final double minWeight;

  StarTrailFadeSettings copyWith({
    StarTrailFadeMode? mode,
    StarTrailFadeCurve? curve,
    double? fadeLengthFraction,
    double? minWeight,
  }) {
    return StarTrailFadeSettings(
      mode: mode ?? this.mode,
      curve: curve ?? this.curve,
      fadeLengthFraction: fadeLengthFraction ?? this.fadeLengthFraction,
      minWeight: minWeight ?? this.minWeight,
    );
  }

  // Value equality so preview widgets (see
  // `star_trail_fade_preview_card.dart`) can cheaply detect "did the
  // fade settings actually change" without comparing every field
  // manually, e.g. to decide whether a cached composite needs redoing.
  @override
  bool operator ==(Object other) =>
      other is StarTrailFadeSettings &&
      other.mode == mode &&
      other.curve == curve &&
      other.fadeLengthFraction == fadeLengthFraction &&
      other.minWeight == minWeight;

  @override
  int get hashCode => Object.hash(mode, curve, fadeLengthFraction, minWeight);
}

/// Returns one multiplicative brightness weight per source frame (in the
/// same order as the star-trail's `sourcePaths`/`frameStores`), for use
/// as `TiledLightenBlendCombiner`'s `frameWeights`.
///
/// - `frameCount < 2` or [StarTrailFadeSettings.mode] ==
///   [StarTrailFadeMode.off]: returns all-`1.0` weights (no-op).
/// - Otherwise, frames within [StarTrailFadeSettings.fadeLengthFraction]
///   of whichever end(s) [StarTrailFadeSettings.mode] selects ramp from
///   [StarTrailFadeSettings.minWeight] (at the very first/last frame) up
///   to `1.0` (at the boundary of the faded portion); every other frame
///   stays at `1.0`.
List<double> computeStarTrailFadeWeights({
  required int frameCount,
  required StarTrailFadeSettings settings,
}) {
  if (frameCount <= 0) return const <double>[];
  final List<double> weights = List<double>.filled(frameCount, 1.0);
  if (settings.mode == StarTrailFadeMode.off || frameCount < 2) {
    return weights;
  }

  // At least one frame stays full-weight even at the maximum allowed
  // fadeLengthFraction (0.5), so a fade never eats the entire sequence.
  final int fadeFrames = math.min(
    frameCount - 1,
    (frameCount * settings.fadeLengthFraction).round(),
  );
  if (fadeFrames <= 0) return weights;

  double weightAt(int distanceFromEdge) {
    // distanceFromEdge: 0 at the very first/last frame of the faded
    // portion, fadeFrames at its inner boundary (already full weight).
    final double t = (distanceFromEdge / fadeFrames).clamp(0.0, 1.0);
    final double eased = settings.curve == StarTrailFadeCurve.ease
        ? t * t * (3 - 2 * t) // smoothstep
        : t;
    return settings.minWeight + (1.0 - settings.minWeight) * eased;
  }

  final bool fadeStart = settings.mode == StarTrailFadeMode.both ||
      settings.mode == StarTrailFadeMode.startOnly;
  final bool fadeEnd = settings.mode == StarTrailFadeMode.both ||
      settings.mode == StarTrailFadeMode.endOnly;

  if (fadeStart) {
    for (int i = 0; i < fadeFrames; i++) {
      weights[i] = math.min(weights[i], weightAt(i));
    }
  }
  if (fadeEnd) {
    for (int i = 0; i < fadeFrames; i++) {
      final int index = frameCount - 1 - i;
      weights[index] = math.min(weights[index], weightAt(i));
    }
  }
  return weights;
}
