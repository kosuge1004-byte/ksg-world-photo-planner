/// A minimal point-like star reference used by both star detection and
/// transform estimation: only [x] and [y] are required, so any type
/// exposing these two getters (in particular `DetectedStar`) can be
/// passed directly to `estimateSimilarityTransform`.
abstract interface class StarPoint {
  double get x;
  double get y;
}
