import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';

RawFrameMetadata _metadata({
  required RawFormat format,
  int orientation = 1,
  List<double>? whiteBalance,
  List<double>? matrix,
  double? baselineExposure,
  double? baselineExposureOffset,
  int? profileDynamicRange,
  double? profileHintMaxOutputValue,
  List<double>? toneCurve,
}) =>
    RawFrameMetadata(
      format: format,
      activeArea: const RawActiveArea(left: 2, top: 3, width: 10, height: 11),
      orientation: orientation,
      blackLevels: const <double>[1, 2, 3, 4],
      whiteLevel: 1000,
      cameraWhiteBalance: whiteBalance,
      d65XyzToCamera: matrix,
      baselineExposure: baselineExposure,
      baselineExposureOffset: baselineExposureOffset,
      profileDynamicRange: profileDynamicRange,
      profileHintMaxOutputValue: profileHintMaxOutputValue,
      profileToneCurve: toneCurve,
    );

void main() {
  test('decoded sensor and optional fields win over probe values', () {
    final RawFrameMetadata decoded = _metadata(
      format: RawFormat.dng,
      orientation: 6,
      whiteBalance: const <double>[2, 1, 1, 1.5],
      baselineExposure: 0.5,
    );
    final RawFrameMetadata probed = RawFrameMetadata(
      format: RawFormat.dng,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 99, height: 99),
      orientation: 1,
      blackLevels: const <double>[9, 9, 9, 9],
      whiteLevel: 9999,
      cameraWhiteBalance: const <double>[9, 9, 9, 9],
      baselineExposure: 1.5,
    );
    final RawFrameMetadata merged = mergeSameFrameRawMetadata(
      decoded: decoded,
      probed: probed,
    );
    expect(merged.orientation, 6);
    expect(merged.activeArea.left, 2);
    expect(merged.blackLevels, orderedEquals(<double>[1, 2, 3, 4]));
    expect(merged.whiteLevel, 1000);
    expect(merged.cameraWhiteBalance, orderedEquals(<double>[2, 1, 1, 1.5]));
    expect(merged.baselineExposure, 0.5);
  });

  test('probe fills only missing optional render-profile values', () {
    final RawFrameMetadata decoded = _metadata(format: RawFormat.dng);
    final RawFrameMetadata probed = _metadata(
      format: RawFormat.dng,
      whiteBalance: const <double>[2, 1, 1, 1.5],
      matrix: const <double>[1, 0, 0, 0, 1, 0, 0, 0, 1],
      baselineExposure: 0.25,
      baselineExposureOffset: -0.1,
      toneCurve: const <double>[0, 0, 1, 1],
    );
    final RawFrameMetadata merged = mergeSameFrameRawMetadata(
      decoded: decoded,
      probed: probed,
    );
    expect(merged.cameraWhiteBalance, probed.cameraWhiteBalance);
    expect(merged.d65XyzToCamera, probed.d65XyzToCamera);
    expect(merged.baselineExposure, 0.25);
    expect(merged.baselineExposureOffset, -0.1);
    expect(merged.profileToneCurve, probed.profileToneCurve);
  });

  test('probe fills DNG linearization and orientation-normalized black deltas',
      () {
    final RawFrameMetadata decoded = RawFrameMetadata(
      format: RawFormat.dng,
      activeArea: const RawActiveArea(left: 0, top: 0, width: 11, height: 10),
      orientation: 1,
      blackLevels: const <double>[1, 2, 3, 4],
      whiteLevel: 1000,
    );
    final RawFrameMetadata probed = RawFrameMetadata(
      format: RawFormat.dng,
      activeArea: const RawActiveArea(left: 2, top: 3, width: 10, height: 11),
      orientation: 6,
      blackLevels: const <double>[9, 9, 9, 9],
      whiteLevel: 9999,
      linearizationTable: const <double>[0, 2, 5, 9],
      blackLevelDeltaH: const <double>[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      blackLevelDeltaV: const <double>[
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20
      ],
    );

    final RawFrameMetadata merged = mergeSameFrameRawMetadata(
      decoded: decoded,
      probed: probed,
    );

    expect(merged.linearizationTable, orderedEquals(<double>[0, 2, 5, 9]));
    expect(
      merged.blackLevelDeltaH,
      orderedEquals(<double>[20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10]),
    );
    expect(
      merged.blackLevelDeltaV,
      orderedEquals(<double>[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
  });

  test('black-level delta lengths must match ActiveArea dimensions', () {
    expect(
      () => RawFrameMetadata(
        format: RawFormat.dng,
        activeArea: const RawActiveArea(left: 0, top: 0, width: 2, height: 2),
        orientation: 1,
        blackLevels: const <double>[0, 0, 0, 0],
        whiteLevel: 100,
        blackLevelDeltaH: const <double>[1],
      ),
      throwsArgumentError,
    );
  });

  test('ProfileDynamicRange tag fields are merged atomically', () {
    final RawFrameMetadata decoded = _metadata(
      format: RawFormat.dng,
      profileDynamicRange: 0,
      profileHintMaxOutputValue: 0.75,
    );
    final RawFrameMetadata probed = _metadata(
      format: RawFormat.dng,
      profileDynamicRange: 1,
      profileHintMaxOutputValue: 8,
    );
    final RawFrameMetadata merged = mergeSameFrameRawMetadata(
      decoded: decoded,
      probed: probed,
    );

    expect(merged.profileDynamicRange, 0);
    expect(merged.profileHintMaxOutputValue, 0.75);
  });

  test('probe fills the complete ProfileDynamicRange tag when decoder lacks it',
      () {
    final RawFrameMetadata decoded = _metadata(format: RawFormat.dng);
    final RawFrameMetadata probed = _metadata(
      format: RawFormat.dng,
      profileDynamicRange: 1,
      profileHintMaxOutputValue: 8,
    );
    final RawFrameMetadata merged = mergeSameFrameRawMetadata(
      decoded: decoded,
      probed: probed,
    );

    expect(merged.profileDynamicRange, 1);
    expect(merged.profileHintMaxOutputValue, 8);
  });

  test('HintMaxOutputValue without ProfileDynamicRange is rejected', () {
    expect(
      () => _metadata(
        format: RawFormat.dng,
        profileHintMaxOutputValue: 8,
      ),
      throwsArgumentError,
    );
  });

  test('format mismatch is rejected', () {
    expect(
      () => mergeSameFrameRawMetadata(
        decoded: _metadata(format: RawFormat.dng),
        probed: _metadata(format: RawFormat.arw),
      ),
      throwsArgumentError,
    );
  });

  test('merge does not mutate either input', () {
    final RawFrameMetadata decoded = _metadata(
      format: RawFormat.dng,
      whiteBalance: const <double>[2, 1, 1, 1.5],
    );
    final RawFrameMetadata probed = _metadata(
      format: RawFormat.dng,
      profileDynamicRange: 1,
      toneCurve: const <double>[0, 0, 1, 0.5],
    );
    final List<double> decodedWbBefore =
        List<double>.from(decoded.cameraWhiteBalance!);
    final List<double> probedCurveBefore =
        List<double>.from(probed.profileToneCurve!);
    final RawFrameMetadata merged = mergeSameFrameRawMetadata(
      decoded: decoded,
      probed: probed,
    );
    expect(decoded.cameraWhiteBalance, orderedEquals(decodedWbBefore));
    expect(probed.profileToneCurve, orderedEquals(probedCurveBefore));
    expect(identical(merged, decoded), isFalse);
    expect(identical(merged, probed), isFalse);
  });
}
