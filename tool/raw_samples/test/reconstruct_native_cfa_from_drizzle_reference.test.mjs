import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidCfaReconstructionInput,
  reconstructNativeCfaMosaicFromDrizzle,
} from '../reconstruct_native_cfa_from_drizzle_reference.mjs';

// fillChannelGapsの本物の実装を再利用する(このモジュール自身の
// ギャップ埋め契約を変えていないことも間接的に検証できる)。
import { fillChannelGaps } from '../drizzle_gap_fill_reference.mjs';

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

test(
  '各画素で、参照CFAパターンが定めるネイティブ位相のチャンネル値だけが'
  + '採用される',
  () => {
    const width = 4;
    const height = 4;
    // 3チャンネルとも全画素で十分なcoverageを持ち、チャンネルごとに
    // 全く異なる一様値(10, 20, 30)にしておく。rggbの場合、
    // (0,0)=RED(10), (1,0)=GREEN(20), (0,1)=GREEN(20), (1,1)=BLUE(30)
    // となるはず。
    const channels = [
      makeChannel(width, height, () => 10, () => 1), // red
      makeChannel(width, height, () => 20, () => 1), // green
      makeChannel(width, height, () => 30, () => 1), // blue
    ];
    const result = reconstructNativeCfaMosaicFromDrizzle(
      { width, height, channels },
      'rggb',
      1,
      fillChannelGaps,
    );
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.equal(result.cfaPattern, 'rggb');
    assert.equal(result.samples[0 * width + 0], 10); // RED位相
    assert.equal(result.samples[0 * width + 1], 20); // GREEN位相
    assert.equal(result.samples[1 * width + 0], 20); // GREEN位相
    assert.equal(result.samples[1 * width + 1], 30); // BLUE位相
  },
);

test(
  '他チャンネルの値が混入しない(全チャンネルに極端に異なる値を仕込んで'
  + '確認)',
  () => {
    const width = 6;
    const height = 6;
    // 各チャンネルに、位置に依存する一意な識別子を埋め込む。
    const channels = [
      makeChannel(width, height, (x, y) => 1000 + x * 10 + y, () => 1),
      makeChannel(width, height, (x, y) => 2000 + x * 10 + y, () => 1),
      makeChannel(width, height, (x, y) => 3000 + x * 10 + y, () => 1),
    ];
    const result = reconstructNativeCfaMosaicFromDrizzle(
      { width, height, channels },
      'bggr',
      1,
      fillChannelGaps,
    );
    // bggrで(0,0)はBLUE(チャンネル索引2)のはず。
    const expectedChannelAt00 = 3000; // blue channel base
    assert.equal(result.samples[0], expectedChannelAt00 + 0 * 10 + 0);
  },
);

test(
  'ネイティブ位相チャンネルのcoverageが不足している画素は、同じ'
  + 'チャンネルの近傍から(他チャンネルを混ぜずに)ギャップ埋めされる',
  () => {
    const width = 5;
    const height = 5;
    // (2,2)はrggbでx=2偶数,y=2偶数 -> RED位相。RED(索引0)チャンネル
    // だけ、(2,2)のcoverageを0にし、近傍は十分なcoverageを持たせる。
    const redChannel = makeChannel(
      width,
      height,
      (x, y) => {
        if (x === 2 && y === 2) return 999; // coverage=0なので未使用
        return 50;
      },
      (x, y) => (x === 2 && y === 2 ? 0 : 1),
    );
    const channels = [
      redChannel,
      makeChannel(width, height, () => 999999, () => 1), // 混ざってはいけない
      makeChannel(width, height, () => 888888, () => 1), // 混ざってはいけない
    ];
    const result = reconstructNativeCfaMosaicFromDrizzle(
      { width, height, channels },
      'rggb',
      1,
      fillChannelGaps,
    );
    assert.equal(result.samples[2 * width + 2], 50); // 同じREDチャンネルの近傍平均
  },
);

test('outputScaleが1以外だとInvalidCfaReconstructionInputを投げる', () => {
  const width = 2;
  const height = 2;
  const channels = [
    makeChannel(width, height, () => 1, () => 1),
    makeChannel(width, height, () => 1, () => 1),
    makeChannel(width, height, () => 1, () => 1),
  ];
  assert.throws(
    () => reconstructNativeCfaMosaicFromDrizzle(
      { width, height, channels },
      'rggb',
      2,
      fillChannelGaps,
    ),
    InvalidCfaReconstructionInput,
  );
});

test('チャンネル数が3でない場合はInvalidCfaReconstructionInputを投げる', () => {
  const width = 2;
  const height = 2;
  assert.throws(
    () => reconstructNativeCfaMosaicFromDrizzle(
      {
        width,
        height,
        channels: [makeChannel(width, height, () => 1, () => 1)],
      },
      'rggb',
      1,
      fillChannelGaps,
    ),
    InvalidCfaReconstructionInput,
  );
});

test('4種類のCFAパターン全てで正しくチャンネルが選ばれる', () => {
  const width = 2;
  const height = 2;
  const channels = [
    makeChannel(width, height, () => 100, () => 1),
    makeChannel(width, height, () => 200, () => 1),
    makeChannel(width, height, () => 300, () => 1),
  ];
  const expectations = {
    rggb: [100, 200, 200, 300], // (0,0)(1,0)(0,1)(1,1)
    bggr: [300, 200, 200, 100],
    grbg: [200, 100, 300, 200],
    gbrg: [200, 300, 100, 200],
  };
  for (const [pattern, expected] of Object.entries(expectations)) {
    const result = reconstructNativeCfaMosaicFromDrizzle(
      { width, height, channels },
      pattern,
      1,
      fillChannelGaps,
    );
    assert.deepEqual(
      Array.from(result.samples),
      expected,
      `pattern=${pattern}`,
    );
  }
});
