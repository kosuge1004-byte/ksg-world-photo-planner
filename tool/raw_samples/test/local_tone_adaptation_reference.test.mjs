import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidLocalToneAdaptationInput,
  computeLuminance,
  boxBlur,
  computeLocalGain,
  applyLocalGain,
  applyLocalToneAdaptation,
} from '../local_tone_adaptation_reference.mjs';

test('computeLuminanceはBT.709の重みで正確に計算される', () => {
  // 単一画素 R=1, G=0, B=0 -> 0.2126。R=0,G=1,B=0 -> 0.7152。
  const rgb = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const luminance = computeLuminance(rgb, 3, 1);
  assert.ok(Math.abs(luminance[0] - 0.2126) < 1e-9);
  assert.ok(Math.abs(luminance[1] - 0.7152) < 1e-9);
  assert.ok(Math.abs(luminance[2] - 0.0722) < 1e-9);
});

test('computeLuminanceは負値・非有限値を0として扱う', () => {
  const rgb = new Float32Array([-1, NaN, Infinity]);
  const luminance = computeLuminance(rgb, 1, 1);
  assert.equal(luminance[0], 0);
});

test('computeLuminance preserves signed residual cancellation before the final luminance clamp', () => {
  const rgb = new Float32Array([-0.1, 0.1, 0]);
  const luminance = computeLuminance(rgb, 1, 1);
  const expected = -0.1 * 0.2126 + 0.1 * 0.7152;
  assert.ok(Math.abs(luminance[0] - expected) < 1e-8);
});

test('boxBlurのradius=0は入力をそのまま(コピーとして)返す', () => {
  const plane = new Float64Array([1, 2, 3, 4]);
  const blurred = boxBlur(plane, 2, 2, 0);
  assert.deepEqual(Array.from(blurred), Array.from(plane));
  assert.notEqual(blurred, plane); // 同じ参照ではない(コピー)
});

test('一様な平面をぼかしても値は変わらない', () => {
  const plane = new Float64Array(9).fill(5);
  const blurred = boxBlur(plane, 3, 3, 1);
  assert.ok(Array.from(blurred).every((v) => Math.abs(v - 5) < 1e-9));
});

test(
  '端の画素は範囲外を最近傍でクランプしてぼかされる'
  + '(具体的な数値で検証)',
  () => {
    // 3x1の平面[10,20,30]、radius=1。
    // 水平パス: pixel0=(10+10+20)/3=13.333, pixel1=(10+20+30)/3=20,
    // pixel2=(20+30+30)/3=26.667。
    // height=1のため垂直パスは実質恒等変換になる。
    const plane = new Float64Array([10, 20, 30]);
    const blurred = boxBlur(plane, 3, 1, 1);
    assert.ok(Math.abs(blurred[0] - 40 / 3) < 1e-9);
    assert.ok(Math.abs(blurred[1] - 20) < 1e-9);
    assert.ok(Math.abs(blurred[2] - 80 / 3) < 1e-9);
  },
);

test('boxBlurは不正なradius・寸法不一致を拒否する', () => {
  const plane = new Float64Array(4);
  assert.throws(
    () => boxBlur(plane, 2, 2, -1),
    InvalidLocalToneAdaptationInput,
  );
  assert.throws(
    () => boxBlur(plane, 2, 2, 1.5),
    InvalidLocalToneAdaptationInput,
  );
  assert.throws(
    () => boxBlur(new Float64Array(3), 2, 2, 1),
    InvalidLocalToneAdaptationInput,
  );
});

test('strength=0では全画素の利得が厳密に1になる', () => {
  const surround = new Float64Array([0.01, 0.5, 10, 0.0001]);
  const gain = computeLocalGain(surround, { strength: 0 });
  assert.ok(Array.from(gain).every((v) => v === 1));
});

test(
  '周辺輝度が基準パーセンタイルより暗い画素は利得>1(明るくなる)、'
  + '明るい画素は利得<=1になる(この設計の核心的な価値の検証)',
  () => {
    // [0.1, 1, 1, 1, 10]でreferencePercentile=0.85(デフォルト)の場合、
    // 85パーセンタイル(4番目の値、線形補間位置3.4)は1と10の間の
    // 補間値になる -> 十分に高い基準値になり、0.1は明確にそれより
    // 暗く、10はそれより明るいはず。
    const surround = new Float64Array([0.1, 1, 1, 1, 10]);
    const gain = computeLocalGain(surround, {
      strength: 1,
      minGain: 0.01,
      maxGain: 100,
    });
    assert.ok(
      gain[0] > 1,
      `expected dim region to get gain>1, got ${gain[0]}`,
    );
    assert.ok(
      gain[4] <= 1,
      `expected bright region to get gain<=1, got ${gain[4]}`,
    );
  },
);

