import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/image/cfa_pattern.dart';
import 'package:mobile_stack/core/image/linear_raw_mosaic.dart';
import 'package:mobile_stack/core/pipeline/cold_pixel_detection.dart';
import 'package:mobile_stack/core/pipeline/raw_defect_map.dart';

LinearRawMosaic _flat(
  int width,
  int height,
  double Function(int x, int y) value,
) {
  final Float32List samples = Float32List(width * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      samples[y * width + x] = value(x, y);
    }
  }
  return LinearRawMosaic(
    width: width,
    height: height,
    cfaPattern: CfaPattern.rggb,
    samples: samples,
  );
}

void main() {
  test('detects a dead site only against its same-CFA-phase flat neighbors',
      () {
    final LinearRawMosaic flat = _flat(11, 11, (int x, int y) {
      if (x == 5 && y == 5) return 0.05;
      if (x.isOdd && y.isOdd) return 1;
      return 100;
    });
    final RawDefectMap result = detectColdPixelsFromMasterFlat(
      flat,
      ratioThreshold: 5,
      absoluteThreshold: 0.1,
    );
    expect(result.points, hasLength(1));
    expect((result.points.single.x, result.points.single.y), (5, 5));
  });

  test('requires both relative and absolute cold thresholds', () {
    final LinearRawMosaic flat = _flat(
      9,
      9,
      (int x, int y) => x == 4 && y == 4 ? 0.19 : 1,
    );
    expect(
      detectColdPixelsFromMasterFlat(
        flat,
        ratioThreshold: 5,
        absoluteThreshold: 0.9,
      ).points,
      isEmpty,
    );
    expect(
      detectColdPixelsFromMasterFlat(
        flat,
        ratioThreshold: 5,
        absoluteThreshold: 0.1,
      ).points,
      hasLength(1),
    );
  });

  test('merges hot and cold maps without duplicate coordinates', () {
    final RawDefectMap merged = mergeRawDefectMaps(<RawDefectMap>[
      RawDefectMap(
        const <RawDefectPoint>[
          RawDefectPoint(x: 1, y: 2),
          RawDefectPoint(x: 3, y: 4),
        ],
      ),
      RawDefectMap(
        const <RawDefectPoint>[
          RawDefectPoint(x: 3, y: 4),
          RawDefectPoint(x: 5, y: 6),
        ],
      ),
    ]);
    expect(merged.points, hasLength(3));
  });

  test('rejects invalid thresholds and non-finite flat samples', () {
    final LinearRawMosaic flat = _flat(5, 5, (_, __) => 1);
    expect(
      () => detectColdPixelsFromMasterFlat(flat, neighborhoodRadius: 0),
      throwsA(isA<InvalidColdPixelDetectionInput>()),
    );
    expect(
      () => detectColdPixelsFromMasterFlat(flat, ratioThreshold: 1),
      throwsA(isA<InvalidColdPixelDetectionInput>()),
    );
    final LinearRawMosaic invalid = _flat(
      5,
      5,
      (int x, int y) => x == 2 && y == 2 ? double.nan : 1,
    );
    expect(
      () => detectColdPixelsFromMasterFlat(invalid),
      throwsStateError,
    );
  });
}
