import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/raw/native_raw_metadata_probe.dart';
import 'package:mobile_stack/core/raw/raw_decoder_contract.dart';
import 'package:mobile_stack/core/raw/raw_format.dart';
import 'package:mobile_stack/core/raw/raw_native_contract.dart';
import 'package:mobile_stack/core/raw/raw_probe_result.dart';

class _FakeMetadataBackend implements RawNativeMetadataProbeBackend {
  _FakeMetadataBackend(this.frame);

  final RawNativeMetadataFrame frame;
  RawNativeMetadataProbeCommand? lastCommand;

  @override
  Future<RawNativeMetadataFrame> probeMetadata(
    RawNativeMetadataProbeCommand command,
  ) async {
    lastCommand = command;
    return frame;
  }
}

RawProbeResult _probe() => const RawProbeResult(
      path: '/images/input.dng',
      format: RawFormat.dng,
      byteLength: 8192,
      isReadable: true,
      signatureMatched: true,
    );

RawNativeMetadataFrame _frame({
  RawFormat format = RawFormat.dng,
  int width = 6000,
  int height = 4000,
  RawActiveArea? activeArea,
  List<double> blackLevels = const <double>[64, 64, 64, 64],
  double whiteLevel = 16383,
  List<double>? cameraWhiteBalance = const <double>[2, 1, 1, 1.5],
  List<double>? d65XyzToCamera,
  double? baselineExposure,
  double? baselineExposureOffset,
  int? profileDynamicRange,
  List<double>? profileToneCurve,
  RawProfileHueSatMap? profileHueSatMap,
  RawProfileLookTable? profileLookTable,
}) {
  return RawNativeMetadataFrame(
    format: format,
    width: width,
    height: height,
    cfaPattern: CfaPattern.rggb,
    activeArea: activeArea ??
        const RawActiveArea(
          left: 8,
          top: 8,
          width: 5984,
          height: 3984,
        ),
    orientation: 1,
    blackLevels: blackLevels,
    whiteLevel: whiteLevel,
    cameraWhiteBalance: cameraWhiteBalance,
    d65XyzToCamera: d65XyzToCamera,
    baselineExposure: baselineExposure,
    baselineExposureOffset: baselineExposureOffset,
    profileDynamicRange: profileDynamicRange,
    profileToneCurve: profileToneCurve,
    profileHueSatMap: profileHueSatMap,
    profileLookTable: profileLookTable,
  );
}

NativeRawMetadataProbe _metadataProbe(
  RawNativeMetadataProbeBackend backend,
) {
  return NativeRawMetadataProbe(
    backend: backend,
    supportedFormats: const <RawFormat>[RawFormat.dng],
  );
}

