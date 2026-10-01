import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/tiled_affine_rgb_resampler.dart';
import 'package:mobile_stack/core/stacking/tiled_registered_rgb_stacker.dart';

void main() {
  test('registered stacker defaults to bicubic for quality-first resampling',
      () {
    const TiledRegisteredRgbStacker stacker = TiledRegisteredRgbStacker();
    expect(stacker.resampler.interpolation, ResamplingInterpolation.bicubic);
  });

  test('low-level resampler retains explicit bilinear compatibility default',
      () {
    const TiledAffineRgbResampler resampler = TiledAffineRgbResampler();
    expect(resampler.interpolation, ResamplingInterpolation.bilinear);
  });
}
