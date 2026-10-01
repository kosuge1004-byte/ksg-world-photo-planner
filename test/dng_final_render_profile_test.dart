import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/export/dng_final_render_profile.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';

RawFrameMetadata _metadata({
  List<double>? whiteBalance,
  List<double>? matrix,
  double? baselineExposure,
  double? baselineExposureOffset,
  List<double>? toneCurve,
  RawProfileHueSatMap? hueSatMap,
  RawProfileLookTable? lookTable,
  int? profileDynamicRange,
  double? profileHintMaxOutputValue,
}) =>
    RawFrameMetadata(
      format: RawFormat.dng,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 8, height: 6),
      orientation: 1,
      blackLevels: const <double>[64, 64, 64, 64],
      whiteLevel: 4095,
      cameraWhiteBalance: whiteBalance,
      d65XyzToCamera: matrix,
      baselineExposure: baselineExposure,
      baselineExposureOffset: baselineExposureOffset,
      profileToneCurve: toneCurve,
      profileHueSatMap: hueSatMap,
      profileLookTable: lookTable,
      profileDynamicRange: profileDynamicRange,
      profileHintMaxOutputValue: profileHintMaxOutputValue,
    );

void main() {
  test('complete metadata is converted atomically and deeply copied', () {
    final List<double> wb = <double>[2, 1, 1, 1.5];
    final List<double> matrix = <double>[1, 0, 0, 0, 1, 0, 0, 0, 1];
    final List<double> curve = <double>[0, 0, 0.5, 0.25, 1, 1];
    final List<double> hueDeltas = <double>[0, 1, 1, 120, 1, 1];
    final List<double> lookDeltas = <double>[0, 1, 1, 240, 1, 1];
    final RawFrameMetadata metadata = _metadata(
      whiteBalance: wb,
      matrix: matrix,
      baselineExposure: 0.75,
      baselineExposureOffset: -0.25,
      toneCurve: curve,
      hueSatMap: RawProfileHueSatMap(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: hueDeltas,
      ),
      lookTable: RawProfileLookTable(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: lookDeltas,
      ),
    );
    final DngFinalRenderProfile profile = DngFinalRenderProfile.fromMetadata(
      sourceId: '/frames/reference.dng',
      metadata: metadata,
      cfaPattern: CfaPattern.rggb,
    );

    wb[0] = 99;
    matrix[0] = 99;
    curve[3] = 0.75;
    hueDeltas[3] = 0;
    lookDeltas[3] = 0;

    expect(profile.sourceId, '/frames/reference.dng');
    expect(profile.baselineExposureEv, 0.5);
    expect(profile.linearColorTransform, isNotNull);
    expect(profile.postProfileColorTransform, isNotNull);
    expect(profile.hueSatMap, isNotNull);
    expect(profile.lookTable, isNotNull);
    expect(profile.toneCurve, isNotNull);
    expect(profile.toneCurve!.evaluate(0.5), 0.25);

    final Float64List hueOut = Float64List(3);
    profile.hueSatMap!.transformPixel(1, 0, 0, hueOut);
    expect(hueOut[1], greaterThan(0.9));
    final Float64List lookOut = Float64List(3);
    profile.lookTable!.transformPixel(1, 0, 0, lookOut);
    expect(lookOut[2], greaterThan(0.9));

    final List<double> exposedMatrix = profile.linearColorTransform!.matrix;
    expect(() => exposedMatrix[0] = 7, throwsUnsupportedError);
  });

  test('missing matrix or white balance yields a graceful partial profile', () {
    final DngFinalRenderProfile noMatrix = DngFinalRenderProfile.fromMetadata(
      sourceId: 'a.dng',
      metadata: _metadata(whiteBalance: const <double>[1, 1, 1, 1]),
      cfaPattern: CfaPattern.rggb,
    );
    final DngFinalRenderProfile noWb = DngFinalRenderProfile.fromMetadata(
      sourceId: 'b.dng',
      metadata: _metadata(
        matrix: const <double>[1, 0, 0, 0, 1, 0, 0, 0, 1],
      ),
      cfaPattern: CfaPattern.rggb,
    );
    expect(noMatrix.linearColorTransform, isNull);
    expect(noWb.linearColorTransform, isNull);
    expect(noMatrix.baselineExposureEv, 0);
    expect(noWb.baselineExposureEv, 0);
  });

  test('post-color profile keeps DNG render stages but omits linear transform',
      () {
    final DngFinalRenderProfile profile =
        DngFinalRenderProfile.postColorFromMetadata(
      sourceId: 'consensus-reference.dng',
      metadata: _metadata(
        whiteBalance: const <double>[2, 1, 1, 1.5],
        matrix: const <double>[1, 0, 0, 0, 1, 0, 0, 0, 1],
        baselineExposure: 0.5,
        baselineExposureOffset: 0.25,
        toneCurve: const <double>[0, 0, 1, 1],
        hueSatMap: RawProfileHueSatMap(
          hueDivisions: 1,
          saturationDivisions: 2,
          valueDivisions: 1,
          encoding: 0,
          deltas: const <double>[0, 1, 1, 0, 1, 1],
        ),
        lookTable: RawProfileLookTable(
          hueDivisions: 1,
          saturationDivisions: 2,
          valueDivisions: 1,
          encoding: 0,
          deltas: const <double>[0, 1, 1, 0, 1, 1],
        ),
      ),
      inputIsLinearProPhoto: true,
    );

    expect(profile.sourceId, 'consensus-reference.dng');
    expect(profile.linearColorTransform, isNull);
    expect(profile.postProfileColorTransform, isNotNull);
    expect(profile.baselineExposureEv, 0.75);
    expect(profile.hueSatMap, isNotNull);
    expect(profile.lookTable, isNotNull);
    expect(profile.toneCurve, isNotNull);
  });

  test('ProfileDynamicRange propagates atomically into all DNG render stages',
      () {
    final DngFinalRenderProfile profile = DngFinalRenderProfile.fromMetadata(
      sourceId: 'hdr-reference.dng',
      metadata: _metadata(
        whiteBalance: const <double>[1, 1, 1, 1],
        matrix: const <double>[1, 0, 0, 0, 1, 0, 0, 0, 1],
        profileDynamicRange: 1,
        profileHintMaxOutputValue: 8,
        toneCurve: const <double>[0, 0, 1, 1],
        hueSatMap: RawProfileHueSatMap(
          hueDivisions: 1,
          saturationDivisions: 2,
          valueDivisions: 2,
          encoding: 0,
          deltas: const <double>[
            0,
            1,
            1,
            0,
            1,
            1,
            0,
            1,
            1,
            0,
            1,
            1,
          ],
        ),
        lookTable: RawProfileLookTable(
          hueDivisions: 1,
          saturationDivisions: 2,
          valueDivisions: 2,
          encoding: 0,
          deltas: const <double>[
            0,
            1,
            1,
            0,
            1,
            1,
            0,
            1,
            1,
            0,
            1,
            1,
          ],
        ),
      ),
      cfaPattern: CfaPattern.rggb,
    );

    expect(profile.isHighDynamicRange, isTrue);
    expect(profile.hintMaxOutputValue, 8);
    expect(profile.hueSatMap!.isHighDynamicRange, isTrue);
    expect(profile.lookTable!.isHighDynamicRange, isTrue);
    expect(profile.toneCurve!.isHighDynamicRange, isTrue);
  });

  test('combined baseline EV outside +/-32 is rejected', () {
    final RawFrameMetadata metadata = _metadata(
      baselineExposure: 20,
      baselineExposureOffset: 20,
    );
    expect(
      () => DngFinalRenderProfile.fromMetadata(
        sourceId: 'unsafe.dng',
        metadata: metadata,
        cfaPattern: CfaPattern.rggb,
      ),
      throwsArgumentError,
    );
  });

  test('source ID must be non-empty', () {
    expect(
      () => DngFinalRenderProfile.fromMetadata(
        sourceId: '',
        metadata: _metadata(),
        cfaPattern: CfaPattern.rggb,
      ),
      throwsArgumentError,
    );
  });

  test('raw metadata profile lists cannot be mutated after construction', () {
    final RawFrameMetadata metadata = _metadata(
      whiteBalance: <double>[2, 1, 1, 1.5],
      matrix: <double>[1, 0, 0, 0, 1, 0, 0, 0, 1],
      toneCurve: <double>[0, 0, 1, 1],
      hueSatMap: RawProfileHueSatMap(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: <double>[0, 1, 1, 0, 1, 1],
      ),
      lookTable: RawProfileLookTable(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: <double>[0, 1, 1, 0, 1, 1],
      ),
    );
    expect(() => metadata.cameraWhiteBalance![0] = 9, throwsUnsupportedError);
    expect(() => metadata.d65XyzToCamera![0] = 9, throwsUnsupportedError);
    expect(() => metadata.profileToneCurve![0] = 9, throwsUnsupportedError);
    expect(
        () => metadata.profileHueSatMap!.deltas[0] = 9, throwsUnsupportedError);
    expect(
        () => metadata.profileLookTable!.deltas[0] = 9, throwsUnsupportedError);
  });

  test('HSV profile tables are not applied without a known ProPhoto path', () {
    final DngFinalRenderProfile profile = DngFinalRenderProfile.fromMetadata(
      sourceId: 'missing-matrix.dng',
      metadata: _metadata(
        whiteBalance: const <double>[1, 1, 1, 1],
        hueSatMap: RawProfileHueSatMap(
          hueDivisions: 1,
          saturationDivisions: 2,
          valueDivisions: 1,
          encoding: 0,
          deltas: const <double>[0, 1, 1, 0, 1, 1],
        ),
      ),
      cfaPattern: CfaPattern.rggb,
    );
    expect(profile.linearColorTransform, isNull);
    expect(profile.postProfileColorTransform, isNull);
    expect(profile.hueSatMap, isNull);
  });
}
