import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/pipeline/raw_mosaic_calibrator.dart';

LinearRawMosaic _mosaic(
  int width,
  int height,
  List<double> samples,
) {
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: CfaPattern.rggb,
    samples: Float32List.fromList(samples),
  );
}

void _expectSamples(
  Float32List actual,
  List<double> expected,
) {
  expect(actual, hasLength(expected.length));
  for (int index = 0; index < expected.length; index++) {
    expect(actual[index], closeTo(expected[index], 1e-6));
  }
}

void main() {
  const RawMosaicCalibrator calibrator = RawMosaicCalibrator(
    maximumSamplesPerChunk: 2,
  );

  test('LinearizationTableを黒引きより前に適用し範囲外値は最終entryへ写像する', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      <double>[0, 1, 2, 99],
    );

    expect(
      await calibrator.applyLinearizationTable(
        mosaic,
        table: const <double>[0, 2, 5, 9],
      ),
      isTrue,
    );

    _expectSamples(mosaic.samples, const <double>[0, 2, 5, 9]);
  });

  test('BlackLevelDeltaH/Vを画素blackへ加算し最大computed blackで正規化する', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      const <double>[80, 80, 80, 80],
    );
    const List<double> black = <double>[10, 20, 30, 40];
    const List<double> deltaH = <double>[1, 2];
    const List<double> deltaV = <double>[3, 4];

    await calibrator.subtractBlackLevels(
      mosaic,
      blackLevels: black,
      blackLevelDeltaH: deltaH,
      blackLevelDeltaV: deltaV,
    );
    await calibrator.normalizeWhiteLevel(
      mosaic,
      blackLevels: black,
      whiteLevel: 100,
      blackLevelDeltaH: deltaH,
      blackLevelDeltaV: deltaV,
    );

    // maximum computed black = 40 + 2 + 4 = 46, denominator = 54.
    _expectSamples(
      mosaic.samples,
      const <double>[1, 1, 45 / 54, 34 / 54],
    );
  });

  test('黒引き・最大black基準の正規化・カメラWBを適用する', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      <double>[55, 60, 65, 70],
    );
    const List<double> black = <double>[10, 20, 30, 40];

    expect(
      await calibrator.subtractBlackLevels(
        mosaic,
        blackLevels: black,
      ),
      isTrue,
    );
    expect(
      await calibrator.normalizeWhiteLevel(
        mosaic,
        blackLevels: black,
        whiteLevel: 100,
      ),
      isTrue,
    );
    expect(
      await calibrator.applyCameraWhiteBalance(
        mosaic,
        gains: const <double>[2, 1, 1, 1.5],
      ),
      isTrue,
    );

    _expectSamples(
      mosaic.samples,
      <double>[1.5, 2 / 3, 7 / 12, 0.75],
    );
  });

  test('正規化係数はsample plane内の最大black levelを使用する', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      const <double>[70, 70, 70, 70],
    );
    const List<double> black = <double>[10, 20, 30, 40];

    await calibrator.subtractBlackLevels(mosaic, blackLevels: black);
    await calibrator.normalizeWhiteLevel(
      mosaic,
      blackLevels: black,
      whiteLevel: 100,
    );

    _expectSamples(mosaic.samples, const <double>[1, 5 / 6, 2 / 3, 0.5]);
  });

  test('黒レベル反復の原点をActiveArea左上に合わせる', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      <double>[100, 100, 100, 100],
    );

    await calibrator.subtractBlackLevels(
      mosaic,
      blackLevels: const <double>[10, 20, 30, 40],
      patternOriginX: 1,
      patternOriginY: 1,
    );

    _expectSamples(mosaic.samples, <double>[60, 70, 80, 90]);
  });

  test('負値は保持しWhiteLevel超過だけ1.0へクリップする', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      <double>[5, 150, 30, 40],
    );
    const List<double> black = <double>[10, 10, 10, 10];

    await calibrator.subtractBlackLevels(
      mosaic,
      blackLevels: black,
    );
    await calibrator.normalizeWhiteLevel(
      mosaic,
      blackLevels: black,
      whiteLevel: 100,
    );

    expect(mosaic.samples[0], lessThan(0));
    expect(mosaic.samples[1], closeTo(1.0, 1e-6));
  });

  test('チャンク境界でキャンセルして後続画素を変更しない', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      <double>[20, 20, 20, 20],
    );
    int checks = 0;

    final bool completed = await calibrator.subtractBlackLevels(
      mosaic,
      blackLevels: const <double>[10, 10, 10, 10],
      isCancelled: () => checks++ > 0,
    );

    expect(completed, isFalse);
    _expectSamples(mosaic.samples, <double>[10, 10, 20, 20]);
  });

  test('不正な補正メタデータを画素変更前に拒否する', () {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      <double>[1, 2, 3, 4],
    );

    expect(
      () => calibrator.subtractBlackLevels(
        mosaic,
        blackLevels: const <double>[0, 0, 0],
      ),
      throwsArgumentError,
    );
    expect(
      () => calibrator.normalizeWhiteLevel(
        mosaic,
        blackLevels: const <double>[0, 0, 0, 100],
        whiteLevel: 100,
      ),
      throwsArgumentError,
    );
    expect(
      () => calibrator.applyCameraWhiteBalance(
        mosaic,
        gains: const <double>[1, 0, 1, 1],
      ),
      throwsArgumentError,
    );
  });

  test('非有限のRAW画素を拒否する', () async {
    final LinearRawMosaic mosaic = _mosaic(
      2,
      2,
      <double>[1, double.nan, 3, 4],
    );

    await expectLater(
      calibrator.subtractBlackLevels(
        mosaic,
        blackLevels: const <double>[0, 0, 0, 0],
      ),
      throwsStateError,
    );
  });
}
