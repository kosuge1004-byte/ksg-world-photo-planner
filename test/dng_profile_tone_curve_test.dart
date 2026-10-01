import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/dng_profile_tone_curve.dart';

void main() {
  test('matches Adobe DNG natural cubic spline reference values', () {
    final DngProfileToneCurve curve = DngProfileToneCurve.fromInterleaved(
      const <double>[0, 0, 0.5, 0.25, 1, 1],
    );
    expect(curve.evaluate(0), 0);
    expect(curve.evaluate(0.25), closeTo(0.078125, 1e-12));
    expect(curve.evaluate(0.5), 0.25);
    expect(curve.evaluate(0.75), closeTo(0.578125, 1e-12));
    expect(curve.evaluate(1), 1);
  });

  test('identity and DNG final-slope extension are exact', () {
    final DngProfileToneCurve curve = DngProfileToneCurve.fromInterleaved(
      const <double>[0, 0, 1, 1],
    );
    expect(curve.isIdentity, isTrue);
    expect(curve.evaluate(-10), 0);
    expect(curve.evaluate(0.4), closeTo(0.4, 1e-12));
    expect(curve.evaluate(10), 10);
  });

  test('HDR identity curve preserves DNG overrange values', () {
    final DngProfileToneCurve curve = DngProfileToneCurve.fromInterleaved(
      const <double>[0, 0, 1, 1],
      isHighDynamicRange: true,
    );
    expect(curve.isHighDynamicRange, isTrue);
    for (final double value in <double>[0.25, 1, 2, 4, 8, 16]) {
      expect(curve.evaluate(value), closeTo(value, 1e-9));
    }
  });

  test('extends a non-identity curve using the solved final tangent', () {
    final DngProfileToneCurve curve = DngProfileToneCurve.fromInterleaved(
      const <double>[0, 0, 0.5, 0.25, 1, 1],
    );
    // The Adobe-compatible spline solver gives a final slope of 1.75 for
    // these knots, so DNG overrange handling must continue that tangent.
    expect(curve.evaluate(1.25), closeTo(1.4375, 1e-12));
  });

  test('enforces DNG SDR/HDR endpoint contracts', () {
    expect(
      () => DngProfileToneCurve.fromInterleaved(
        const <double>[0, 0.1, 1, 1],
      ),
      throwsArgumentError,
    );
    expect(
      () => DngProfileToneCurve.fromInterleaved(
        const <double>[0, 0, 0.8, 0.7],
      ),
      throwsArgumentError,
    );

    final DngProfileToneCurve hdr = DngProfileToneCurve.fromInterleaved(
      const <double>[0, 0, 0.8, 0.7],
      isHighDynamicRange: true,
    );
    expect(hdr.isHighDynamicRange, isTrue);
    expect(hdr.evaluate(0), 0);
  });

  test('rejects malformed point lists before solving', () {
    for (final List<double> curve in <List<double>>[
      <double>[0, 0, 1],
      <double>[0, 0, 0, 1],
      <double>[0, 0, 1, 1.1],
      <double>[0, 0, double.nan, 1],
    ]) {
      expect(
        () => DngProfileToneCurve.fromInterleaved(curve),
        throwsArgumentError,
      );
    }
  });
}
