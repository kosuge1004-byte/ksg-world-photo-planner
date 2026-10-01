import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';

void main() {
  test('summarizeLocalResiduals exposes RMS, tail and direction', () {
    const List<LocalResidualMatch> matches = <LocalResidualMatch>[
      LocalResidualMatch(
        referenceX: 0,
        referenceY: 0,
        residualX: 1,
        residualY: 0,
      ),
      LocalResidualMatch(
        referenceX: 10,
        referenceY: 0,
        residualX: 1,
        residualY: 0,
      ),
      LocalResidualMatch(
        referenceX: 0,
        referenceY: 10,
        residualX: 1,
        residualY: 0,
      ),
    ];
    final statistics = summarizeLocalResiduals(matches, null);
    expect(statistics.rms, closeTo(1, 1e-12));
    expect(statistics.p95Magnitude, closeTo(1, 1e-12));
    expect(statistics.maxMagnitude, closeTo(1, 1e-12));
    expect(statistics.directionalCoherence, closeTo(1, 1e-12));
  });

  test('distribution safety rejects lower RMS when tail gets worse', () {
    const global = LocalResidualStatistics(
      count: 10,
      rms: 0.8,
      meanMagnitude: 0.7,
      medianMagnitude: 0.7,
      p90Magnitude: 1.0,
      p95Magnitude: 1.1,
      maxMagnitude: 1.2,
      meanDx: 0,
      meanDy: 0,
      meanVectorMagnitude: 0,
      directionalCoherence: 0,
    );
    const corrected = LocalResidualStatistics(
      count: 10,
      rms: 0.7,
      meanMagnitude: 0.6,
      medianMagnitude: 0.5,
      p90Magnitude: 1.0,
      p95Magnitude: 1.3,
      maxMagnitude: 1.4,
      meanDx: 0,
      meanDy: 0,
      meanVectorMagnitude: 0,
      directionalCoherence: 0,
    );
    expect(
      localResidualCorrectionIsDistributionSafe(
        globalStatistics: global,
        correctedStatistics: corrected,
      ),
      isFalse,
    );
  });
}
