/// A minimal streak-shaped reference used by streak-analysis modules
/// that only need a candidate's line-segment geometry, not its full
/// detection metadata: [endpoints] (exactly two points tracing the
/// streak's visible extent) and [width] (its estimated cross-sectional
/// width, in pixels). Any type exposing these two getters — in
/// particular a future `StreakCandidate` from a ported `streak_
/// candidate_detector.dart` — can be passed directly to
/// `analyzeStreakBrightnessProfile` or `buildStreakMask`.
abstract interface class StreakShape {
  List<({double x, double y})> get endpoints;
  double get width;
}

/// [StreakShape] plus a streak's centroid and orientation, needed by
/// `streak_persistence_classifier.dart`'s cross-frame linking and
/// sky-motion-consistency checks. A future `StreakCandidate` (see
/// [StreakShape]'s doc comment) already carries all of these fields and
/// can implement this interface directly.
abstract interface class StreakGeometry implements StreakShape {
  double get centroidX;
  double get centroidY;
  double get angleRadians;
}
