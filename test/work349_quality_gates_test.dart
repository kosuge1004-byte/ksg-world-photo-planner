import 'dart:math' as math;
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/registration_hard_quality.dart';
import 'package:mobile_stack/core/registration/flat_sky_noise_quality.dart';
import 'package:mobile_stack/core/registration/star_psf_quality.dart';
import 'package:mobile_stack/core/registration/star_detector.dart';
import 'package:mobile_stack/core/registration/local_residual_correction.dart';
import 'support/in_memory_rgb_tile_store.dart';

DetectedStar star(double x, double y, {double? fwhm = 2}) => DetectedStar(
    x: x,
    y: y,
    flux: 100,
    peakValue: 10,
    roundness: 0.05,
    sharpness: 0.5,
    psfFwhmPx: fwhm);
LocalResidualStatistics residual(double rms,
        {double p95 = .4, double max = .5, int count = 10}) =>
    LocalResidualStatistics(
        count: count,
        rms: rms,
        meanMagnitude: rms,
        medianMagnitude: rms,
        p90Magnitude: p95,
        p95Magnitude: p95,
        maxMagnitude: max,
        meanDx: 0,
        meanDy: 0,
        meanVectorMagnitude: 0,
        directionalCoherence: 0);
RegistrationHardQualityGateResult gate(LocalResidualStatistics stats,
        {bool psf = true}) =>
    evaluateRegistrationHardQualityGate(
        residuals: stats,
        referenceStars: [
          for (int i = 0; i < 6; i++) star(i * 20, 50, fwhm: psf ? 2 : null)
        ],
        transformToleranceRadius: 3);
InMemoryRgbTileStore scene(
    {double scale = 1, bool invalid = false, double gradient = 0}) {
  final random = math.Random(349);
  final samples = Float32List(288 * 288 * 3);
  for (int i = 0; i < 288 * 288; i++) {
    final double noise =
        random.nextDouble() + random.nextDouble() + random.nextDouble() - 1.5;
    final value = invalid
        ? double.nan
        : .2 + gradient * ((i % 288) + (i ~/ 288)) + scale * .02 * noise;
    for (int c = 0; c < 3; c++) {
      samples[i * 3 + c] = value;
    }
  }
  return InMemoryRgbTileStore(width: 288, height: 288, interleavedRgb: samples);
}

final anchors = [
  for (int y = 0; y < 3; y++)
    for (int x = 0; x < 3; x++) star(x * 96 + 40, y * 96 + 40)
];
Future<FlatSkyNoiseQualityComparison> compare(
        InMemoryRgbTileStore reference, InMemoryRgbTileStore finalStore) =>
    compareFlatSkyNoise(
        referenceStore: reference,
        finalStore: finalStore,
        referenceStars: anchors);