void main() {
  test('対応形式を呼び出し前に判定できる', () {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(_frame()),
    );

    expect(probe.supports(RawFormat.dng), isTrue);
    expect(probe.supports(RawFormat.nef), isFalse);
  });

  test('画素デコードなしでRAW構造情報を安全なモデルへ変換する', () async {
    final _FakeMetadataBackend backend = _FakeMetadataBackend(_frame());

    final result = await _metadataProbe(backend).probe(_probe());

    expect(result.width, 6000);
    expect(result.height, 4000);
    expect(result.cfaPattern, CfaPattern.rggb);
    expect(result.metadata.activeArea.left, 8);
    expect(result.metadata.whiteLevel, 16383);
    expect(
      result.metadata.cameraWhiteBalance,
      orderedEquals(<double>[2, 1, 1, 1.5]),
    );
    expect(backend.lastCommand!.path, '/images/input.dng');
    expect(backend.lastCommand!.expectedByteLength, 8192);
  });

  test('入力と異なるRAW形式のメタデータを拒否する', () async {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(_frame(format: RawFormat.nef)),
    );

    expect(
      probe.probe(_probe()),
      throwsA(
        isA<RawDecodeFailure>().having(
          (RawDecodeFailure error) => error.code,
          'code',
          RawDecodeErrorCode.corruptData,
        ),
      ),
    );
  });

  test('D65 XYZ-to-camera matrix is preserved in safe metadata', () async {
    const List<double> matrix = <double>[
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
    ];
    final result = await _metadataProbe(
      _FakeMetadataBackend(_frame(d65XyzToCamera: matrix)),
    ).probe(_probe());
    expect(result.metadata.d65XyzToCamera, orderedEquals(matrix));
  });

  test('malformed D65 color matrix is rejected at the probe boundary', () {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(
        _frame(d65XyzToCamera: const <double>[1, double.nan, 3]),
      ),
    );
    expect(probe.probe(_probe()), throwsA(isA<RawDecodeFailure>()));
  });

  test('BaselineExposure is preserved in safe metadata', () async {
    final result = await _metadataProbe(
      _FakeMetadataBackend(_frame(baselineExposure: 0.5)),
    ).probe(_probe());
    expect(result.metadata.baselineExposure, 0.5);
  });

  test('unsafe BaselineExposure is rejected at the probe boundary', () {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(_frame(baselineExposure: 33)),
    );
    expect(probe.probe(_probe()), throwsA(isA<RawDecodeFailure>()));
  });

  test('BaselineExposureOffset is preserved and added in EV', () async {
    final result = await _metadataProbe(
      _FakeMetadataBackend(
        _frame(baselineExposure: 0.5, baselineExposureOffset: -0.25),
      ),
    ).probe(_probe());
    expect(result.metadata.baselineExposure, 0.5);
    expect(result.metadata.baselineExposureOffset, -0.25);
    expect(result.metadata.totalBaselineExposure, 0.25);
  });

  test('unsafe BaselineExposureOffset is rejected', () {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(_frame(baselineExposureOffset: 33)),
    );
    expect(probe.probe(_probe()), throwsA(isA<RawDecodeFailure>()));
  });

  test('DNG ProfileToneCurve is preserved in safe metadata', () async {
    const List<double> curve = <double>[0, 0, 0.5, 0.25, 1, 1];
    final result = await _metadataProbe(
      _FakeMetadataBackend(_frame(profileToneCurve: curve)),
    ).probe(_probe());
    expect(result.metadata.profileToneCurve, orderedEquals(curve));
  });

  test('non-increasing DNG ProfileToneCurve is rejected', () {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(
        _frame(
          profileToneCurve: const <double>[0, 0, 0.5, 0.25, 0.5, 1],
        ),
      ),
    );
    expect(probe.probe(_probe()), throwsA(isA<RawDecodeFailure>()));
  });

  test('out-of-range DNG ProfileToneCurve is rejected', () {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(
        _frame(profileToneCurve: const <double>[0, 0, 1, 1.01]),
      ),
    );
    expect(probe.probe(_probe()), throwsA(isA<RawDecodeFailure>()));
  });

  test('SDR DNG ProfileToneCurve requires DNG endpoint knots', () {
    for (final List<double> curve in <List<double>>[
      <double>[0, 0.1, 1, 1],
      <double>[0, 0, 0.9, 0.9],
    ]) {
      final NativeRawMetadataProbe probe = _metadataProbe(
        _FakeMetadataBackend(_frame(profileToneCurve: curve)),
      );
      expect(probe.probe(_probe()), throwsA(isA<RawDecodeFailure>()));
    }
  });

  test('HDR DNG ProfileToneCurve may end before one', () async {
    const List<double> curve = <double>[0, 0, 0.8, 0.7];
    final result = await _metadataProbe(
      _FakeMetadataBackend(
        _frame(profileDynamicRange: 1, profileToneCurve: curve),
      ),
    ).probe(_probe());
    expect(result.metadata.profileToneCurve, orderedEquals(curve));
    expect(result.metadata.profileDynamicRange, 1);
  });

  test('DNG ProfileHueSatMap is preserved in safe metadata', () async {
    final RawProfileHueSatMap map = RawProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[0, 1, 1, 15, 1.1, 0.9],
    );
    final result = await _metadataProbe(
      _FakeMetadataBackend(_frame(profileHueSatMap: map)),
    ).probe(_probe());
    expect(result.metadata.profileHueSatMap, same(map));
    expect(result.metadata.profileHueSatMap!.deltas[3], 15);
  });

  test('RawProfileHueSatMap rejects unsafe scale data', () {
    expect(
      () => RawProfileHueSatMap(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: const <double>[0, 1, 1, 0, -1, 1],
      ),
      throwsArgumentError,
    );
  });

  test('RawProfileHueSatMap rejects non-unit zero-saturation value scale', () {
    expect(
      () => RawProfileHueSatMap(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: const <double>[0, 1, 0.5, 0, 1, 1],
      ),
      throwsArgumentError,
    );
  });

  test('DNG ProfileLookTable is preserved in safe metadata', () async {
    final RawProfileLookTable table = RawProfileLookTable(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 1,
      deltas: const <double>[20, 1.1, 1, 20, 1.1, 0.9],
    );
    final result = await _metadataProbe(
      _FakeMetadataBackend(_frame(profileLookTable: table)),
    ).probe(_probe());
    expect(result.metadata.profileLookTable, same(table));
    expect(result.metadata.profileLookTable!.encoding, 1);
  });

  test('RawProfileLookTable rejects unsafe scale data', () {
    expect(
      () => RawProfileLookTable(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: const <double>[0, 1, 1, 0, 65, 1],
      ),
      throwsArgumentError,
    );
  });

  test('RawProfileLookTable rejects non-unit zero-saturation value scale', () {
    expect(
      () => RawProfileLookTable(
        hueDivisions: 1,
        saturationDivisions: 2,
        valueDivisions: 1,
        encoding: 0,
        deltas: const <double>[0, 1, 0.5, 0, 1, 1],
      ),
      throwsArgumentError,
    );
  });

  test('画像範囲外の有効領域を拒否する', () async {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(
        _frame(
          activeArea: const RawActiveArea(
            left: 5999,
            top: 0,
            width: 2,
            height: 4000,
          ),
        ),
      ),
    );

    expect(
      probe.probe(_probe()),
      throwsA(isA<RawDecodeFailure>()),
    );
  });

  test('非有限のレベル値を拒否する', () async {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(_frame(whiteLevel: double.nan)),
    );

    expect(
      probe.probe(_probe()),
      throwsA(isA<RawDecodeFailure>()),
    );
  });

  test('ホワイトレベル以上のブラックレベルを拒否する', () async {
    final NativeRawMetadataProbe probe = _metadataProbe(
      _FakeMetadataBackend(
        _frame(blackLevels: const <double>[64, 64, 16383, 64]),
      ),
    );

    expect(
      probe.probe(_probe()),
      throwsA(isA<RawDecodeFailure>()),
    );
  });
}
