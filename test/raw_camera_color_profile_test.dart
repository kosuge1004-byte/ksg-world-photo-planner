import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/raw_camera_color_profile.dart';
import 'package:mobile_stack/core/color/dng_d65_color_transform.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';

RawCameraColorProfile _profile(List<double> gains) => RawCameraColorProfile(
      d65XyzToCamera: const <double>[
        1,
        -0.1,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
      ],
      phaseWhiteBalance: gains,
    );

void main() {
  test('singular and numerically ill-conditioned matrices are rejected early',
      () {
    expect(
      () => RawCameraColorProfile(
        d65XyzToCamera: List<double>.filled(9, 0),
        phaseWhiteBalance: const <double>[1, 1, 1, 1],
      ),
      throwsA(isA<InvalidRawCameraColorProfile>()),
    );
    expect(
      () => RawCameraColorProfile(
        d65XyzToCamera: const <double>[
          1,
          0,
          0,
          1,
          1e-15,
          0,
          0,
          0,
          1,
        ],
        phaseWhiteBalance: const <double>[1, 1, 1, 1],
      ),
      throwsA(isA<InvalidRawCameraColorProfile>()),
    );
  });

  test('phase gains are converted to RGB gains for every Bayer pattern', () {
    expect(
      _profile(<double>[2, 1, 1.2, 1.5]).rgbWhiteBalance(CfaPattern.rggb),
      orderedEquals(<double>[2, 1.1, 1.5]),
    );
    expect(
      _profile(<double>[1, 2, 1.5, 1.2]).rgbWhiteBalance(CfaPattern.grbg),
      orderedEquals(<double>[2, 1.1, 1.5]),
    );
  });

  test('WB harmonization returns target-reference phase scaling', () {
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[2, 1, 1, 0.5]),
    );
    final LinearRawMosaic harmonized = harmonizeMosaicWhiteBalance(
      mosaic: mosaic,
      source: _profile(<double>[2, 1, 1, 0.5]),
      target: _profile(<double>[1, 2, 3, 4]),
      targetPattern: CfaPattern.rggb,
    );
    final List<double> expected = <double>[0.4, 1, 1, 1.6];
    for (int index = 0; index < expected.length; index++) {
      expect(harmonized.samples[index], closeTo(expected[index], 1e-6));
    }
  });

  test('normalized WB and output transform ignore a common gain scale', () {
    final RawCameraColorProfile base = _profile(<double>[2, 1, 1, 1.5]);
    final RawCameraColorProfile scaled = _profile(<double>[20, 10, 10, 15]);

    expect(
      scaled.normalizedRgbWhiteBalance(CfaPattern.rggb),
      orderedEquals(base.normalizedRgbWhiteBalance(CfaPattern.rggb)),
    );
    final List<double> baseMatrix =
        base.outputTransform(CfaPattern.rggb).matrix;
    final List<double> scaledMatrix =
        scaled.outputTransform(CfaPattern.rggb).matrix;
    for (int index = 0; index < 9; index++) {
      expect(scaledMatrix[index], closeTo(baseMatrix[index], 1e-12));
    }
  });

  test('harmonization ignores arbitrary common metadata WB scale', () {
    final RawCameraColorProfile base = _profile(<double>[2, 1, 1, 1.5]);
    final RawCameraColorProfile scaled = _profile(<double>[20, 10, 10, 15]);
    LinearRawMosaic mosaic() => LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List.fromList(<double>[0.25, 0.5, 0.75, 1.0]),
        );

    final LinearRawMosaic fromBase = harmonizeMosaicWhiteBalance(
      mosaic: mosaic(),
      source: base,
      target: base,
      targetPattern: CfaPattern.rggb,
    );
    final LinearRawMosaic fromScaled = harmonizeMosaicWhiteBalance(
      mosaic: mosaic(),
      source: scaled,
      target: base,
      targetPattern: CfaPattern.rggb,
    );
    for (int index = 0; index < fromBase.samples.length; index++) {
      expect(fromScaled.samples[index], closeTo(fromBase.samples[index], 1e-7));
    }
  });

  test('different matrices cannot be harmonized', () {
    final RawCameraColorProfile other = RawCameraColorProfile(
      d65XyzToCamera: const <double>[
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
      ],
      phaseWhiteBalance: const <double>[1, 1, 1, 1],
    );
    expect(
      () => harmonizeMosaicWhiteBalance(
        mosaic: LinearRawMosaic(
          width: 2,
          height: 2,
          cfaPattern: CfaPattern.rggb,
          samples: Float32List(4),
        ),
        source: _profile(<double>[1, 1, 1, 1]),
        target: other,
        targetPattern: CfaPattern.rggb,
      ),
      throwsA(isA<InvalidRawCameraColorProfile>()),
    );
  });

  test('consensus chooses the majority matrix instead of the first outlier',
      () {
    RawCameraColorProfile profile(double matrix00, List<double> gains) =>
        RawCameraColorProfile(
          d65XyzToCamera: <double>[
            matrix00,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            1,
          ],
          phaseWhiteBalance: gains,
        );

    final RawCameraColorConsensus consensus = selectRawCameraColorConsensus(
      profiles: <RawCameraColorProfile?>[
        profile(1.2, <double>[9, 9, 9, 9]),
        profile(1, <double>[2, 1, 1, 1.5]),
        profile(1, <double>[4, 3, 3, 3.5]),
      ],
      patterns: const <CfaPattern?>[
        CfaPattern.rggb,
        CfaPattern.rggb,
        CfaPattern.rggb,
      ],
    )!;

    expect(consensus.representativeIndex, 1);
    expect(consensus.memberIndices, orderedEquals(<int>[1, 2]));
    expect(consensus.profile.d65XyzToCamera.first, 1);
    final List<double> consensusGains =
        consensus.profile.normalizedRgbWhiteBalance(CfaPattern.rggb);
    expect(consensusGains[0], closeTo(5 / 3, 1e-12));
    expect(consensusGains[1], 1);
    expect(consensusGains[2], closeTo(4 / 3, 1e-12));
  });

  test('consensus ignores profiles whose mosaic pattern is unavailable', () {
    final RawCameraColorConsensus consensus = selectRawCameraColorConsensus(
      profiles: <RawCameraColorProfile?>[
        _profile(<double>[20, 20, 20, 20]),
        _profile(<double>[2, 1, 1, 1.5]),
      ],
      patterns: const <CfaPattern?>[null, CfaPattern.rggb],
    )!;
    expect(consensus.representativeIndex, 1);
    expect(consensus.memberIndices, orderedEquals(<int>[1]));
  });
  test('WB harmonization rejects non-finite RAW input instead of hiding it',
      () {
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(
        <double>[double.nan, 1, 1, 1],
      ),
    );
    expect(
      () => harmonizeMosaicWhiteBalance(
        mosaic: mosaic,
        source: _profile(<double>[1, 1, 1, 1]),
        target: _profile(<double>[1, 1, 1, 1]),
        targetPattern: CfaPattern.rggb,
      ),
      throwsA(isA<InvalidRawCameraColorProfile>()),
    );
  });

  test(
      'WB harmonization preserves finite negative and HDR values without clipping',
      () {
    final LinearRawMosaic mosaic = LinearRawMosaic(
      width: 2,
      height: 2,
      cfaPattern: CfaPattern.rggb,
      samples: Float32List.fromList(<double>[-0.25, 4, 2, 0.5]),
    );
    final LinearRawMosaic result = harmonizeMosaicWhiteBalance(
      mosaic: mosaic,
      source: _profile(<double>[1, 1, 1, 1]),
      target: _profile(<double>[1, 1, 1, 1]),
      targetPattern: CfaPattern.rggb,
    );
    expect(result.samples, orderedEquals(mosaic.samples));
  });

  test(
      'consensus uses an observed matrix medoid when compatible group sizes tie',
      () {
    RawCameraColorProfile profile(double matrix00) => RawCameraColorProfile(
          d65XyzToCamera: <double>[
            matrix00,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            1,
          ],
          phaseWhiteBalance: const <double>[2, 1, 1, 1.5],
        );

    final RawCameraColorConsensus consensus = selectRawCameraColorConsensus(
      profiles: <RawCameraColorProfile?>[
        profile(1.00000),
        profile(1.00004),
        profile(1.00005),
      ],
      patterns: const <CfaPattern?>[
        CfaPattern.rggb,
        CfaPattern.rggb,
        CfaPattern.rggb,
      ],
      matrixTolerance: 1e-4,
    )!;

    expect(consensus.memberIndices, orderedEquals(<int>[0, 1, 2]));
    expect(consensus.representativeIndex, 1);
    expect(consensus.profile.d65XyzToCamera.first, closeTo(1.00004, 1e-12));
  });

  test('consensus preserves same-pattern green-phase WB asymmetry', () {
    final RawCameraColorConsensus consensus = selectRawCameraColorConsensus(
      profiles: <RawCameraColorProfile?>[
        _profile(<double>[2.0, 0.9, 1.1, 1.5]),
        _profile(<double>[2.2, 0.8, 1.2, 1.6]),
      ],
      patterns: const <CfaPattern?>[
        CfaPattern.rggb,
        CfaPattern.rggb,
      ],
    )!;

    final List<double> phases = consensus.profile.phaseWhiteBalance;
    expect(phases[0], closeTo(2.1, 1e-12));
    expect(phases[1], closeTo(0.85, 1e-12));
    expect(phases[2], closeTo(1.15, 1e-12));
    expect(phases[3], closeTo(1.55, 1e-12));
    expect(phases[1], isNot(closeTo(phases[2], 1e-12)));
  });

  test('profile construction does not assume RGGB before CFA pattern is known',
      () {
    final RawCameraColorProfile profile = RawCameraColorProfile(
      d65XyzToCamera: d65XyzToLinearSrgb,
      phaseWhiteBalance: const <double>[0.2, 5.0, 1.0, 0.25],
    );
    expect(
      () => profile.outputTransform(CfaPattern.grbg),
      returnsNormally,
    );
  });
}
