import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_stack/core/drizzle/cfa_drizzle.dart';
import 'package:mobile_stack/core/drizzle/drizzle_accumulator.dart';
import 'package:mobile_stack/core/drizzle/robust_combine_cfa_drizzle.dart';

/// Dart port of `tool/raw_samples/test/robust_combine_cfa_drizzle_
/// reference.test.mjs`.

CfaDrizzleResult _makeSingleChannelResult(
  List<double> values,
  List<double> coverages,
) {
  return CfaDrizzleResult(
    width: values.length,
    height: 1,
    channels: <DrizzleResult>[
      DrizzleResult(
        width: values.length,
        height: 1,
        value: Float64List.fromList(values),
        coverage: Float64List.fromList(coverages),
      ),
    ],
  );
}

List<CfaDrizzleResult> _perFrameResultsForPixel(
  List<double> perFrameValues,
  List<double> perFrameCoverage,
) {
  return <CfaDrizzleResult>[
    for (int i = 0; i < perFrameValues.length; i++)
      _makeSingleChannelResult(<double>[
        perFrameValues[i]
      ], <double>[
        perFrameCoverage[i],
      ]),
  ];
}

void main() {
  test(
    '宇宙線ヒットのような単発の異常値(1フレームだけ極端に高い)は、'
    '十分な数のフレームが寄与していれば正しく棄却される',
    () {
      final List<double> values = <double>[100, 102, 98, 101, 99, 5000];
      final List<double> coverage = <double>[1, 1, 1, 1, 1, 1];
      final List<CfaDrizzleResult> perFrame = _perFrameResultsForPixel(
        values,
        coverage,
      );
      final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
        perFrame,
      );
      expect((combined.channels[0].value[0] - 100).abs(), lessThan(1e-9));
      expect(combined.channels[0].coverage[0], 5);
    },
  );

  test(
    '寄与フレーム数がminFramesForRejection未満の場合は棄却を一切'
    '行わず、単純な重み付き平均になる',
    () {
      final List<double> values = <double>[100, 102, 5000];
      final List<double> coverage = <double>[1, 1, 1];
      final List<CfaDrizzleResult> perFrame = _perFrameResultsForPixel(
        values,
        coverage,
      );
      final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
        perFrame,
        minFramesForRejection: 4,
      );
      const double expectedMean = (100 + 102 + 5000) / 3;
      expect(
        (combined.channels[0].value[0] - expectedMean).abs(),
        lessThan(1e-9),
      );
      expect(combined.channels[0].coverage[0], 3);
    },
  );

  test(
    '実際の星のように大多数のフレームが同じ値で一致する場合、誤って'
    '棄却されない(sigma=0の安全策の検証も兼ねる)',
    () {
      final List<double> values = <double>[500, 500, 500, 500, 500];
      final List<double> coverage = <double>[1, 1, 1, 1, 1];
      final List<CfaDrizzleResult> perFrame = _perFrameResultsForPixel(
        values,
        coverage,
      );
      final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
        perFrame,
      );
      expect(combined.channels[0].value[0], 500);
      expect(combined.channels[0].coverage[0], 5);
    },
  );

  test(
    'MAD=0でも多数一致から外れる単発の宇宙線ヒットは棄却される',
    () {
      final List<double> values = <double>[500, 500, 500, 500, 5000];
      final List<double> coverage = <double>[1, 1, 1, 1, 1];
      final List<CfaDrizzleResult> perFrame = _perFrameResultsForPixel(
        values,
        coverage,
      );
      final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
        perFrame,
      );
      expect(combined.channels[0].value[0], 500);
      expect(combined.channels[0].coverage[0], 4);
    },
  );

  test(
    'sigmaLow/sigmaHighが非対称に扱われる(同じ大きさの偏差でも上下で'
    '棄却結果が異なりうる)',
    () {
      final List<double> values = <double>[97, 99, 100, 101, 103, 112, 75];
      final List<double> coverage = <double>[1, 1, 1, 1, 1, 1, 1];
      final List<CfaDrizzleResult> perFrame = _perFrameResultsForPixel(
        values,
        coverage,
      );
      final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
        perFrame,
        sigmaLow: 4,
        sigmaHigh: 3,
      );
      const double expectedMean = (97 + 99 + 100 + 101 + 103 + 112) / 6;
      expect(
        (combined.channels[0].value[0] - expectedMean).abs(),
        lessThan(1e-9),
      );
      expect(combined.channels[0].coverage[0], 6);
    },
  );

  test('coverageが不足しているフレームは寄与フレームとして数えられない', () {
    final List<double> values = <double>[100, 102, 98, 9999];
    final List<double> coverage = <double>[1, 1, 1, 0];
    final List<CfaDrizzleResult> perFrame = _perFrameResultsForPixel(
      values,
      coverage,
    );
    final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
      perFrame,
      minFramesForRejection: 4,
    );
    const double expectedMean = (100 + 102 + 98) / 3;
    expect(
      (combined.channels[0].value[0] - expectedMean).abs(),
      lessThan(1e-9),
    );
    expect(combined.channels[0].coverage[0], 3);
  });

  test('どのフレームも寄与していない画素はvalue=0・coverage=0のまま', () {
    final List<CfaDrizzleResult> perFrame = _perFrameResultsForPixel(
      <double>[1, 2, 3],
      <double>[0, 0, 0],
    );
    final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
      perFrame,
    );
    expect(combined.channels[0].value[0], 0);
    expect(combined.channels[0].coverage[0], 0);
  });

  test('複数画素・複数チャンネルでも独立して正しく処理される', () {
    final CfaDrizzleResult frame1 = CfaDrizzleResult(
      width: 2,
      height: 1,
      channels: <DrizzleResult>[
        DrizzleResult(
          width: 2,
          height: 1,
          value: Float64List.fromList(<double>[10, 20]),
          coverage: Float64List.fromList(<double>[1, 1]),
        ),
        DrizzleResult(
          width: 2,
          height: 1,
          value: Float64List.fromList(<double>[30, 40]),
          coverage: Float64List.fromList(<double>[1, 1]),
        ),
      ],
    );
    final CfaDrizzleResult frame2 = CfaDrizzleResult(
      width: 2,
      height: 1,
      channels: <DrizzleResult>[
        DrizzleResult(
          width: 2,
          height: 1,
          value: Float64List.fromList(<double>[12, 22]),
          coverage: Float64List.fromList(<double>[1, 1]),
        ),
        DrizzleResult(
          width: 2,
          height: 1,
          value: Float64List.fromList(<double>[28, 42]),
          coverage: Float64List.fromList(<double>[1, 1]),
        ),
      ],
    );
    final CfaDrizzleResult combined = robustCombineCfaDrizzleResults(
      <CfaDrizzleResult>[frame1, frame2],
    );
    expect((combined.channels[0].value[0] - 11).abs(), lessThan(1e-9));
    expect((combined.channels[0].value[1] - 21).abs(), lessThan(1e-9));
    expect((combined.channels[1].value[0] - 29).abs(), lessThan(1e-9));
    expect((combined.channels[1].value[1] - 41).abs(), lessThan(1e-9));
  });

  test('空の配列はInvalidRobustCombineInputを投げる', () {
    expect(
      () => robustCombineCfaDrizzleResults(const <CfaDrizzleResult>[]),
      throwsA(isA<InvalidRobustCombineInput>()),
    );
  });

  test(
    '寸法が異なるフレーム結果同士はInvalidRobustCombineInputを投げる',
    () {
      final CfaDrizzleResult a = _makeSingleChannelResult(<double>[
        1,
        2,
      ], <double>[
        1,
        1
      ]);
      final CfaDrizzleResult b = CfaDrizzleResult(
        width: 3,
        height: 1,
        channels: a.channels,
      );
      expect(
        () => robustCombineCfaDrizzleResults(<CfaDrizzleResult>[a, b]),
        throwsA(isA<InvalidRobustCombineInput>()),
      );
    },
  );

  test(
    'minFramesForRejectionが2未満だとInvalidRobustCombineInputを投げる',
    () {
      final CfaDrizzleResult a = _makeSingleChannelResult(<double>[
        1,
      ], <double>[
        1
      ]);
      expect(
        () => robustCombineCfaDrizzleResults(
          <CfaDrizzleResult>[a],
          minFramesForRejection: 1,
        ),
        throwsA(isA<InvalidRobustCombineInput>()),
      );
    },
  );
  test('非有限value/coverageと負coverageを拒否する', () {
    CfaDrizzleResult single(double value, double coverage) => CfaDrizzleResult(
          width: 1,
          height: 1,
          channels: <DrizzleResult>[
            DrizzleResult(
              width: 1,
              height: 1,
              value: Float64List.fromList(<double>[value]),
              coverage: Float64List.fromList(<double>[coverage]),
            ),
          ],
        );

    expect(
      () => robustCombineCfaDrizzleResults(<CfaDrizzleResult>[
        single(double.nan, 1),
        single(1, 1),
        single(1, 1),
        single(1, 1),
      ]),
      throwsA(isA<InvalidRobustCombineInput>()),
    );
    expect(
      () => robustCombineCfaDrizzleResults(<CfaDrizzleResult>[
        single(1, double.infinity),
      ]),
      throwsA(isA<InvalidRobustCombineInput>()),
    );
    expect(
      () => robustCombineCfaDrizzleResults(<CfaDrizzleResult>[
        single(1, -1),
      ]),
      throwsA(isA<InvalidRobustCombineInput>()),
    );
  });
}
