import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidGapFillInput,
  fillChannelGaps,
  fillDrizzleResultGaps,
} from '../drizzle_gap_fill_reference.mjs';

function makeChannel(width, height, valueFn, coverageFn) {
  const value = new Float64Array(width * height);
  const coverage = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      value[index] = valueFn(x, y);
      coverage[index] = coverageFn(x, y);
    }
  }
  return { value, coverage };
}

test('十分なcoverageを持つ位置はvalue/coverageともに一切変更されない', () => {
  const channel = makeChannel(
    5,
    5,
    (x, y) => x * 10 + y,
    () => 3,
  );
  const result = fillChannelGaps(channel, 5, 5);
  assert.deepEqual(Array.from(result.value), Array.from(channel.value));
  assert.deepEqual(
    Array.from(result.coverage),
    Array.from(channel.coverage),
  );
});

test('coverage不足の位置は近傍のcoverage加重平均で埋められる', () => {
  // 3x3で、中心(1,1)だけcoverage=0、他8マスはcoverage>=しきい値。
  const channel = makeChannel(
    3,
    3,
    (x, y) => (x === 1 && y === 1 ? 999 : (x + y) * 10),
    (x, y) => (x === 1 && y === 1 ? 0 : 1),
  );
  const result = fillChannelGaps(channel, 3, 3, { kernelRadius: 1 });
  const expectedNeighbors = [];
  for (let ny = 0; ny <= 2; ny++) {
    for (let nx = 0; nx <= 2; nx++) {
      if (nx === 1 && ny === 1) continue;
      expectedNeighbors.push((nx + ny) * 10);
    }
  }
  const expectedAverage = expectedNeighbors.reduce((a, b) => a + b, 0)
    / expectedNeighbors.length;
  assert.ok(
    Math.abs(result.value[1 * 3 + 1] - expectedAverage) < 1e-9,
    `expected ${expectedAverage}, got ${result.value[4]}`,
  );
  assert.equal(result.coverage[1 * 3 + 1], 0); // 補間値はdirect source coverageを持たない
});

test(
  'coverageが高い近傍ほど埋め値への寄与が大きい(加重平均であることの'
  + '確認)',
  () => {
    // 中心はギャップ。左隣はvalue=0・coverage=1(弱い)、右隣は
    // value=100・coverage=9(強い)。単純平均なら50だが、加重平均なら
    // 100寄りになるはず。
    const width = 3;
    const height = 1;
    const value = new Float64Array([0, 0, 100]);
    const coverage = new Float64Array([1, 0, 9]);
    const result = fillChannelGaps({ value, coverage }, width, height, {
      kernelRadius: 1,
    });
    // (0*1 + 100*9) / (1+9) = 900/10 = 90。
    assert.ok(Math.abs(result.value[1] - 90) < 1e-9);
    assert.equal(result.coverage[1], 0);
  },
);

test(
  'kernelRadius内に十分なcoverageの近傍が無い場合はvalue/coverageとも'
  + '0のまま',
  () => {
    const channel = makeChannel(5, 5, () => 999, () => 0);
    const result = fillChannelGaps(channel, 5, 5, { kernelRadius: 1 });
    assert.ok(Array.from(result.value).every((v) => v === 0));
    assert.ok(Array.from(result.coverage).every((v) => v === 0));
  },
);

test(
  '端・角の位置はkernelRadiusを画像範囲内にクリップして処理する'
  + '(クラッシュしない)',
  () => {
    const channel = makeChannel(
      4,
      4,
      (x, y) => x + y,
      (x, y) => (x === 0 && y === 0 ? 0 : 1),
    );
    const result = fillChannelGaps(channel, 4, 4, { kernelRadius: 2 });
    assert.ok(Number.isFinite(result.value[0]));
    assert.equal(result.coverage[0], 0);
  },
);

