import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidRobustCombineInput,
  robustCombineCfaDrizzleResults,
} from '../robust_combine_cfa_drizzle_reference.mjs';

function makeSingleChannelResult(values, coverages) {
  return {
    width: values.length,
    height: 1,
    channels: [
      {
        value: Float64Array.from(values),
        coverage: Float64Array.from(coverages),
      },
    ],
  };
}

function perFrameResultsForPixel(perFrameValues, perFrameCoverage) {
  // 各フレームを、1画素だけの独立したCfaDrizzleResultとして表現する
  // (実運用では画像全体のうち1画素分を切り出したのと等価)。
  return perFrameValues.map(
    (value, i) => makeSingleChannelResult([value], [perFrameCoverage[i]]),
  );
}

test(
  '宇宙線ヒットのような単発の異常値(1フレームだけ極端に高い)は、'
  + '十分な数のフレームが寄与していれば正しく棄却される',
  () => {
    // 手計算で事前検証済み: median=100.5, mad=1.5, sigma≈2.2239,
    // threshold(sigmaHigh=3)≈6.6717。5000の偏差4899.5は明確に超過。
    const values = [100, 102, 98, 101, 99, 5000];
    const coverage = [1, 1, 1, 1, 1, 1];
    const perFrame = perFrameResultsForPixel(values, coverage);
    const combined = robustCombineCfaDrizzleResults(perFrame);
    assert.ok(
      Math.abs(combined.channels[0].value[0] - 100) < 1e-9,
      `expected ~100, got ${combined.channels[0].value[0]}`,
    );
    assert.equal(combined.channels[0].coverage[0], 5); // 5フレーム生存
  },
);

test(
  '寄与フレーム数がminFramesForRejection未満の場合は棄却を一切行わず、'
  + '単純な重み付き平均になる',
  () => {
    const values = [100, 102, 5000];
    const coverage = [1, 1, 1];
    const perFrame = perFrameResultsForPixel(values, coverage);
    const combined = robustCombineCfaDrizzleResults(perFrame, {
      minFramesForRejection: 4,
    });
    const expectedMean = (100 + 102 + 5000) / 3;
    assert.ok(
      Math.abs(combined.channels[0].value[0] - expectedMean) < 1e-9,
    );
    assert.equal(combined.channels[0].coverage[0], 3);
  },
);

test(
  '実際の星のように大多数のフレームが同じ値で一致する場合、誤って'
  + '棄却されない(sigma=0の安全策の検証も兼ねる)',
  () => {
    const values = [500, 500, 500, 500, 500];
    const coverage = [1, 1, 1, 1, 1];
    const perFrame = perFrameResultsForPixel(values, coverage);
    const combined = robustCombineCfaDrizzleResults(perFrame);
    assert.equal(combined.channels[0].value[0], 500);
    assert.equal(combined.channels[0].coverage[0], 5); // 全フレーム生存
  },
);


test(
  'MAD=0でも多数一致から外れる単発の宇宙線ヒットは棄却される',
  () => {
    const values = [500, 500, 500, 500, 5000];
    const coverage = [1, 1, 1, 1, 1];
    const perFrame = perFrameResultsForPixel(values, coverage);
    const combined = robustCombineCfaDrizzleResults(perFrame);
    assert.equal(combined.channels[0].value[0], 500);
    assert.equal(combined.channels[0].coverage[0], 4);
  },
);

test(
  'sigmaLow/sigmaHighが非対称に扱われる(同じ大きさの偏差でも上下で'
  + '棄却結果が異なりうる)',
  () => {
    // 手計算で事前検証済み: median=100, mad=3, sigma≈4.4478。
    // thresholdHigh(sigmaHigh=3)≈13.34 -> +12は生存。
    // thresholdLow(sigmaLow=4)≈17.79 -> -25(絶対偏差25)は棄却。
    const values = [97, 99, 100, 101, 103, 112, 75];
    const coverage = [1, 1, 1, 1, 1, 1, 1];
    const perFrame = perFrameResultsForPixel(values, coverage);
    const combined = robustCombineCfaDrizzleResults(perFrame, {
      sigmaLow: 4,
      sigmaHigh: 3,
    });
    // 75(棄却)を除いた6フレームの重み付き平均になっているはず。
    const expectedMean = (97 + 99 + 100 + 101 + 103 + 112) / 6;
    assert.ok(
      Math.abs(combined.channels[0].value[0] - expectedMean) < 1e-9,
      `expected ~${expectedMean}, got ${combined.channels[0].value[0]}`,
    );
    assert.equal(combined.channels[0].coverage[0], 6);
  },
);

test(
  'coverageが不足しているフレームは寄与フレームとして数えられない',
  () => {
    const values = [100, 102, 98, 9999];
    const coverage = [1, 1, 1, 0]; // 最後のフレームはcoverage=0(未寄与)
    const perFrame = perFrameResultsForPixel(values, coverage);
    const combined = robustCombineCfaDrizzleResults(perFrame, {
      minFramesForRejection: 4,
    });
    // 9999は寄与フレームとして数えられないため、残り3フレームの平均
    // (かつ3<4なので棄却も行われない)になるはず。
    const expectedMean = (100 + 102 + 98) / 3;
    assert.ok(Math.abs(combined.channels[0].value[0] - expectedMean) < 1e-9);
    assert.equal(combined.channels[0].coverage[0], 3);
  },
);

