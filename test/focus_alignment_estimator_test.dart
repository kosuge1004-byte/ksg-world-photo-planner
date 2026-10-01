import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/focus_stack/focus_alignment_estimator.dart';

void main() {
  test('zero MAD majority does not admit symmetric gross outliers', () {
    final matches = <FocusAlignmentMatch>[
      for (int i = 0; i < 8; i++)
        FocusAlignmentMatch(
            referenceX: i.isEven ? 10 : -10,
            referenceY: 0,
            sourceX: i.isEven ? 10 : -10,
            sourceY: 0),
      const FocusAlignmentMatch(
          referenceX: 10, referenceY: 0, sourceX: 10, sourceY: 0),
      const FocusAlignmentMatch(
          referenceX: -10, referenceY: 0, sourceX: -10, sourceY: 0),
      const FocusAlignmentMatch(
          referenceX: 0, referenceY: 0, sourceX: 1000, sourceY: 0),
      const FocusAlignmentMatch(
          referenceX: 0, referenceY: 0, sourceX: -1000, sourceY: 0),
    ];
    final estimate = estimateFocusAlignment(matches);
    expect(estimate.inlierCount, 10);
    expect(estimate.scale, closeTo(1, 1e-12));
    expect(estimate.rmsResidual, lessThan(1e-12));
  });
  test('recovers scale rotation and translation', () {
    const double scale = 1.02;
    const double angle = 0.015;
    const double tx = 4.0;
    const double ty = -3.0;
    final double c = math.cos(angle);
    final double s = math.sin(angle);
    const points = <(double, double)>[
      (0, 0),
      (100, 0),
      (0, 100),
      (100, 100),
      (50, 30),
    ];
    final matches = <FocusAlignmentMatch>[
      for (final p in points)
        FocusAlignmentMatch(
          referenceX: p.$1,
          referenceY: p.$2,
          sourceX: scale * (c * p.$1 - s * p.$2) + tx,
          sourceY: scale * (s * p.$1 + c * p.$2) + ty,
        ),
    ];
    final estimate = estimateFocusAlignment(matches);
    expect(estimate.scale, closeTo(scale, 1e-10));
    expect(estimate.rotationDegrees, closeTo(angle * 180 / math.pi, 1e-9));
    expect(estimate.rmsResidual, lessThan(1e-9));
  });
}
