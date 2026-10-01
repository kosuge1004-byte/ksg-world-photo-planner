import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/gaussian_psf_centroid_refinement.dart';
import 'package:mobile_stack/core/registration/luminance_plane.dart';

/// Dart port of `tool/raw_samples/test/gaussian_psf_centroid_
/// refinement_reference.test.mjs`.

double _gaussianValue(double x, double center, double sigma) {
  return math.exp(-((x - center) * (x - center)) / (2 * sigma * sigma));
}

void main() {
  test(
    '真のガウシアンプロファイルに対し、3点対数放物線フィットが正確な'
    'sub-pixel位置を復元する(手計算検証: sigma=1.5, x0=2.3)',
    () {
      const double trueCenter = 2.3;
      const double sigma = 1.5;
      final List<double> profile = <int>[0, 1, 2, 3, 4]
          .map((int x) => _gaussianValue(x.toDouble(), trueCenter, sigma))
          .toList();
      final double refined = refineAxisWithGaussianMarginalFit(
        profile,
        0,
        2,
      );
      expect((refined - trueCenter).abs(), lessThan(1e-3));
    },
  );

  test('プロファイルが完全に対称なら、精緻化後もピーク位置は変わらない', () {
    const double sigma = 1.2;
    final List<double> profile = <int>[0, 1, 2, 3, 4]
        .map((int x) => _gaussianValue(x.toDouble(), 2, sigma))
        .toList();
    final double refined = refineAxisWithGaussianMarginalFit(profile, 0, 2);
    expect((refined - 2).abs(), lessThan(1e-9));
  });

  test(
    '中心候補がプロファイルの端(両隣を参照できない)場合は、初期位置を'
    'そのまま返す',
    () {
      final List<double> profile = <double>[5, 4, 3];
      expect(refineAxisWithGaussianMarginalFit(profile, 0, 0), 0);
      expect(refineAxisWithGaussianMarginalFit(profile, 0, 2), 2);
    },
  );

  test('隣接点に0以下の値がある場合は、初期位置をそのまま返す', () {
    final List<double> profile = <double>[5, 10, 0, 8, 5];
    expect(refineAxisWithGaussianMarginalFit(profile, 0, 2), 2);
  });

  test(
    '3点が実際にはピークを描いていない(単調増加等)場合は、初期位置を'
    'そのまま返す',
    () {
      final List<double> profile = <double>[1, 2, 3, 4, 5];
      expect(refineAxisWithGaussianMarginalFit(profile, 0, 2), 2);
    },
  );

  test('profileの要素数が3未満だとInvalidPsfRefinementInputを投げる', () {
    expect(
      () => refineAxisWithGaussianMarginalFit(<double>[1, 2], 0, 0),
      throwsA(isA<InvalidPsfRefinementInput>()),
    );
  });

  test(
    'refineCentroidWithGaussianPsfFit: x・y独立に、2次元的に分離可能な'
    'ガウシアンPSFに対して正確な位置を復元する',
    () {
      const int width = 9;
      const int height = 9;
      const double trueX = 4.3;
      const double trueY = 4.6;
      const double sigma = 1.4;
      const double backgroundMedian = 10;
      final Float32List samples = Float32List(width * height);
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final double value = 100 *
              _gaussianValue(x.toDouble(), trueX, sigma) *
              _gaussianValue(y.toDouble(), trueY, sigma);
          samples[y * width + x] = backgroundMedian + value;
        }
      }
      final LuminancePlane source = LuminancePlane(
        width: width,
        height: height,
        samples: samples,
      );
      final RefinedCentroid refined = refineCentroidWithGaussianPsfFit(
        source: source,
        peakX: 4,
        peakY: 5,
        initialX: 4,
        initialY: 5,
        backgroundMedian: backgroundMedian,
        windowRadius: 3,
      );
      expect((refined.x - trueX).abs(), lessThan(1e-2));
      expect((refined.y - trueY).abs(), lessThan(1e-2));
      expect(refined.sigmaX, isNotNull);
      expect(refined.sigmaY, isNotNull);
      expect((refined.sigmaX! - sigma).abs(), lessThan(2e-2));
      expect((refined.sigmaY! - sigma).abs(), lessThan(2e-2));
    },
  );

  test(
    'windowRadiusが正の整数でない場合はInvalidPsfRefinementInputを'
    '投げる',
    () {
      final LuminancePlane source = LuminancePlane(
        width: 3,
        height: 3,
        samples: Float32List(9),
      );
      expect(
        () => refineCentroidWithGaussianPsfFit(
          source: source,
          peakX: 1,
          peakY: 1,
          initialX: 1,
          initialY: 1,
          backgroundMedian: 0,
          windowRadius: 0,
        ),
        throwsA(isA<InvalidPsfRefinementInput>()),
      );
    },
  );
  test('PSF精緻化は非有限輝度・重心入力を拒否する', () {
    final LuminancePlane source = LuminancePlane(
      width: 5,
      height: 5,
      samples: Float32List(25)..fillRange(0, 25, 1),
    );
    source.samples[12] = double.nan;
    expect(
      () => refineCentroidWithGaussianPsfFit(
        source: source,
        peakX: 2,
        peakY: 2,
        initialX: 2,
        initialY: 2,
        backgroundMedian: 0,
        windowRadius: 2,
      ),
      throwsA(isA<InvalidPsfRefinementInput>()),
    );
  });

  test('PSF精緻化は画像外peak座標を拒否する', () {
    final LuminancePlane source = LuminancePlane(
      width: 5,
      height: 5,
      samples: Float32List(25)..fillRange(0, 25, 1),
    );
    expect(
      () => refineCentroidWithGaussianPsfFit(
        source: source,
        peakX: 5,
        peakY: 2,
        initialX: 4,
        initialY: 2,
        backgroundMedian: 0,
        windowRadius: 2,
      ),
      throwsA(isA<InvalidPsfRefinementInput>()),
    );
  });

  test(
      'PSF fit anchor can remain on the detected local maximum when the intensity centroid is displaced',
      () {
    // A contaminated/asymmetric marginal profile can pull the ordinary
    // intensity centroid toward x=3 even though the detected stellar local
    // maximum is x=1.  Work255 must fit the log-parabola around the actual
    // detected peak rather than centroid.round().
    const List<double> profile = <double>[2.0, 10.0, 7.0, 8.0, 3.0];
    const double displacedCentroid = 2.6;
    final double unanchored = refineAxisWithGaussianMarginalFit(
      profile,
      0,
      displacedCentroid,
    );
    final double anchored = refineAxisWithGaussianMarginalFit(
      profile,
      0,
      displacedCentroid,
      anchorPosition: 1,
    );

    // Unanchored fitting around round(2.6)=3 follows the contaminating wing.
    expect(unanchored, greaterThan(2.0));
    // Anchored fitting remains around the actual local maximum at x=1.
    expect(anchored, inInclusiveRange(0.5, 1.5));
  });
}
