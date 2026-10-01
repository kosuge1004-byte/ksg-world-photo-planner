import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/quality/processing_quality_level.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';

void main() {
  test('画質段階が単調に処理画素数を減らす', () {
    expect(ProcessingQualityLevel.maximum.scaledDimension(6000), 6000);
    expect(ProcessingQualityLevel.high.scaledDimension(6000), 6000);
    expect(ProcessingQualityLevel.standard.scaledDimension(6000), 6000);
    expect(ProcessingQualityLevel.light.scaledDimension(6000), 4500);
    expect(ProcessingQualityLevel.fastest.scaledDimension(6000), 3000);
  });

  test('最高画質は演算品質を維持したままメモリ制限タイルを使う', () {
    expect(ProcessingQualityLevel.maximum.processingTileSize, 128);
    expect(ProcessingQualityLevel.maximum.linearScale, 1.0);
    expect(ProcessingQualityLevel.maximum.maximumIterations, 3);
    expect(ProcessingQualityLevel.maximum.enableLocalRegistration, isTrue);
    expect(
      ProcessingQualityLevel.maximum.interpolation,
      ResamplingInterpolation.bicubic,
    );
  });
}
