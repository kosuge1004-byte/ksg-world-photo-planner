import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';

void main() {
  test('degree-2 local correction stays disabled below 24 support matches', () {
    final matches = <LocalResidualMatch>[
      for (int i = 0; i < 23; i++)
        LocalResidualMatch(
          referenceX: (i % 6) * 100.0,
          referenceY: (i ~/ 6) * 100.0,
          residualX: 0.2,
          residualY: -0.1,
        ),
    ];
    final field = fitLocalResidualCorrectionField(matches);
    expect(field.fitted, isFalse);
    final correction = field.evaluate(500, 500);
    expect(correction.dx, 0);
    expect(correction.dy, 0);
  });
}
