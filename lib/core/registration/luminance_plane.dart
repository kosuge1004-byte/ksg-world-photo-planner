import 'dart:typed_data';

import '../meteor/streak_brightness_profile.dart' show StreakBrightnessSource;
import '../meteor/streak_candidate_detector.dart' show StreakDetectionSource;

/// A single-channel intensity plane, such as a luminance proxy or a green
/// channel extracted from a demosaiced or partially stacked tile.
///
/// This is distinct from [LinearRawMosaic] (Bayer-patterned RAW samples)
/// and [LinearRgbTile] (interleaved 3-channel RGB); star detection and
/// registration operate on one plain scalar plane at a time.
///
/// Implements [StreakDetectionSource] and [StreakBrightnessSource]
/// (Work59/60) so a [LuminancePlane] already built for star detection
/// can be passed directly to `detectStreakCandidates` and
/// `analyzeStreakBrightnessProfile` too — all three detectors need
/// exactly the same `{width, height, samples}` shape, and `meteor_
/// pipeline.dart` runs all three on the same per-frame green-channel
/// plane, so sharing one type avoids building three structurally-
/// identical planes per frame.
class LuminancePlane implements StreakDetectionSource, StreakBrightnessSource {
  LuminancePlane({
    required this.width,
    required this.height,
    required Float32List samples,
  }) : samples = samples {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Plane dimensions must be positive.');
    }
    if (samples.length != width * height) {
      throw ArgumentError('Plane sample count does not match dimensions.');
    }
  }

  @override
  final int width;
  @override
  final int height;
  @override
  final Float32List samples;

  double sampleAt(int x, int y) => samples[y * width + x];
}
