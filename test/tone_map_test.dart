import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/color/linear_rgb_color_transform.dart';
import 'package:mobile_stack/core/export/dng_profile_hue_sat_map.dart';
import 'package:mobile_stack/core/export/dng_profile_look_table.dart';
import 'package:mobile_stack/core/export/dng_profile_tone_curve.dart';
import 'package:mobile_stack/core/export/tone_map.dart';

/// Dart port of `tool/raw_samples/test/tone_map_reference.test.mjs`.

void main() {
  test(
      'signed input survives when only a post-profile linear transform is present',
      () {
    final Float32List input = Float32List.fromList(<double>[-0.5, 1, 0]);
    final LinearRgbColorTransform post = LinearRgbColorTransform(
      matrix: const <double>[
        1,
        1,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
      ],
      sourceDescription: 'pre-converted linear RGB',
      destinationDescription: 'linear sRGB',
    );
    final Float32List directlyCombined =
        Float32List.fromList(<double>[0.5, 1, 0]);

    final Uint8List expected8 = toneMapToDisplayRgb(
      directlyCombined,
      applySrgbGamma: false,
    );
    final Uint16List expected16 = toneMapToDisplayRgb16(
      directlyCombined,
      applySrgbGamma: false,
    );
    final Uint8List actual8 = toneMapToDisplayRgb(
      input,
      postProfileColorTransform: post,
      applySrgbGamma: false,
    );
    final Uint16List actual16 = toneMapToDisplayRgb16(
      input,
      postProfileColorTransform: post,
      applySrgbGamma: false,
    );

    expect(actual8, orderedEquals(expected8));
    expect(actual16, orderedEquals(expected16));
  });

  test(
      'signed linear components survive between matrix transforms until the final display boundary',
      () {
    final Float32List input = Float32List.fromList(<double>[1, 0, 0]);
    final LinearRgbColorTransform first = LinearRgbColorTransform(
      matrix: const <double>[
        -0.5,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
      ],
      sourceDescription: 'test source',
      destinationDescription: 'test intermediate',
    );
    final LinearRgbColorTransform second = LinearRgbColorTransform(
      matrix: const <double>[
        1,
        1,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
      ],
      sourceDescription: 'test intermediate',
      destinationDescription: 'linear sRGB',
    );
    final Float32List directlyCombined =
        Float32List.fromList(<double>[0.5, 1, 0]);

    final Uint8List expected8 = toneMapToDisplayRgb(
      directlyCombined,
      applySrgbGamma: false,
    );
    final Uint16List expected16 = toneMapToDisplayRgb16(
      directlyCombined,
      applySrgbGamma: false,
    );
    final Uint8List actual8 = toneMapToDisplayRgb(
      input,
      linearColorTransform: first,
      postProfileColorTransform: second,
      applySrgbGamma: false,
    );
    final Uint16List actual16 = toneMapToDisplayRgb16(
      input,
      linearColorTransform: first,
      postProfileColorTransform: second,
      applySrgbGamma: false,
    );

    expect(actual8, orderedEquals(expected8));
    expect(actual16, orderedEquals(expected16));
  });

  test('linear color transform is applied before any DNG profile operation',
      () {
    final Float32List input = Float32List.fromList(<double>[0.2, 0.4, 0.6]);
    final LinearRgbColorTransform transform = LinearRgbColorTransform(
      matrix: const <double>[
        0,
        1,
        0,
        0,
        0,
        1,
        1,
        0,
        0,
      ],
    );
    final Uint8List transformed = toneMapToDisplayRgb(
      input,
      linearColorTransform: transform,
      exposureScale: 1,
      whitePoint: 1,
      applySrgbGamma: false,
    );
    final Uint8List expected = toneMapToDisplayRgb(
      Float32List.fromList(<double>[0.4, 0.6, 0.2]),
      exposureScale: 1,
      whitePoint: 1,
      applySrgbGamma: false,
    );
    expect(transformed, orderedEquals(expected));
    expect(
      input,
      orderedEquals(Float32List.fromList(<double>[0.2, 0.4, 0.6])),
    );
  });

  test('render order is transform then HueSatMap then EV then LookTable', () {
    final Float32List input = Float32List.fromList(<double>[0.25, 0, 0]);
    final LinearRgbColorTransform transform = LinearRgbColorTransform(
      matrix: const <double>[
        0,
        0,
        1,
        1,
        0,
        0,
        0,
        1,
        0,
      ],
    );
    final DngProfileHueSatMap hue = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[0, 1, 1, 120, 1, 1],
    );
    final DngProfileLookTable look = DngProfileLookTable(
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
        120,
        1,
        1,
      ],
    );

    final Float64List stage1 = Float64List(3);
    transform.transformPixel(0.25, 0, 0, stage1);
    final Float64List stage2 = Float64List(3);
    hue.transformPixel(stage1[0], stage1[1], stage1[2], stage2);
    for (int i = 0; i < 3; i++) {
      stage2[i] *= 2;
    }
    final Float64List stage3 = Float64List(3);
    look.transformPixel(stage2[0], stage2[1], stage2[2], stage3);
    final Uint8List expected = toneMapToDisplayRgb(
      Float32List.fromList(stage3),
      applySrgbGamma: false,
    );
    final Uint8List actual = toneMapToDisplayRgb(
      input,
      linearColorTransform: transform,
      profileHueSatMap: hue,
      baselineExposureEv: 1,
      profileLookTable: look,
      applySrgbGamma: false,
    );
    expect(actual, orderedEquals(expected));
  });

  test('linear transform rejects malformed RGB triples', () {
    final LinearRgbColorTransform transform =
        LinearRgbColorTransform.identity();
    expect(
      () => toneMapToDisplayRgb(
        Float32List.fromList(<double>[0.1, 0.2]),
        linearColorTransform: transform,
      ),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => toneMapToDisplayRgb16(
        Float32List.fromList(<double>[0.1, 0.2]),
        linearColorTransform: transform,
      ),
      throwsA(isA<InvalidToneMapInput>()),
    );
  });

  test('profiled 8/16-bit paths agree within quantization', () {
    final Float32List input = Float32List.fromList(<double>[0.2, 0.4, 0.6]);
    final LinearRgbColorTransform transform = LinearRgbColorTransform(
      matrix: const <double>[1, 0.1, 0, 0, 1, 0, 0, 0.1, 1],
    );
    final Uint8List rgb8 = toneMapToDisplayRgb(
      input,
      linearColorTransform: transform,
      baselineExposureEv: 0.5,
    );
    final Uint16List rgb16 = toneMapToDisplayRgb16(
      input,
      linearColorTransform: transform,
      baselineExposureEv: 0.5,
    );
    for (int i = 0; i < 3; i++) {
      expect((rgb16[i] / 257 - rgb8[i]).abs(), lessThanOrEqualTo(1));
    }
  });
  test('DNG hue/sat map runs before exposure and final profile tone curve', () {
    final Float32List input = Float32List.fromList(<double>[1, 0, 0]);
    final DngProfileHueSatMap map = DngProfileHueSatMap(
      hueDivisions: 1,
      saturationDivisions: 2,
      valueDivisions: 1,
      encoding: 0,
      deltas: const <double>[0, 1, 1, 120, 1, 1],
    );
    final Uint8List display = toneMapToDisplayRgb(
      input,
      applySrgbGamma: false,
      profileHueSatMap: map,
    );
    expect(display[0], 0);
    expect(display[1], closeTo(230, 1));
    expect(display[2], 0);
    expect(input, orderedEquals(<double>[1, 0, 0]));
  });

  test('DNG look table runs after exposure and before HDR tone compression',
      () {
    final Float32List input = Float32List.fromList(<double>[0.25, 0, 0]);
    final DngProfileLookTable table = DngProfileLookTable(
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
        120,
        1,
        1,
      ],
    );
    final Float64List looked = Float64List(3);
    table.transformPixel(0.5, 0, 0, looked);
    final Uint8List expected = toneMapToDisplayRgb(
      Float32List.fromList(looked),
      applySrgbGamma: false,
    );
    final Uint8List actual = toneMapToDisplayRgb(
      input,
      exposureScale: 2,
      applySrgbGamma: false,
      profileLookTable: table,
    );
    expect(actual, orderedEquals(expected));
    expect(actual[1], greaterThan(0));
    expect(input, orderedEquals(<double>[0.25, 0, 0]));
  });

  test('baseline exposure EV is a power-of-two gain in 8 and 16 bit output',
      () {
    final Float32List quarter =
        Float32List.fromList(<double>[0.25, 0.125, 0.0625]);
    final Float32List half = Float32List.fromList(<double>[0.5, 0.25, 0.125]);
    expect(
      toneMapToDisplayRgb(quarter, baselineExposureEv: 1),
      orderedEquals(toneMapToDisplayRgb(half)),
    );
    expect(
      toneMapToDisplayRgb16(quarter, baselineExposureEv: 1),
      orderedEquals(toneMapToDisplayRgb16(half)),
    );
  });

  test('baseline exposure EV is applied before the DNG look table', () {
    final Float32List input = Float32List.fromList(<double>[0.25, 0, 0]);
    final DngProfileLookTable table = DngProfileLookTable(
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
        120,
        1,
        1,
      ],
    );
    final Float64List looked = Float64List(3);
    table.transformPixel(0.5, 0, 0, looked);
    final Uint8List expected = toneMapToDisplayRgb(
      Float32List.fromList(looked),
      applySrgbGamma: false,
    );
    final Uint8List actual = toneMapToDisplayRgb(
      input,
      baselineExposureEv: 1,
      applySrgbGamma: false,
      profileLookTable: table,
    );
    expect(actual, orderedEquals(expected));
  });

  test('DNG profile curve is applied in linear gamma before display tone map',
      () {
    final Float32List input = Float32List.fromList(<double>[0.5, 0.5, 0.5]);
    final DngProfileToneCurve curve = DngProfileToneCurve.fromInterleaved(
      const <double>[0, 0, 0.5, 0.25, 1, 1],
    );
    final Uint8List baseline = toneMapToDisplayRgb(
      input,
      applySrgbGamma: false,
    );
    final Uint8List profiled = toneMapToDisplayRgb(
      input,
      applySrgbGamma: false,
      profileToneCurve: curve,
    );
    final Uint16List profiled16 = toneMapToDisplayRgb16(
      input,
      applySrgbGamma: false,
      profileToneCurve: curve,
    );
    final Uint8List expectedProfiled = toneMapToDisplayRgb(
      Float32List.fromList(<double>[0.25, 0.25, 0.25]),
      applySrgbGamma: false,
    );
    final Uint16List expectedProfiled16 = toneMapToDisplayRgb16(
      Float32List.fromList(<double>[0.25, 0.25, 0.25]),
      applySrgbGamma: false,
    );
    expect(profiled, orderedEquals(expectedProfiled));
    expect(profiled16, orderedEquals(expectedProfiled16));
    expect(profiled[0], lessThan(baseline[0]));
    expect(input, orderedEquals(<double>[0.5, 0.5, 0.5]));
  });

  test('16-bit tone mapping preserves the same curve with finer quantization',
      () {
    final Float32List input = Float32List.fromList(<double>[0, 0.1, 1]);
    final Uint8List rgb8 = toneMapToDisplayRgb(input);
    final Uint16List rgb16 = toneMapToDisplayRgb16(input);
    expect(rgb16[0], 0);
    for (int index = 0; index < input.length; index++) {
      expect((rgb16[index] / 257 - rgb8[index]).abs(), lessThanOrEqualTo(1));
    }
    expect(rgb16[1], greaterThan(rgb8[1] * 257 - 257));
  });

  test('srgbEncode/srgbDecode round-trip across the full range', () {
    for (int i = 0; i <= 100; i++) {
      final double value = i / 100;
      final double roundTrip = srgbDecode(srgbEncode(value));
      expect((roundTrip - value).abs(), lessThan(1e-9));
    }
  });

  test('srgbEncode matches known reference values', () {
    expect(srgbEncode(0), 0);
    expect((srgbEncode(1) - 1).abs(), lessThan(1e-9));
    expect((srgbEncode(0.18) - 0.4613).abs(), lessThan(0.001));
  });

  test('srgbEncode is continuous at the linear/power-curve breakpoint', () {
    const double epsilon = 1e-9;
    final double justBelow = srgbEncode(0.0031308 - epsilon);
    final double justAbove = srgbEncode(0.0031308 + epsilon);
    expect((justBelow - justAbove).abs(), lessThan(1e-6));
  });

  test('srgbEncode clamps out-of-range input rather than producing NaN', () {
    expect(srgbEncode(-5), 0);
    expect((srgbEncode(5) - 1).abs(), lessThan(1e-9));
  });

  test('the tone curve is monotonically non-decreasing across a huge range',
      () {
    const double whitePoint = 2.0;
    double previous = double.negativeInfinity;
    for (double exponent = -6; exponent <= 6; exponent += 0.1) {
      final double value = math.pow(10, exponent).toDouble();
      final Float32List rgb =
          Float32List.fromList(<double>[value, value, value]);
      final Uint8List mapped = toneMapToDisplayRgb(
        rgb,
        whitePoint: whitePoint,
        applySrgbGamma: false,
      );
      expect(mapped[0], greaterThanOrEqualTo(previous));
      previous = mapped[0].toDouble();
    }
  });

  test('zero input maps to exactly zero output', () {
    final Float32List rgb = Float32List.fromList(<double>[0, 0, 0]);
    final Uint8List mapped = toneMapToDisplayRgb(rgb, whitePoint: 1);
    expect(mapped, orderedEquals(<int>[0, 0, 0]));
  });

  test(
    'a value far beyond the white point approaches but never reaches '
    'or exceeds full saturation (no overflow, no runaway growth, and '
    'no premature saturation well below the white point)',
    () {
      const double whitePoint = 1.0;
      final Uint8List atMappedList = toneMapToDisplayRgb(
        Float32List.fromList(<double>[whitePoint, 0, 0]),
        whitePoint: whitePoint,
        applySrgbGamma: false,
      );
      final Uint8List farMappedList = toneMapToDisplayRgb(
        Float32List.fromList(<double>[whitePoint * 1000, 0, 0]),
        whitePoint: whitePoint,
        applySrgbGamma: false,
      );
      final int atMapped = atMappedList[0];
      final int farMapped = farMappedList[0];
      // By design (rate = ln(10)), value == whitePoint reaches ~90% of
      // full scale, not 100% -- deliberate headroom for a genuinely
      // brighter value to still be distinguishable above it.
      expect(atMapped, inInclusiveRange(220, 239));
      expect(farMapped, greaterThanOrEqualTo(atMapped));
      expect(farMapped, lessThanOrEqualTo(255));

      final Uint8List halfMappedList = toneMapToDisplayRgb(
        Float32List.fromList(<double>[whitePoint * 0.5, 0, 0]),
        whitePoint: whitePoint,
        applySrgbGamma: false,
      );
      expect(halfMappedList[0], lessThan(200));
    },
  );

  test('a higher white point compresses a given bright value less', () {
    final Float32List brightValue = Float32List.fromList(<double>[5, 0, 0]);
    final int lowWhitePoint = toneMapToDisplayRgb(
      brightValue,
      whitePoint: 2,
      applySrgbGamma: false,
    )[0];
    final int highWhitePoint = toneMapToDisplayRgb(
      brightValue,
      whitePoint: 20,
      applySrgbGamma: false,
    )[0];
    expect(highWhitePoint, lessThan(lowWhitePoint));
  });

  test('rejects a non-positive whitePoint', () {
    final Float32List rgb = Float32List.fromList(<double>[1, 1, 1]);
    expect(
      () => toneMapToDisplayRgb(rgb, whitePoint: 0),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => toneMapToDisplayRgb(rgb, whitePoint: -1),
      throwsA(isA<InvalidToneMapInput>()),
    );
  });

  test(
    'negative and non-finite input samples are treated as zero, not NaN',
    () {
      final Float32List rgb = Float32List.fromList(
        <double>[-3, double.nan, double.infinity],
      );
      final Uint8List mapped = toneMapToDisplayRgb(
        rgb,
        whitePoint: 1,
        applySrgbGamma: false,
      );
      expect(mapped[0], 0);
      expect(mapped[1], 0);
      expect(mapped[2], lessThanOrEqualTo(255));
    },
  );

  test(
    'estimateAutoToneParameters centers a synthetic sky background near '
    'targetMedian',
    () {
      const int backgroundCount = 1000;
      const int starCount = 5;
      final Float32List rgb = Float32List((backgroundCount + starCount) * 3);
      for (int i = 0; i < backgroundCount; i++) {
        rgb[i * 3] = 0.002;
        rgb[i * 3 + 1] = 0.002;
        rgb[i * 3 + 2] = 0.002;
      }
      for (int i = 0; i < starCount; i++) {
        final int index = backgroundCount + i;
        rgb[index * 3] = 50;
        rgb[index * 3 + 1] = 50;
        rgb[index * 3 + 2] = 50;
      }
      final AutoToneParameters result = estimateAutoToneParameters(
        rgb,
        targetMedian: 0.06,
      );
      final double scaledBackground = 0.002 * result.exposureScale;
      expect((scaledBackground - 0.06).abs(), lessThan(0.005));
      expect(result.whitePoint, greaterThan(1));
    },
  );

  test('estimateAutoToneParameters honors custom luminance weights', () {
    final Float32List rgb = Float32List.fromList(<double>[
      0.1,
      0.9,
      0.2,
      0.1,
      0.9,
      0.2,
      10,
      0,
      0,
    ]);
    final AutoToneParameters redOnly = estimateAutoToneParameters(
      rgb,
      targetMedian: 0.05,
      luminanceWeights: const <double>[1, 0, 0],
    );
    final AutoToneParameters greenOnly = estimateAutoToneParameters(
      rgb,
      targetMedian: 0.05,
      luminanceWeights: const <double>[0, 1, 0],
    );
    expect((redOnly.exposureScale - 0.5).abs(), lessThan(1e-6));
    expect(
      (greenOnly.exposureScale - (0.05 / 0.9)).abs(),
      lessThan(1e-6),
    );
    expect(redOnly.exposureScale, greaterThan(greenOnly.exposureScale));
  });

  test(
    'estimateAutoToneParameters preserves signed residuals until after the luminance dot product',
    () {
      final Float32List rgb = Float32List.fromList(<double>[
        -0.05,
        0.10,
        0.00,
        -0.05,
        0.10,
        0.00,
        1.00,
        0.00,
        0.00,
      ]);
      final AutoToneParameters result = estimateAutoToneParameters(
        rgb,
        targetMedian: 0.05,
        luminanceWeights: const <double>[0.5, 0.5, 0],
      );
      // Signed dot product: 0.5 * -0.05 + 0.5 * 0.10 = 0.025,
      // so the requested 0.05 median needs exactly 2x exposure.
      expect((result.exposureScale - 2).abs(), lessThan(1e-6));
    },
  );

  test('estimateAutoToneParameters rejects invalid luminance weights', () {
    final Float32List rgb = Float32List.fromList(<double>[0.1, 0.2, 0.3]);
    expect(
      () => estimateAutoToneParameters(
        rgb,
        luminanceWeights: const <double>[1, 0],
      ),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => estimateAutoToneParameters(
        rgb,
        luminanceWeights: const <double>[1, double.nan, 0],
      ),
      throwsA(isA<InvalidToneMapInput>()),
    );
  });

  test(
    'estimateAutoToneParameters handles an all-zero image without '
    'producing non-finite output',
    () {
      final Float32List rgb = Float32List(300);
      final AutoToneParameters result = estimateAutoToneParameters(rgb);
      expect(result.exposureScale.isFinite, isTrue);
      expect(result.whitePoint.isFinite, isTrue);
      expect(result.whitePoint, greaterThan(0));
    },
  );

  test('estimateAutoToneParameters rejects malformed input', () {
    expect(
      () => estimateAutoToneParameters(Float32List(4)),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => estimateAutoToneParameters(Float32List(0)),
      throwsA(isA<InvalidToneMapInput>()),
    );
  });

  test('auto tone sanitizes non-finite and negative image samples', () {
    final AutoToneParameters result = estimateAutoToneParameters(
      Float32List.fromList(<double>[
        double.nan,
        double.infinity,
        -1,
        0.1,
        0.1,
        0.1,
      ]),
    );
    expect(result.exposureScale.isFinite, isTrue);
    expect(result.whitePoint.isFinite, isTrue);
    expect(result.whitePoint, greaterThan(0));
  });

  test('tone-map entry points reject unsafe numeric parameters', () {
    final Float32List rgb = Float32List.fromList(<double>[1, 1, 1]);
    for (final double whitePoint in <double>[double.nan, double.infinity]) {
      expect(
        () => toneMapToDisplayRgb(rgb, whitePoint: whitePoint),
        throwsA(isA<InvalidToneMapInput>()),
      );
      expect(
        () => toneMapToDisplayRgb16(rgb, whitePoint: whitePoint),
        throwsA(isA<InvalidToneMapInput>()),
      );
    }
    expect(
      () => toneMapToDisplayRgb(rgb, exposureScale: -1),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => toneMapToDisplayRgb16(rgb, exposureScale: -1),
      throwsA(isA<InvalidToneMapInput>()),
    );
    for (final double baselineExposureEv in <double>[
      -33,
      33,
      double.nan,
      double.infinity,
    ]) {
      expect(
        () => toneMapToDisplayRgb(
          rgb,
          baselineExposureEv: baselineExposureEv,
        ),
        throwsA(isA<InvalidToneMapInput>()),
      );
      expect(
        () => toneMapToDisplayRgb16(
          rgb,
          baselineExposureEv: baselineExposureEv,
        ),
        throwsA(isA<InvalidToneMapInput>()),
      );
    }
    expect(
      () => toneMapToDisplayRgb(
        rgb,
        exposureScale: double.maxFinite,
        baselineExposureEv: 32,
      ),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => estimateAutoToneParameters(rgb, targetMedian: double.nan),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => estimateAutoToneParameters(
        rgb,
        highlightPercentile: double.nan,
      ),
      throwsA(isA<InvalidToneMapInput>()),
    );
  });

  test(
    'end-to-end: a synthetic star field with a realistic dynamic range '
    'auto-exposes to a plausible image',
    () {
      const int width = 20;
      const int height = 20;
      final Float32List rgb = Float32List(width * height * 3);
      for (int i = 0; i < width * height; i++) {
        rgb[i * 3] = 0.015;
        rgb[i * 3 + 1] = 0.02;
        rgb[i * 3 + 2] = 0.03;
      }
      const List<int> starPixels = <int>[10, 50, 120, 300];
      const List<double> starValues = <double>[0.3, 1.2, 3.0, 6.0];
      for (int i = 0; i < starPixels.length; i++) {
        final int base = starPixels[i] * 3;
        rgb[base] = starValues[i];
        rgb[base + 1] = starValues[i];
        rgb[base + 2] = starValues[i];
      }
      final AutoToneParameters params = estimateAutoToneParameters(rgb);
      final Uint8List display = toneMapToDisplayRgb(
        rgb,
        exposureScale: params.exposureScale,
        whitePoint: params.whitePoint,
      );

      final int backgroundIndex = 5 * 3;
      expect(display[backgroundIndex], greaterThan(0));
      expect(display[backgroundIndex], lessThan(60));

      final int dimStarValue = display[starPixels[1] * 3];
      final int brightStarValue = display[starPixels[3] * 3];
      expect(brightStarValue, greaterThan(dimStarValue));
      expect(dimStarValue, lessThan(250));
    },
  );

  test(
    'documented residual limitation: an extreme single outlier keeps '
    'the background visible via the white-point cap, at the cost of '
    'highlight distinguishability at that same extreme range',
    () {
      const int width = 20;
      const int height = 20;
      final Float32List rgb = Float32List(width * height * 3);
      for (int i = 0; i < width * height; i++) {
        rgb[i * 3] = 0.003;
        rgb[i * 3 + 1] = 0.004;
        rgb[i * 3 + 2] = 0.006;
      }
      final int base = 300 * 3;
      rgb[base] = 400;
      rgb[base + 1] = 400;
      rgb[base + 2] = 400;

      final AutoToneParameters params = estimateAutoToneParameters(rgb);
      final Uint8List display = toneMapToDisplayRgb(
        rgb,
        exposureScale: params.exposureScale,
        whitePoint: params.whitePoint,
      );
      final int backgroundIndex = 5 * 3;
      expect(display[backgroundIndex], greaterThan(0));
      expect(display[base], greaterThan(display[backgroundIndex]));
    },
  );

  test('BaselineExposure compensation preserves auto-tone effective exposure',
      () {
    const AutoToneParameters auto = AutoToneParameters(
      exposureScale: 12.5,
      whitePoint: 3.25,
    );
    final AutoToneParameters plusOne =
        compensateAutoToneForBaselineExposure(auto, 1);
    expect((plusOne.exposureScale * 2 - auto.exposureScale).abs(),
        lessThan(1e-12));
    expect(plusOne.whitePoint, auto.whitePoint);

    final AutoToneParameters minusTwo =
        compensateAutoToneForBaselineExposure(auto, -2);
    expect(
      (minusTwo.exposureScale * math.pow(2, -2) - auto.exposureScale).abs(),
      lessThan(1e-12),
    );
    expect(minusTwo.whitePoint, auto.whitePoint);
  });

  test('BaselineExposure compensation rejects invalid EV', () {
    const AutoToneParameters auto = AutoToneParameters(
      exposureScale: 1,
      whitePoint: 1,
    );
    expect(
      () => compensateAutoToneForBaselineExposure(auto, double.nan),
      throwsA(isA<InvalidToneMapInput>()),
    );
    expect(
      () => compensateAutoToneForBaselineExposure(auto, 33),
      throwsA(isA<InvalidToneMapInput>()),
    );
  });
}