void main() {
  test('PSF-derived radial budget excludes a frame before combination', () {
    expect(
        registrationRmsFractionForFwhmRatio(1.12), closeTo(.3029115458, 1e-9));
    expect(gate(residual(.5)).passed, isTrue);
    expect(gate(residual(.7)).passed, isFalse);
    expect(gate(residual(.5)).rmsLimitPx, closeTo(2 * .3029115458, 1e-9));
  });
  test('tail and empty residuals cannot pass a good RMS', () {
    expect(gate(residual(.1, p95: 2)).passed, isFalse);
    expect(gate(residual(.1, max: 4)).passed, isFalse);
    expect(gate(residual(0, count: 0)).passed, isFalse);
  });
  test('non-finite registration residuals fail closed', () {
    expect(gate(residual(double.nan)).passed, isFalse);
    expect(gate(residual(.1, p95: double.nan)).passed, isFalse);
    expect(gate(residual(.1, max: double.infinity)).passed, isFalse);
  });
  test('missing PSF widths use the established matching budget', () {
    expect(gate(residual(1), psf: false).passed, isTrue);
    expect(gate(residual(1), psf: false).rmsLimitPx, 1.5);
    expect(gate(residual(1), psf: false).usedPsfDerivedRmsLimit, isFalse);
  });
  test('invalid PSF result cannot declare success', () {
    final result = evaluateStarPsfQualityGate(
        comparison: const StarPsfQualityComparison(
            referenceStarCount: 10,
            finalStarCount: 10,
            referenceMeasuredStarCount: 10,
            finalMeasuredStarCount: 10,
            positionMatchedCount: 10,
            measuredPairCount: 10,
            medianFwhmRatio: double.nan,
            p90FwhmRatio: 1,
            medianRoundnessDelta: 0));
    expect(result.passed, isFalse);
  });
  test('same scene on the same grid has unit noise ratio', () async {
    final r = scene();
    final f = scene();
    final result = await compare(r, f);
    expect(result.selectedTileCount, 8);
    expect(result.noiseRatio, closeTo(1, 1e-6));
    expect(evaluateFlatSkyNoiseQualityGate(comparison: result).passed, isTrue);
    final coords = r.readRequests.map((q) => '${q.x},${q.y}').toSet();
    expect(
        f.readRequests.every((q) => coords.contains('${q.x},${q.y}')), isTrue);
  });
  test('reduced noise passes and amplified noise fails', () async {
    final lower = await compare(scene(), scene(scale: .5));
    expect(lower.noiseRatio, closeTo(.5, 1e-4));
    expect(evaluateFlatSkyNoiseQualityGate(comparison: lower).passed, isTrue);
    final higher = await compare(scene(), scene(scale: 1.5));
    expect(higher.noiseRatio, closeTo(1.5, 1e-4));
    expect(evaluateFlatSkyNoiseQualityGate(comparison: higher).passed, isFalse);
  });
  test('a planar gradient does not masquerade as random noise', () async {
    final result =
        await compare(scene(gradient: .001), scene(gradient: .001, scale: .5));
    expect(result.noiseRatio, closeTo(.5, 1e-4));
  });
  test('zero final sigma is measured rather than silently unverified',
      () async {
    final result = await compare(scene(), scene(scale: 0));
    final verdict = evaluateFlatSkyNoiseQualityGate(comparison: result);
    expect(result.noiseRatio, 0);
    expect(verdict.hasEnoughMeasurements, isTrue);
    expect(
        verdict.passed, isTrue); // PSF must independently protect against blur.
  });
  test('losing all final samples fails when reference support existed',
      () async {
    final result = await compare(scene(), scene(invalid: true));
    expect(result.referenceSupportedTileCount, 8);
    expect(evaluateFlatSkyNoiseQualityGate(comparison: result).passed, isFalse);
  });
  test('a genuinely star-poor reference stays unverified', () async {
    final result = await compareFlatSkyNoise(
        referenceStore: scene(), finalStore: scene(), referenceStars: []);
    final verdict = evaluateFlatSkyNoiseQualityGate(comparison: result);
    expect(verdict.hasEnoughMeasurements, isFalse);
    expect(verdict.passed, isTrue);
  });
  test('invalid FWHM budget is rejected even without PSF widths', () {
    expect(
        () => evaluateRegistrationHardQualityGate(
            residuals: residual(.1),
            referenceStars: [],
            transformToleranceRadius: 3,
            maximumFinalMedianFwhmRatio: double.nan),
        throwsArgumentError);
  });
  test('supported noise measurements with a non-finite ratio fail closed', () {
    final result = evaluateFlatSkyNoiseQualityGate(
        comparison: const FlatSkyNoiseQualityComparison(
      candidateTileCount: 3,
      selectedTileCount: 3,
      sampledCoefficientCount: 2048,
      referenceSigma: 1,
      finalSigma: 1,
      noiseRatio: double.nan,
    ));
    expect(result.passed, isFalse);
    expect(result.reasons, contains('invalid flat-sky noise measurements'));
  });
}
