import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidDarkFrameInput,
  computeMasterDark,
  subtractDarkFrame,
} from '../dark_frame_subtraction_reference.mjs';

function makeMosaic(width, height, cfaPattern, fill) {
  const samples = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      samples[y * width + x] = fill(x, y);
    }
  }
  return {
    width, height, cfaPattern, samples,
  };
}

test('単一ダークフレームのマスターダークはそのフレーム自身と一致する', () => {
  const dark = makeMosaic(3, 3, 'rggb', (x, y) => x + y * 10);
  const master = computeMasterDark([dark]);
  assert.deepEqual(Array.from(master.samples), Array.from(dark.samples));
});

test('奇数枚では中央値がそのまま採用される', () => {
  const darks = [
    makeMosaic(2, 2, 'rggb', () => 10),
    makeMosaic(2, 2, 'rggb', () => 20),
    makeMosaic(2, 2, 'rggb', () => 30),
  ];
  const master = computeMasterDark(darks);
  assert.ok(Array.from(master.samples).every((v) => v === 20));
});

test('偶数枚では中央2値の平均になる', () => {
  const darks = [
    makeMosaic(2, 2, 'rggb', () => 10),
    makeMosaic(2, 2, 'rggb', () => 20),
    makeMosaic(2, 2, 'rggb', () => 30),
    makeMosaic(2, 2, 'rggb', () => 40),
  ];
  const master = computeMasterDark(darks);
  assert.ok(Array.from(master.samples).every((v) => v === 25)); // (20+30)/2
});

test(
  '中央値は宇宙線ヒットのような外れ値スパイクを平均より頑健に無視する'
  + '(この設計選択そのものの検証)',
  () => {
    // 5枚のダークフレーム。ある1画素だけ、1枚に極端なスパイク(宇宙線
    // ヒットを模擬)が入っている。残り4枚はその画素で値5前後。
    const width = 3;
    const height = 3;
    const spikeIndex = 4; // 中央画素
    const darks = [];
    const normalValues = [4, 5, 5, 6];
    for (const value of normalValues) {
      darks.push(makeMosaic(width, height, 'rggb', (x, y) => {
        const index = y * width + x;
        return index === spikeIndex ? value : 3;
      }));
    }
    // 5枚目: 中央画素だけ極端なスパイク(宇宙線ヒット)。
    darks.push(makeMosaic(width, height, 'rggb', (x, y) => {
      const index = y * width + x;
      return index === spikeIndex ? 5000 : 3;
    }));

    const master = computeMasterDark(darks);
    // 中央値(4,5,5,6,5000をソートすると4,5,5,6,5000 -> 中央値5)は
    // スパイクにほとんど影響されない。平均だと(4+5+5+6+5000)/5=1004に
    // なってしまうが、中央値は5のまま。
    assert.equal(master.samples[spikeIndex], 5);
    // 他の画素(スパイクの影響を受けていない)は全て3のまま。
    assert.equal(master.samples[0], 3);
  },
);

test(
  'マスターダークを減算すると、光害・熱ノイズ由来の固定パターンが除去'
  + 'される',
  () => {
    const width = 4;
    const height = 4;
    const master = makeMosaic(
      width,
      height,
      'rggb',
      (x, y) => (x === 1 && y === 1 ? 50 : 2),
    );
    const light = makeMosaic(
      width,
      height,
      'rggb',
      (x, y) => (x === 1 && y === 1 ? 150 : 12),
    );
    const result = subtractDarkFrame(light, master);
    assert.equal(result.samples[1 * width + 1], 100); // 150-50
    assert.equal(result.samples[0], 10); // 12-2
  },
);

test('減算結果が負になる位置も線形残差として保持される', () => {
  const width = 2;
  const height = 2;
  const master = makeMosaic(width, height, 'rggb', () => 10);
  const light = makeMosaic(width, height, 'rggb', () => 3); // マスターより小さい
  const result = subtractDarkFrame(light, master);
  assert.ok(Array.from(result.samples).every((v) => v === -7));
});

test('ダーク減算で非有限値が発生した場合はInvalidDarkFrameInputを投げる', () => {
  const master = {
    width: 1, height: 1, cfaPattern: 'rggb', samples: new Float32Array([Infinity]),
  };
  const light = makeMosaic(1, 1, 'rggb', () => 1);
  assert.throws(() => subtractDarkFrame(light, master), InvalidDarkFrameInput);
});

