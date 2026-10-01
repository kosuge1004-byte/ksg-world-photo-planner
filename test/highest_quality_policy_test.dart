import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/quality/highest_quality_policy.dart';
import 'package:mobile_stack/core/quality/processing_precision.dart';

void main() {
  test('スタック累積だけFP64を要求する', () {
    const HighestQualityPolicy policy = HighestQualityPolicy();
    expect(
        policy.precisionFor('stack_accumulation'), ProcessingPrecision.float64);
    expect(policy.precisionFor('demosaic'), ProcessingPrecision.float32);
    expect(
      policy.precisionFor('camera_white_balance'),
      ProcessingPrecision.float32,
    );
    expect(
      policy.precisionFor('defect_pixel'),
      ProcessingPrecision.float32,
    );
  });

  test('自動品質低下を許可しない', () {
    const HighestQualityPolicy policy = HighestQualityPolicy();
    expect(policy.allowFp16Fallback, isFalse);
    expect(policy.allowApproximateMath, isFalse);
    expect(policy.allowAutomaticResolutionReduction, isFalse);
  });
}
