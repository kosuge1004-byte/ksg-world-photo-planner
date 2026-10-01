import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidFlatFrameInput,
  computeMasterFlat,
  applyFlatFieldCorrection,
} from '../flat_field_calibration_reference.mjs';

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

test('一様なフラットフレームのマスターフラットは全画素1.0になる', () => {
  const flat = makeMosaic(3, 3, 'rggb', () => 500);
  const master = computeMasterFlat([flat]);
  for (const value of master.samples) {
    assert.ok(Math.abs(value - 1) < 1e-9);
  }
});

test(
  'CFA各色で共通の周辺減光勾配は、色比を変えず位置依存ゲインとして残る',
  () => {
    // 4x2 RGGB: 各R/G/B planeに左(60)・右(100)の双方が含まれる。
    const flat = makeMosaic(4, 2, 'rggb', (x) => x < 2 ? 60 : 100);
    const master = computeMasterFlat([flat]);
    // 各色planeのmeanは80なので、左=.75、右=1.25。
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const expected = x < 2 ? 0.75 : 1.25;
        assert.ok(
          Math.abs(master.samples[y * 4 + x] - expected) < 1e-6,
          `(${x},${y}) expected ${expected}, got ${master.samples[y * 4 + x]}`,
        );
      }
    }
  },
);

test(
  '一様照明でもR/G/B感度差があるCFA flatは各色1.0へ正規化され、色かぶりを注入しない',
  () => {
    const flat = makeMosaic(4, 4, 'rggb', (x, y) => {
      const evenX = (x & 1) === 0;
      const evenY = (y & 1) === 0;
      if (evenX && evenY) return 200; // R
      if (!evenX && !evenY) return 50; // B
      return 100; // both G phases
    });
    const master = computeMasterFlat([flat]);
    for (const value of master.samples) {
      assert.ok(Math.abs(value - 1) < 1e-9);
    }
  },
);

test(
  '中央値は塵の混入のような外れ値スパイクを平均より頑健に無視する'
  + '(この設計選択そのものの検証)',
  () => {
    const width = 3;
    const height = 3;
    const spikeIndex = 4;
    const flats = [];
    for (const value of [98, 100, 100, 102]) {
      flats.push(makeMosaic(width, height, 'rggb', (x, y) => {
        const index = y * width + x;
        return index === spikeIndex ? value : 100;
      }));
    }
    // 5枚目: 中央画素だけ極端に暗い(ゴミの影が偶然強く写った1枚を模擬)。
    flats.push(makeMosaic(width, height, 'rggb', (x, y) => {
      const index = y * width + x;
      return index === spikeIndex ? 1 : 100;
    }));

    const master = computeMasterFlat(flats);
    // 中央値(1,98,100,100,102 -> 中央値100)はスパイクにほぼ影響されず、
    // 正規化後もほぼ1.0のままのはず。
    assert.ok(Math.abs(master.samples[spikeIndex] - 1) < 0.02);
  },
);

test('マスターフラットで除算すると周辺減光が補正される', () => {
  const width = 3;
  const height = 1;
  const master = makeMosaic(
    width,
    height,
    'rggb',
    (x) => (x === 1 ? 1.5 : 0.75),
  );
  const light = makeMosaic(width, height, 'rggb', () => 300);
  const result = applyFlatFieldCorrection(light, master);
  assert.ok(Math.abs(result.samples[1] - 200) < 1e-6); // 300/1.5
  assert.ok(Math.abs(result.samples[0] - 400) < 1e-6); // 300/0.75
});

test(
  'マスターフラットの値がminimumFlatValue以下の位置は除算せずそのまま'
  + '通す',
  () => {
    const width = 2;
    const height = 1;
    const master = makeMosaic(
      width,
      height,
      'rggb',
      (x) => (x === 0 ? 0.01 : 1),
    );
    const light = makeMosaic(width, height, 'rggb', () => 300);
    const result = applyFlatFieldCorrection(
      light,
      master,
      { minimumFlatValue: 0.05 },
    );
    assert.equal(result.samples[0], 300); // 除算されずそのまま
    assert.equal(result.samples[1], 300); // 300/1
  },
);

test('元のlightMosaicは変更されない(新しいオブジェクトを返す)', () => {
  const width = 2;
  const height = 2;
  const master = makeMosaic(width, height, 'rggb', () => 0.9);
  const light = makeMosaic(width, height, 'rggb', () => 50);
  const originalSamples = Array.from(light.samples);
  applyFlatFieldCorrection(light, master);
  assert.deepEqual(Array.from(light.samples), originalSamples);
});

test('空のフラットフレーム配列はInvalidFlatFrameInputを投げる', () => {
  assert.throws(() => computeMasterFlat([]), InvalidFlatFrameInput);
});

test('信号が全くゼロのフラットフレームはInvalidFlatFrameInputを投げる', () => {
  const flat = makeMosaic(2, 2, 'rggb', () => 0);
  assert.throws(() => computeMasterFlat([flat]), InvalidFlatFrameInput);
});

