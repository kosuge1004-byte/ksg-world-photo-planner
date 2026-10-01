import 'processing_precision.dart';

class HighestQualityPolicy {
  const HighestQualityPolicy();

  ProcessingPrecision precisionFor(String stageId) {
    return switch (stageId) {
      'raw_read' => ProcessingPrecision.sourceInteger,
      'black_level' ||
      'white_level' ||
      'camera_white_balance' ||
      'defect_pixel' ||
      'demosaic' ||
      'registration' ||
      'noise_reduction' ||
      'final_linear_image' =>
        ProcessingPrecision.float32,
      'stack_accumulation' => ProcessingPrecision.float64,
      _ => ProcessingPrecision.float32,
    };
  }

  bool get allowFp16Fallback => false;
  bool get allowApproximateMath => false;
  bool get allowAutomaticResolutionReduction => false;
  bool get preferGpuOnlyWhenFp32Guaranteed => true;
}
