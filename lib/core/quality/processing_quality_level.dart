import '../registration/tiled_affine_rgb_resampler.dart';

/// User-facing processing budget. Level 5 preserves the historical production
/// path; lower levels make only the documented quality/time trade-offs.
enum ProcessingQualityLevel {
  fastest(1, '1 最速', '約20%時間・縦横50%', 0.50, 1, false, false,
      ResamplingInterpolation.bilinear),
  light(2, '2 軽量', '約40%時間・縦横75%', 0.75, 1, false, true,
      ResamplingInterpolation.bilinear),
  standard(3, '3 標準', '約60%時間・フル解像度', 1.0, 2, false, true,
      ResamplingInterpolation.bicubic),
  high(4, '4 高画質', '約80%時間・フル解像度', 1.0, 2, true, true,
      ResamplingInterpolation.bicubic),
  maximum(5, '5 最高画質', '従来品質・フル解像度', 1.0, 3, true, true,
      ResamplingInterpolation.bicubic);

  const ProcessingQualityLevel(
    this.level,
    this.label,
    this.detail,
    this.linearScale,
    this.maximumIterations,
    this.enableLocalRegistration,
    this.preserveStaticForeground,
    this.interpolation,
  );

  final int level;
  final String label;
  final String detail;
  final double linearScale;
  final int maximumIterations;
  final bool enableLocalRegistration;
  final bool preserveStaticForeground;
  final ResamplingInterpolation interpolation;

  /// Bounds peak working memory without changing any numerical quality
  /// setting. Maximum quality keeps more simultaneous rejection histories,
  /// so it uses a smaller output tile.
  int get processingTileSize {
    if (this == ProcessingQualityLevel.maximum) return 128;
    return 256;
  }

  int scaledDimension(int source) =>
      (source * linearScale).round().clamp(1, source);
}