test('minGain/maxGainで利得が実際にクランプされる', () => {
  // 20要素: 大部分(17個)が1、極端に暗い2個(0.0001)、極端に明るい
  // 1個(1000)。85パーセンタイルは「1」の範囲内に安定して収まるため、
  // 基準値はほぼ1になり、両極端の値が明確にクランプされる状況を作る。
  // (手動で列挙すると個数を数え間違えやすいため、コードで生成する)
  const surround = new Float64Array([
    0.0001,
    0.0001,
    ...Array(17).fill(1),
    1000,
  ]);
  assert.equal(surround.length, 20); // 個数の前提を明示的に検証
  const gain = computeLocalGain(surround, {
    strength: 1,
    minGain: 0.5,
    maxGain: 2,
  });
  assert.equal(gain[0], 2); // 極端に暗い -> 上限でクランプ
  assert.equal(gain[19], 0.5); // 極端に明るい -> 下限でクランプ
});

test('computeLocalGainは不正なパラメータを拒否する', () => {
  const surround = new Float64Array([1, 1]);
  assert.throws(
    () => computeLocalGain(surround, { strength: -1 }),
    InvalidLocalToneAdaptationInput,
  );
  assert.throws(
    () => computeLocalGain(surround, { epsilon: 0 }),
    InvalidLocalToneAdaptationInput,
  );
  assert.throws(
    () => computeLocalGain(surround, { minGain: 2, maxGain: 1 }),
    InvalidLocalToneAdaptationInput,
  );
  assert.throws(
    () => computeLocalGain(surround, { referencePercentile: -0.1 }),
    InvalidLocalToneAdaptationInput,
  );
  assert.throws(
    () => computeLocalGain(surround, { referencePercentile: 1.1 }),
    InvalidLocalToneAdaptationInput,
  );
});

test('applyLocalGainは各画素のR/G/Bへ同じ利得を一様に掛ける', () => {
  const rgb = new Float32Array([1, 2, 3, 4, 5, 6]);
  const gain = new Float64Array([2, 0.5]);
  const result = applyLocalGain(rgb, gain);
  assert.deepEqual(Array.from(result), [2, 4, 6, 2, 2.5, 3]);
});

test('元のrgbは変更されない(新しい配列を返す)', () => {
  const rgb = new Float32Array([1, 2, 3]);
  const original = Array.from(rgb);
  applyLocalGain(rgb, new Float64Array([2]));
  assert.deepEqual(Array.from(rgb), original);
});

test('applyLocalGainはgainとrgbの画素数不一致を拒否する', () => {
  assert.throws(
    () => applyLocalGain(new Float32Array(6), new Float64Array(1)),
    InvalidLocalToneAdaptationInput,
  );
});

test(
  'applyLocalToneAdaptation: strength=0では入力と数値的に同じ結果を'
  + '返す(新しい配列だが値は不変、既存パイプラインへの無害な追加で'
  + 'あることの確認)',
  () => {
    const rgb = new Float32Array([0.1, 0.2, 0.3, 5, 6, 7]);
    const result = applyLocalToneAdaptation(rgb, 2, 1, { strength: 0 });
    assert.deepEqual(Array.from(result), Array.from(rgb));
    assert.notEqual(result, rgb);
  },
);

test(
  'applyLocalToneAdaptation: 暗い背景領域と明るい星領域を持つ合成画像'
  + 'で、背景が明るくなり星がこれ以上増幅されないことを確認'
  + '(Work55の既知の限界に対する解決の直接検証)',
  () => {
    // 8x8画像。左半分は暗い背景(0.02)、右上の小さな領域だけ明るい星
    // (5.0)を模す。
    const width = 8;
    const height = 8;
    const rgb = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const isStar = x >= 6 && y <= 1;
        const value = isStar ? 5.0 : 0.02;
        rgb[index * 3] = value;
        rgb[index * 3 + 1] = value;
        rgb[index * 3 + 2] = value;
      }
    }
    const result = applyLocalToneAdaptation(rgb, width, height, {
      blurRadius: 3,
      strength: 0.5,
      minGain: 0.1,
      maxGain: 10,
    });
    // 背景領域(左下、星から離れた位置)の画素は明るくなっているはず。
    const backgroundIndex = (7 * width + 0) * 3;
    assert.ok(
      result[backgroundIndex] > rgb[backgroundIndex],
      `expected background to brighten: before=${rgb[backgroundIndex]}, `
        + `after=${result[backgroundIndex]}`,
    );
    // 星の中心の画素は、少なくとも大きく増幅されてはいないはず
    // (周辺が明るいため利得は1以下になるはず)。
    const starIndex = (0 * width + 7) * 3;
    assert.ok(
      result[starIndex] <= rgb[starIndex] * 1.01,
      `expected star not to be amplified further: before=${rgb[starIndex]}, `
        + `after=${result[starIndex]}`,
    );
  },
);