test('minimumCoverageのしきい値で「十分なcoverage」の境界を制御できる', () => {
  const channel = makeChannel(
    3,
    3,
    () => 50,
    (x, y) => (x === 1 && y === 1 ? 0.5 : 1),
  );
  const strict = fillChannelGaps(channel, 3, 3, { minimumCoverage: 1 });
  const lenient = fillChannelGaps(channel, 3, 3, { minimumCoverage: 0.1 });
  // strict: 中心(coverage=0.5)はしきい値未満なので近傍から埋められる。
  // 値は補間されるが、direct source coverageは新規生成しない。
  assert.equal(strict.coverage[1 * 3 + 1], 0);
  // lenient: 中心のcoverage=0.5はしきい値0.1以上なので、自身の値が
  // そのまま通過する(coverage=0.5のまま)。
  assert.equal(lenient.coverage[1 * 3 + 1], 0.5);
});


test('補間値は作ってもsource coverageを新規生成・再伝播しない', () => {
  const width = 5;
  const height = 1;
  const value = new Float64Array([100, 0, 0, 0, 0]);
  const coverage = new Float64Array([1, 0, 0, 0, 0]);
  const result = fillChannelGaps({ value, coverage }, width, height, {
    kernelRadius: 1,
  });
  assert.equal(result.value[1], 100);
  assert.equal(result.coverage[1], 0);
  // The fill pass must use original source coverage, never the synthetic x=1
  // value as a new source that can spread detail farther into the gap.
  assert.equal(result.value[2], 0);
  assert.equal(result.coverage[2], 0);
});

test('fillDrizzleResultGapsは各チャンネルを独立に(混ぜずに)埋める', () => {
  // 赤チャンネルは中心がギャップだが、緑・青チャンネルの同じ位置に
  // 高い値があっても、赤の埋め結果には一切影響してはいけない。
  const redChannel = makeChannel(
    3,
    3,
    (x, y) => (x === 1 && y === 1 ? 0 : 5),
    (x, y) => (x === 1 && y === 1 ? 0 : 1),
  );
  const greenChannel = makeChannel(3, 3, () => 999, () => 1);
  const blueChannel = makeChannel(3, 3, () => 999, () => 1);
  const result = fillDrizzleResultGaps({
    width: 3,
    height: 3,
    channels: [redChannel, greenChannel, blueChannel],
  });
  // 赤の埋め値は赤自身の近傍(全て5)の平均である5のはずで、緑・青の
  // 999が混ざってはいけない。
  assert.ok(Math.abs(result.channels[0].value[4] - 5) < 1e-9);
});

test('不正な入力を拒否する', () => {
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array(4), coverage: new Float64Array(4) },
      3,
      3,
    ),
    InvalidGapFillInput,
  );
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array(9), coverage: new Float64Array(9) },
      3,
      3,
      { kernelRadius: 0 },
    ),
    InvalidGapFillInput,
  );
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array(9), coverage: new Float64Array(9) },
      3,
      3,
      { minimumCoverage: -1 },
    ),
    InvalidGapFillInput,
  );
  assert.throws(
    () => fillDrizzleResultGaps({ width: 0, height: 3, channels: [] }),
    InvalidGapFillInput,
  );
});


test('gap fill rejects non-finite values, coverage, and minimumCoverage', () => {
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array([NaN]), coverage: new Float64Array([1]) },
      1, 1,
    ),
    /finite values/,
  );
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array([1]), coverage: new Float64Array([Infinity]) },
      1, 1,
    ),
    /finite values/,
  );
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array([1]), coverage: new Float64Array([-1]) },
      1, 1,
    ),
    /finite values/,
  );
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array([1]), coverage: new Float64Array([1]) },
      1, 1, { minimumCoverage: NaN },
    ),
    /finite and positive/,
  );
  assert.throws(
    () => fillChannelGaps(
      { value: new Float64Array([1]), coverage: new Float64Array([0]) },
      1, 1, { minimumCoverage: 0 },
    ),
    /finite and positive/,
  );
});
