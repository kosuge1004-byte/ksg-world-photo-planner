import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/pipeline/raw_defect_map.dart';
import 'package:mobile_stack/core/pipeline/raw_defect_pixel_corrector.dart';

LinearRawMosaic _mosaic(
  int width,
  int height, {
  double value = 1,
}) {
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: CfaPattern.rggb,
    samples: Float32List.fromList(
      List<double>.filled(width * height, value),
    ),
  );
}

void _setSample(
  LinearRawMosaic mosaic,
  int x,
  int y,
  double value,
) {
  mosaic.samples[y * mosaic.width + x] = value;
}

void main() {
  test('明示された孤立欠陥だけを同一CFA位相から補間する', () async {
    final LinearRawMosaic mosaic = _mosaic(7, 7);
    for (int y = 0; y < mosaic.height; y++) {
      for (int x = 0; x < mosaic.width; x++) {
        final int phase = (y & 1) * 2 + (x & 1);
        _setSample(mosaic, x, y, <double>[1, 10, 20, 30][phase]);
      }
    }
    _setSample(mosaic, 2, 2, 999);

    final RawDefectCorrectionResult result =
        await const RawDefectPixelCorrector().correct(
      mosaic,
      RawDefectMap(
        const <RawDefectPoint>[RawDefectPoint(x: 2, y: 2)],
      ),
    );

    expect(result.completed, isTrue);
    expect(result.correctedCount, 1);
    expect(result.skippedCount, 0);
    expect(mosaic.sampleAt(2, 2), closeTo(1, 1e-6));
    expect(mosaic.sampleAt(3, 2), closeTo(10, 1e-6));
  });

  test('最も勾配の小さい対向方向を選ぶ', () async {
    final LinearRawMosaic mosaic = _mosaic(9, 9, value: 50);
    _setSample(mosaic, 4, 4, 999);
    _setSample(mosaic, 2, 4, 1);
    _setSample(mosaic, 6, 4, 1.2);
    _setSample(mosaic, 4, 2, 0);
    _setSample(mosaic, 4, 6, 10);
    _setSample(mosaic, 2, 2, 0);
    _setSample(mosaic, 6, 6, 20);
    _setSample(mosaic, 6, 2, 0);
    _setSample(mosaic, 2, 6, 30);

    await const RawDefectPixelCorrector().correct(
      mosaic,
      RawDefectMap(
        const <RawDefectPoint>[RawDefectPoint(x: 4, y: 4)],
      ),
    );

    expect(mosaic.sampleAt(4, 4), closeTo(1.1, 1e-6));
  });

  test('画像端では利用可能な同一位相近傍の中央値を使う', () async {
    final LinearRawMosaic mosaic = _mosaic(3, 3);
    _setSample(mosaic, 0, 0, 999);
    _setSample(mosaic, 2, 0, 2);
    _setSample(mosaic, 0, 2, 4);
    _setSample(mosaic, 2, 2, 100);

    await const RawDefectPixelCorrector().correct(
      mosaic,
      RawDefectMap(
        const <RawDefectPoint>[RawDefectPoint(x: 0, y: 0)],
      ),
    );

    expect(mosaic.sampleAt(0, 0), closeTo(4, 1e-6));
  });

  test('隣接する明示欠陥を互いの補間元に使わない', () async {
    final LinearRawMosaic mosaic = _mosaic(7, 7);
    _setSample(mosaic, 2, 2, 99);
    _setSample(mosaic, 4, 2, 88);
    final RawDefectMap map = RawDefectMap(
      const <RawDefectPoint>[
        RawDefectPoint(x: 2, y: 2),
        RawDefectPoint(x: 4, y: 2),
      ],
    );

    final RawDefectCorrectionResult result =
        await const RawDefectPixelCorrector().correct(mosaic, map);

    expect(result.correctedCount, 2);
    expect(mosaic.sampleAt(2, 2), closeTo(1, 1e-6));
    expect(mosaic.sampleAt(4, 2), closeTo(1, 1e-6));
  });

  test('補間元が無い欠陥は変更せずスキップする', () async {
    final LinearRawMosaic mosaic = _mosaic(1, 1, value: 99);

    final RawDefectCorrectionResult result =
        await const RawDefectPixelCorrector().correct(
      mosaic,
      RawDefectMap(
        const <RawDefectPoint>[RawDefectPoint(x: 0, y: 0)],
      ),
    );

    expect(result.correctedCount, 0);
    expect(result.skippedCount, 1);
    expect(mosaic.samples.single, 99);
  });

  test('重複座標と画像範囲外座標を拒否する', () async {
    expect(
      () => RawDefectMap(
        const <RawDefectPoint>[
          RawDefectPoint(x: 1, y: 1),
          RawDefectPoint(x: 1, y: 1),
        ],
      ),
      throwsArgumentError,
    );

    await expectLater(
      const RawDefectPixelCorrector().correct(
        _mosaic(2, 2),
        RawDefectMap(
          const <RawDefectPoint>[RawDefectPoint(x: 2, y: 0)],
        ),
      ),
      throwsArgumentError,
    );
  });

  test('チャンク境界のキャンセル後は後続欠陥を変更しない', () async {
    final LinearRawMosaic mosaic = _mosaic(7, 7);
    _setSample(mosaic, 2, 2, 99);
    _setSample(mosaic, 4, 2, 88);
    int checks = 0;

    final RawDefectCorrectionResult result =
        await const RawDefectPixelCorrector(
      maximumPointsPerChunk: 1,
    ).correct(
      mosaic,
      RawDefectMap(
        const <RawDefectPoint>[
          RawDefectPoint(x: 2, y: 2),
          RawDefectPoint(x: 4, y: 2),
        ],
      ),
      isCancelled: () => checks++ > 0,
    );

    expect(result.completed, isFalse);
    expect(result.correctedCount, 1);
    expect(mosaic.sampleAt(2, 2), closeTo(1, 1e-6));
    expect(mosaic.sampleAt(4, 2), 88);
  });
}
