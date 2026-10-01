import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidHotPixelDetectionInput,
  detectHotPixelsFromMasterDark,
} from '../hot_pixel_detection_reference.mjs';

function makeMasterDark(width, height, cfaPattern, fill) {
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

test('一様なマスターダークではホットピクセルは検出されない', () => {
  const dark = makeMasterDark(11, 11, 'rggb', () => 5);
  const hotPixels = detectHotPixelsFromMasterDark(dark);
  assert.equal(hotPixels.length, 0);
});

test(
  '局所近傍より極端に高い値を持つ画素がホットピクセルとして検出される',
  () => {
    const dark = makeMasterDark(11, 11, 'rggb', (x, y) => {
      if (x === 5 && y === 5) return 100; // 中心だけ極端に高い
      return 2;
    });
    const hotPixels = detectHotPixelsFromMasterDark(dark, {
      ratioThreshold: 5,
      absoluteThreshold: 10,
    });
    assert.equal(hotPixels.length, 1);
    assert.deepEqual(hotPixels[0], { x: 5, y: 5 });
  },
);

test(
  '相対閾値・絶対閾値のどちらか片方しか満たさない場合は検出されない'
  + '(両方が独立に必要という設計の検証)',
  () => {
    // ratioThreshold=5, absoluteThreshold=50。
    // 近傍中央値=2の位置に値9を置く: 比は4.5倍(<5、不合格)だが
    // 絶対差は7(<50、不合格)でもある -> どちらも不合格、検出されない。
    const notHot = makeMasterDark(11, 11, 'rggb', (x, y) => {
      if (x === 5 && y === 5) return 9;
      return 2;
    });
    assert.equal(
      detectHotPixelsFromMasterDark(notHot, {
        ratioThreshold: 5,
        absoluteThreshold: 50,
      }).length,
      0,
    );

    // 近傍中央値=1000の位置に値1500を置く: 比は1.5倍(<5、不合格)だが
    // 絶対差は500(>=absoluteThreshold=50、合格) -> 比が不合格なので
    // 全体としては不合格、検出されない(絶対閾値だけでは十分でない
    // ことの確認)。
    const highBaselineNotHot = makeMasterDark(11, 11, 'rggb', (x, y) => {
      if (x === 5 && y === 5) return 1500;
      return 1000;
    });
    assert.equal(
      detectHotPixelsFromMasterDark(highBaselineNotHot, {
        ratioThreshold: 5,
        absoluteThreshold: 50,
      }).length,
      0,
    );
  },
);

test(
  '同じCFA位相の画素だけが近傍として使われる(異なる色は混ざらない)',
  () => {
    // rggbで(5,5)は BLUE 位相(x,yとも奇数)。同位相(奇数,奇数)の近傍は
    // 全て3、異位相の近傍は全て9999にしておく。
    const dark = makeMasterDark(11, 11, 'rggb', (x, y) => {
      if (x === 5 && y === 5) return 3.5; // わずかに高いだけ
      const isOddOdd = (x % 2 === 1) && (y % 2 === 1);
      return isOddOdd ? 3 : 9999;
    });
    // 同位相近傍の中央値は3のはず。もし異位相の9999が混ざっていたら
    // 中央値は大きく変わり、3.5は「極端に高い」とは判定されないはず。
    const hotPixels = detectHotPixelsFromMasterDark(dark, {
      ratioThreshold: 1.1,
      absoluteThreshold: 0.1,
    });
    assert.equal(hotPixels.length, 1);
    assert.deepEqual(hotPixels[0], { x: 5, y: 5 });
  },
);

test('端・角の画素も近傍を画像範囲内にクリップして正しく処理される', () => {
  const dark = makeMasterDark(6, 6, 'rggb', (x, y) => {
    if (x === 0 && y === 0) return 100;
    return 2;
  });
  const hotPixels = detectHotPixelsFromMasterDark(dark, {
    ratioThreshold: 5,
    absoluteThreshold: 10,
  });
  assert.equal(hotPixels.length, 1);
  assert.deepEqual(hotPixels[0], { x: 0, y: 0 });
});

test(
  'サンプル数が寸法と一致しない場合はInvalidHotPixelDetectionInputを'
  + '投げる',
  () => {
    assert.throws(
      () => detectHotPixelsFromMasterDark({
        width: 5,
        height: 5,
        cfaPattern: 'rggb',
        samples: new Float32Array(10),
      }),
      InvalidHotPixelDetectionInput,
    );
  },
);

test('不正なパラメータを拒否する', () => {
  const dark = makeMasterDark(5, 5, 'rggb', () => 1);
  assert.throws(
    () => detectHotPixelsFromMasterDark(dark, { neighborhoodRadius: 0 }),
    InvalidHotPixelDetectionInput,
  );
  assert.throws(
    () => detectHotPixelsFromMasterDark(dark, { ratioThreshold: 1 }),
    InvalidHotPixelDetectionInput,
  );
  assert.throws(
    () => detectHotPixelsFromMasterDark(dark, { absoluteThreshold: -1 }),
    InvalidHotPixelDetectionInput,
  );
});


test('hot-pixel detection rejects non-finite master dark and thresholds', () => {
  const bad = makeMasterDark(5, 5, 'rggb', () => 1);
  bad.samples[0] = Number.NaN;
  assert.throws(() => detectHotPixelsFromMasterDark(bad), /finite/);

  const valid = makeMasterDark(5, 5, 'rggb', () => 1);
  assert.throws(
    () => detectHotPixelsFromMasterDark(valid, { ratioThreshold: Number.POSITIVE_INFINITY }),
    /ratioThreshold/,
  );
  assert.throws(
    () => detectHotPixelsFromMasterDark(valid, { absoluteThreshold: Number.POSITIVE_INFINITY }),
    /absoluteThreshold/,
  );
});