test('どのフレームも寄与していない画素はvalue=0・coverage=0のまま', () => {
  const perFrame = perFrameResultsForPixel([1, 2, 3], [0, 0, 0]);
  const combined = robustCombineCfaDrizzleResults(perFrame);
  assert.equal(combined.channels[0].value[0], 0);
  assert.equal(combined.channels[0].coverage[0], 0);
});

test('複数画素・複数チャンネルでも独立して正しく処理される', () => {
  const frame1 = {
    width: 2,
    height: 1,
    channels: [
      {
        value: Float64Array.from([10, 20]),
        coverage: Float64Array.from([1, 1]),
      },
      {
        value: Float64Array.from([30, 40]),
        coverage: Float64Array.from([1, 1]),
      },
    ],
  };
  const frame2 = {
    width: 2,
    height: 1,
    channels: [
      {
        value: Float64Array.from([12, 22]),
        coverage: Float64Array.from([1, 1]),
      },
      {
        value: Float64Array.from([28, 42]),
        coverage: Float64Array.from([1, 1]),
      },
    ],
  };
  const combined = robustCombineCfaDrizzleResults([frame1, frame2]);
  assert.ok(Math.abs(combined.channels[0].value[0] - 11) < 1e-9);
  assert.ok(Math.abs(combined.channels[0].value[1] - 21) < 1e-9);
  assert.ok(Math.abs(combined.channels[1].value[0] - 29) < 1e-9);
  assert.ok(Math.abs(combined.channels[1].value[1] - 41) < 1e-9);
});

test('空の配列はInvalidRobustCombineInputを投げる', () => {
  assert.throws(
    () => robustCombineCfaDrizzleResults([]),
    InvalidRobustCombineInput,
  );
});

test(
  '寸法が異なるフレーム結果同士はInvalidRobustCombineInputを投げる',
  () => {
    const a = makeSingleChannelResult([1, 2], [1, 1]);
    const b = { width: 3, height: 1, channels: a.channels };
    assert.throws(
      () => robustCombineCfaDrizzleResults([a, b]),
      InvalidRobustCombineInput,
    );
  },
);

test(
  'minFramesForRejectionが2未満だとInvalidRobustCombineInputを投げる',
  () => {
    const a = makeSingleChannelResult([1], [1]);
    assert.throws(
      () => robustCombineCfaDrizzleResults([a], { minFramesForRejection: 1 }),
      InvalidRobustCombineInput,
    );
  },
);


test('robust CFA combine rejects non-finite or sign-invalid thresholds', () => {
  const perFrame = perFrameResultsForPixel([100, 101, 99, 100], [1, 1, 1, 1]);

  assert.throws(
    () => robustCombineCfaDrizzleResults(perFrame, { minCoverage: -1 }),
    /minCoverage/,
  );
  assert.throws(
    () => robustCombineCfaDrizzleResults(perFrame, { minCoverage: Number.NaN }),
    /minCoverage/,
  );
  assert.throws(
    () => robustCombineCfaDrizzleResults(perFrame, { sigmaLow: 0 }),
    /sigmaLow/,
  );
  assert.throws(
    () => robustCombineCfaDrizzleResults(
      perFrame,
      { sigmaHigh: Number.POSITIVE_INFINITY },
    ),
    /sigmaLow/,
  );
});


test('robust CFA combine rejects non-finite scientific values and coverage', () => {
  const good = perFrameResultsForPixel([100, 101, 99, 100], [1, 1, 1, 1]);

  const nanValue = perFrameResultsForPixel(
    [100, Number.NaN, 99, 100],
    [1, 1, 1, 1],
  );
  assert.throws(
    () => robustCombineCfaDrizzleResults(nanValue),
    /values must be finite/,
  );

  const infCoverage = perFrameResultsForPixel(
    [100, 101, 99, 100],
    [1, Number.POSITIVE_INFINITY, 1, 1],
  );
  assert.throws(
    () => robustCombineCfaDrizzleResults(infCoverage),
    /coverage must be finite/,
  );

  const negativeCoverage = perFrameResultsForPixel(
    [100, 101, 99, 100],
    [1, -0.5, 1, 1],
  );
  assert.throws(
    () => robustCombineCfaDrizzleResults(negativeCoverage),
    /coverage must be finite and non-negative/,
  );

  assert.doesNotThrow(() => robustCombineCfaDrizzleResults(good));
});

test('robust CFA combine rejects malformed channel lengths', () => {
  const malformed = {
    width: 2,
    height: 1,
    channels: [{
      value: Float64Array.from([1]),
      coverage: Float64Array.from([1, 1]),
    }],
  };
  assert.throws(
    () => robustCombineCfaDrizzleResults([malformed]),
    /channel lengths/,
  );
});
