import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/stacking/registration_quality_weight.dart';

/// Dart port of `tool/raw_samples/test/registration_quality_weight_
/// reference.test.mjs`.

void main() {
  test('a perfect fit (rmsResidual=0) gets the maximum weight of 1', () {
    expect(registrationQualityWeight(0), 1);
  });

  test(
    'a fit exactly at residualHalfWeightRadius gets exactly half weight',
    () {
      expect(
        (registrationQualityWeight(1.5) - 0.5).abs(),
        lessThan(1e-9),
      );
      expect(
        (registrationQualityWeight(2.0, residualHalfWeightRadius: 2.0) - 0.5)
            .abs(),
        lessThan(1e-9),
      );
    },
  );

  test('weight decreases monotonically as rmsResidual increases', () {
    double previous = double.infinity;
    for (double residual = 0; residual <= 20; residual += 0.25) {
      final double weight = registrationQualityWeight(residual);
      expect(
        weight,
        lessThanOrEqualTo(previous),
        reason: 'weight increased at residual=$residual: $weight > '
            '$previous',
      );
      previous = weight;
    }
  });

  test(
    'weight never drops below minimumWeight, even for a huge residual',
    () {
      final double weight = registrationQualityWeight(
        1000,
        minimumWeight: 0.05,
      );
      expect(weight, 0.05);
    },
  );

  test('a smaller minimumWeight allows the falloff to continue further', () {
    final double withFloor = registrationQualityWeight(
      50,
      minimumWeight: 0.05,
    );
    final double withoutFloor = registrationQualityWeight(
      50,
      minimumWeight: 0,
    );
    expect(withoutFloor, lessThan(withFloor));
    expect(withoutFloor, greaterThan(0));
  });

  test(
    'a larger residualHalfWeightRadius is more forgiving of a given '
    'residual',
    () {
      final double strict = registrationQualityWeight(
        2,
        residualHalfWeightRadius: 1.5,
      );
      final double lenient = registrationQualityWeight(
        2,
        residualHalfWeightRadius: 5,
      );
      expect(lenient, greaterThan(strict));
    },
  );

  test('weight is always in (0, 1]', () {
    for (final double residual in <double>[0, 0.001, 0.5, 1.5, 3, 10, 1e6]) {
      final double weight = registrationQualityWeight(residual);
      expect(weight, greaterThan(0));
      expect(weight, lessThanOrEqualTo(1));
    }
  });

  test('rejects a negative rmsResidual', () {
    expect(
      () => registrationQualityWeight(-0.1),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
  });

  test('rejects a non-finite rmsResidual', () {
    expect(
      () => registrationQualityWeight(double.nan),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
    expect(
      () => registrationQualityWeight(double.infinity),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
  });

  test('rejects a non-positive residualHalfWeightRadius', () {
    expect(
      () => registrationQualityWeight(1, residualHalfWeightRadius: 0),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
    expect(
      () => registrationQualityWeight(1, residualHalfWeightRadius: -1),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
  });

  test('rejects a minimumWeight outside [0, 1]', () {
    expect(
      () => registrationQualityWeight(1, minimumWeight: -0.1),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
    expect(
      () => registrationQualityWeight(1, minimumWeight: 1.1),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
  });
  test('無限大half-weight radiusを拒否する', () {
    expect(
      () => registrationQualityWeight(
        1,
        residualHalfWeightRadius: double.infinity,
      ),
      throwsA(isA<InvalidRegistrationWeightInput>()),
    );
  });
}
