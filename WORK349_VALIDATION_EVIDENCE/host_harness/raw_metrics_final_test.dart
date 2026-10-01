import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/registration/flat_sky_noise_quality.dart';
import 'package:mobile_stack/core/registration/star_psf_quality.dart';

void main() {
  test('final quality guards accept the actual full-resolution RAW metrics', () async {
    final receipt = jsonDecode(await File(Platform.environment['MOBILE_STACK_RAW_RESULTS']!).readAsString()) as Map;
    final noise = receipt['noise'] as Map;
    final psf = receipt['psf'] as Map;
    final noiseVerdict = evaluateFlatSkyNoiseQualityGate(comparison: FlatSkyNoiseQualityComparison(
        candidateTileCount: noise['selectedTiles'] as int,
        selectedTileCount: noise['selectedTiles'] as int,
        sampledCoefficientCount: noise['coefficients'] as int,
        referenceSigma: (noise['referenceSigma'] as num).toDouble(),
        finalSigma: (noise['finalSigma'] as num).toDouble(),
        noiseRatio: (noise['ratio'] as num).toDouble()));
    final psfVerdict = evaluateStarPsfQualityGate(comparison: StarPsfQualityComparison(
        referenceStarCount: psf['referenceMeasured'] as int,
        finalStarCount: psf['pairs'] as int,
        referenceMeasuredStarCount: psf['referenceMeasured'] as int,
        finalMeasuredStarCount: psf['pairs'] as int,
        positionMatchedCount: psf['pairs'] as int,
        measuredPairCount: psf['pairs'] as int,
        medianFwhmRatio: (psf['medianFwhmRatio'] as num).toDouble(),
        p90FwhmRatio: (psf['p90FwhmRatio'] as num).toDouble(),
        medianRoundnessDelta: (psf['roundnessDelta'] as num).toDouble()));
    expect(noiseVerdict.hasEnoughMeasurements, isTrue);
    expect(noiseVerdict.passed, isTrue);
    expect(psfVerdict.hasEnoughMeasurements, isTrue);
    expect(psfVerdict.passed, isTrue);
  });
}
