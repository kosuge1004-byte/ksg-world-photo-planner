import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';
import 'package:mobile_stack/core/registration/star_psf_quality.dart';

DetectedStar _star(
  double x,
  double y, {
  double fwhm = 2,
  double roundness = 0.05,
}) =>
    DetectedStar(
      x: x,
      y: y,
      flux: 100,
      peakValue: 10,
      roundness: roundness,
      sharpness: 0.5,
      psfFwhmPx: fwhm,
    );

void main() {
  test('same registered stars produce unit FWHM ratio and pass', () {
    final List<DetectedStar> reference = <DetectedStar>[
      for (int i = 0; i < 10; i++) _star(i * 20.0, 10),
    ];
    final List<DetectedStar> finalStars = <DetectedStar>[
      for (int i = 0; i < 10; i++) _star(i * 20.0 + 0.1, 10.1),
    ];
    final comparison = compareRegisteredStarPsf(
      referenceStars: reference,
      finalStars: finalStars,
    );
    expect(comparison.measuredPairCount, 10);
    expect((comparison.medianFwhmRatio! - 1).abs(), lessThan(1e-9));
    expect(evaluateStarPsfQualityGate(comparison: comparison).passed, isTrue);
  });

  test('systematic star broadening is rejected', () {
    final List<DetectedStar> reference = <DetectedStar>[
      for (int i = 0; i < 10; i++) _star(i * 20.0, 10, fwhm: 2),
    ];
    final List<DetectedStar> finalStars = <DetectedStar>[
      for (int i = 0; i < 10; i++)
        _star(i * 20.0, 10, fwhm: 2.5),
    ];
    final result = evaluateStarPsfQualityGate(
      comparison: compareRegisteredStarPsf(
        referenceStars: reference,
        finalStars: finalStars,
      ),
    );
    expect(result.passed, isFalse);
    expect(result.reasons.join(' '), contains('median FWHM ratio'));
  });

  test('lost measurable stars fail closed when reference had enough', () {
    final List<DetectedStar> reference = <DetectedStar>[
      for (int i = 0; i < 10; i++) _star(i * 20.0, 10),
    ];
    final List<DetectedStar> finalStars = <DetectedStar>[
      for (int i = 0; i < 3; i++) _star(i * 20.0, 10),
    ];
    final result = evaluateStarPsfQualityGate(
      comparison: compareRegisteredStarPsf(
        referenceStars: reference,
        finalStars: finalStars,
      ),
    );
    expect(result.hasEnoughMeasurements, isFalse);
    expect(result.passed, isFalse);
  });

  test('insufficient reference measurements remain unverified rather than false-failing', () {
    final List<DetectedStar> reference = <DetectedStar>[
      for (int i = 0; i < 4; i++) _star(i * 20.0, 10),
    ];
    final List<DetectedStar> finalStars = <DetectedStar>[
      for (int i = 0; i < 4; i++) _star(i * 20.0, 10),
    ];
    final result = evaluateStarPsfQualityGate(
      comparison: compareRegisteredStarPsf(
        referenceStars: reference,
        finalStars: finalStars,
      ),
    );
    expect(result.hasEnoughMeasurements, isFalse);
    expect(result.passed, isTrue);
  });
}
