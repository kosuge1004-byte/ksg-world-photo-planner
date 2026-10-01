import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/affine_sampling_transform.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';
import 'package:mobile_stack/core/registration/star_transform_estimator.dart';

/// Tests [buildLocalResidualMatches] directly: does it correctly compute
/// each match's own residual (actual target position minus what the
/// global transform predicts from the reference position alone)?

DetectedStar _star(double x, double y) {
  return DetectedStar(
    x: x,
    y: y,
    flux: 1,
    peakValue: 1,
    roundness: 0,
    sharpness: 0,
  );
}

void main() {
  test(
    '恒等変換(回転0・オフセット0)の場合、残差はtarget-reference'
    'そのものになる',
    () {
      final AffineSamplingTransform identity =
          AffineSamplingTransform.similarity(
        rotationDegrees: 0,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
        centerX: 0,
        centerY: 0,
      );
      final List<DetectedStar> referenceStars = <DetectedStar>[
        _star(10, 20),
        _star(30, 40),
      ];
      final List<DetectedStar> targetStars = <DetectedStar>[
        _star(10.5, 20.3), // residual = (0.5, 0.3)
        _star(29.2, 40.7), // residual = (-0.8, 0.7)
      ];
      final List<StarMatch> matches = <StarMatch>[
        const StarMatch(referenceIndex: 0, targetIndex: 0, distance: 0.5),
        const StarMatch(referenceIndex: 1, targetIndex: 1, distance: 0.5),
      ];

      final List<LocalResidualMatch> result = buildLocalResidualMatches(
        matches: matches,
        referenceStars: referenceStars,
        targetStars: targetStars,
        globalTransform: identity,
      );

      expect(result.length, 2);
      expect(result[0].referenceX, 10);
      expect(result[0].referenceY, 20);
      expect((result[0].residualX - 0.5).abs(), lessThan(1e-9));
      expect((result[0].residualY - 0.3).abs(), lessThan(1e-9));
      expect((result[1].residualX - (-0.8)).abs(), lessThan(1e-9));
      expect((result[1].residualY - 0.7).abs(), lessThan(1e-9));
    },
  );

  test(
    '90度回転+平行移動を含む変換でも、大域変換による予測位置からの'
    '残差が正しく計算される(手計算検証)',
    () {
      // rotationDegrees=90, sourceOffsetX=5, sourceOffsetY=3,
      // centerX=0, centerY=0の場合:
      // m00=0, m01=-1, m02=5, m10=1, m11=0, m12=3
      // reference=(2,1) -> predictedTarget=(-1*1+5, 1*2+3)=(4,5)
      final AffineSamplingTransform rotated =
          AffineSamplingTransform.similarity(
        rotationDegrees: 90,
        sourceOffsetX: 5,
        sourceOffsetY: 3,
        centerX: 0,
        centerY: 0,
      );
      final List<DetectedStar> referenceStars = <DetectedStar>[_star(2, 1)];
      final List<DetectedStar> targetStars = <DetectedStar>[
        _star(4.5, 5.2), // predicted=(4,5) -> residual=(0.5, 0.2)
      ];
      final List<StarMatch> matches = <StarMatch>[
        const StarMatch(referenceIndex: 0, targetIndex: 0, distance: 0.5),
      ];

      final List<LocalResidualMatch> result = buildLocalResidualMatches(
        matches: matches,
        referenceStars: referenceStars,
        targetStars: targetStars,
        globalTransform: rotated,
      );

      expect(result.length, 1);
      expect((result[0].residualX - 0.5).abs(), lessThan(1e-9));
      expect((result[0].residualY - 0.2).abs(), lessThan(1e-9));
    },
  );
}