test('寸法が異なるフラットフレーム同士はInvalidFlatFrameInputを投げる', () => {
  const a = makeMosaic(3, 3, 'rggb', () => 100);
  const b = makeMosaic(4, 4, 'rggb', () => 100);
  assert.throws(() => computeMasterFlat([a, b]), InvalidFlatFrameInput);
});

test(
  'CFAパターンが異なるフラットフレーム同士はInvalidFlatFrameInputを'
  + '投げる',
  () => {
    const a = makeMosaic(3, 3, 'rggb', () => 100);
    const b = makeMosaic(3, 3, 'bggr', () => 100);
    assert.throws(() => computeMasterFlat([a, b]), InvalidFlatFrameInput);
  },
);

test(
  'light/masterの寸法・CFAパターン不一致はInvalidFlatFrameInputを投げる',
  () => {
    const light = makeMosaic(3, 3, 'rggb', () => 100);
    const wrongSize = makeMosaic(4, 4, 'rggb', () => 1);
    assert.throws(
      () => applyFlatFieldCorrection(light, wrongSize),
      InvalidFlatFrameInput,
    );
    const wrongPattern = makeMosaic(3, 3, 'bggr', () => 1);
    assert.throws(
      () => applyFlatFieldCorrection(light, wrongPattern),
      InvalidFlatFrameInput,
    );
  },
);


test('master flat rejects NaN/Inf before median and color normalization', () => {
  const valid = makeMosaic(2, 2, 'rggb', () => 100);
  const nanFlat = makeMosaic(2, 2, 'rggb', () => 100);
  nanFlat.samples[0] = Number.NaN;
  const infFlat = makeMosaic(2, 2, 'rggb', () => 100);
  infFlat.samples[1] = Number.POSITIVE_INFINITY;
  assert.throws(() => computeMasterFlat([valid, nanFlat]), /finite/);
  assert.throws(() => computeMasterFlat([valid, infFlat]), /finite/);
});

test('flat correction rejects non-finite samples and invalid minimumFlatValue', () => {
  const light = makeMosaic(2, 2, 'rggb', () => 100);
  const master = makeMosaic(2, 2, 'rggb', () => 1);
  assert.throws(
    () => applyFlatFieldCorrection(light, master, { minimumFlatValue: Number.NaN }),
    /minimumFlatValue/,
  );
  assert.throws(
    () => applyFlatFieldCorrection(light, master, { minimumFlatValue: -0.1 }),
    /minimumFlatValue/,
  );
  const badMaster = makeMosaic(2, 2, 'rggb', () => 1);
  badMaster.samples[0] = Number.NaN;
  assert.throws(() => applyFlatFieldCorrection(light, badMaster), /finite/);
});


test('sensor-saturated flat observation is excluded from the per-pixel median', () => {
  const a = makeMosaic(4, 4, 'rggb', () => 100);
  const b = makeMosaic(4, 4, 'rggb', () => 100);
  const c = makeMosaic(4, 4, 'rggb', () => 100);
  const pixel = 0;
  a.samples[pixel] = 10000;
  a.saturationMask = new Uint8Array(16);
  a.saturationMask[pixel] = 1;

  const master = computeMasterFlat([a, b, c]);
  assert.ok(Math.abs(master.samples[pixel] - 1) < 1e-9);
});

test('all-saturated flat pixel is marked invalid instead of fabricating a correction', () => {
  const flats = [
    makeMosaic(2, 2, 'rggb', () => 100),
    makeMosaic(2, 2, 'rggb', () => 100),
  ];
  for (const flat of flats) {
    flat.saturationMask = new Uint8Array(4);
    flat.saturationMask[0] = 1;
  }
  const master = computeMasterFlat(flats);
  assert.equal(master.samples[0], 1);
  assert.equal(master.saturationMask[0], 1);
});

test('unusable master-flat site is passed through and propagated as invalid', () => {
  const light = makeMosaic(2, 2, 'rggb', () => 300);
  const master = makeMosaic(2, 2, 'rggb', () => 1);
  master.samples[0] = 0.01;
  const result = applyFlatFieldCorrection(
    light,
    master,
    { minimumFlatValue: 0.05 },
  );
  assert.equal(result.samples[0], 300);
  assert.equal(result.saturationMask[0], 1);
  assert.equal(result.samples[1], 300);
  assert.equal(result.saturationMask[1], 0);
});

test('master-flat invalid mask is unioned with existing light invalid mask', () => {
  const light = makeMosaic(2, 2, 'rggb', () => 300);
  light.saturationMask = new Uint8Array(4);
  light.saturationMask[1] = 1;
  const master = makeMosaic(2, 2, 'rggb', () => 1);
  master.saturationMask = new Uint8Array(4);
  master.saturationMask[0] = 1;
  const result = applyFlatFieldCorrection(light, master);
  assert.equal(result.saturationMask[0], 1);
  assert.equal(result.saturationMask[1], 1);
});