test('元のlightMosaicは変更されない(新しいオブジェクトを返す)', () => {
  const width = 2;
  const height = 2;
  const master = makeMosaic(width, height, 'rggb', () => 5);
  const light = makeMosaic(width, height, 'rggb', () => 20);
  const originalSamples = Array.from(light.samples);
  subtractDarkFrame(light, master);
  assert.deepEqual(Array.from(light.samples), originalSamples);
});

test('空のダークフレーム配列はInvalidDarkFrameInputを投げる', () => {
  assert.throws(() => computeMasterDark([]), InvalidDarkFrameInput);
});

test('寸法が異なるダークフレーム同士はInvalidDarkFrameInputを投げる', () => {
  const a = makeMosaic(3, 3, 'rggb', () => 1);
  const b = makeMosaic(4, 4, 'rggb', () => 1);
  assert.throws(() => computeMasterDark([a, b]), InvalidDarkFrameInput);
});

test('CFAパターンが異なるダークフレーム同士はInvalidDarkFrameInputを投げる', () => {
  const a = makeMosaic(3, 3, 'rggb', () => 1);
  const b = makeMosaic(3, 3, 'bggr', () => 1);
  assert.throws(() => computeMasterDark([a, b]), InvalidDarkFrameInput);
});

test(
  'サンプル数が寸法と一致しないダークフレームはInvalidDarkFrameInputを'
  + '投げる',
  () => {
    const bad = {
      width: 3, height: 3, cfaPattern: 'rggb', samples: new Float32Array(4),
    };
    assert.throws(() => computeMasterDark([bad]), InvalidDarkFrameInput);
  },
);

test(
  'light/masterの寸法・CFAパターン不一致はInvalidDarkFrameInputを投げる',
  () => {
    const light = makeMosaic(3, 3, 'rggb', () => 10);
    const wrongSize = makeMosaic(4, 4, 'rggb', () => 5);
    assert.throws(
      () => subtractDarkFrame(light, wrongSize),
      InvalidDarkFrameInput,
    );
    const wrongPattern = makeMosaic(3, 3, 'bggr', () => 5);
    assert.throws(
      () => subtractDarkFrame(light, wrongPattern),
      InvalidDarkFrameInput,
    );
  },
);


test('master dark rejects NaN/Inf before median combination', () => {
  const valid = {
    width: 2,
    height: 1,
    cfaPattern: 'rggb',
    samples: new Float32Array([1, 2]),
  };
  const nanFrame = {
    width: 2,
    height: 1,
    cfaPattern: 'rggb',
    samples: new Float32Array([Number.NaN, 2]),
  };
  const infFrame = {
    width: 2,
    height: 1,
    cfaPattern: 'rggb',
    samples: new Float32Array([Number.POSITIVE_INFINITY, 2]),
  };
  assert.throws(() => computeMasterDark([valid, nanFrame]), /finite/);
  assert.throws(() => computeMasterDark([valid, infFrame]), /finite/);
});


test('sensor-saturated dark observation is excluded from the per-pixel median', () => {
  const a = makeMosaic(2, 2, 'rggb', () => 5);
  const b = makeMosaic(2, 2, 'rggb', () => 5);
  const c = makeMosaic(2, 2, 'rggb', () => 5);
  a.samples[0] = 10000;
  a.saturationMask = new Uint8Array(4);
  a.saturationMask[0] = 1;

  const master = computeMasterDark([a, b, c]);
  assert.equal(master.samples[0], 5);
  assert.equal(master.saturationMask, undefined);
});

test('all-saturated dark pixel is marked invalid and propagated through subtraction', () => {
  const darks = [
    makeMosaic(2, 2, 'rggb', () => 5),
    makeMosaic(2, 2, 'rggb', () => 6),
  ];
  for (const dark of darks) {
    dark.saturationMask = new Uint8Array(4);
    dark.saturationMask[0] = 1;
  }
  const master = computeMasterDark(darks);
  assert.equal(master.saturationMask[0], 1);

  const light = makeMosaic(2, 2, 'rggb', () => 20);
  const result = subtractDarkFrame(light, master);
  assert.equal(result.samples[0], 20);
  assert.equal(result.saturationMask[0], 1);
  assert.equal(result.samples[1], 14.5);
});
