import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidFrameQualityWeightInput,
  starShapeQualityWeight,
  starCountQualityWeight,
  comprehensiveFrameQualityWeight,
  intrinsicReferenceFrameQualityWeight,
} from '../comprehensive_frame_quality_weight_reference.mjs';

test(
  'starShapeQualityWeight: 中央値roundnessから逆二乗減衰で計算される'
  + '(手計算検証)',
  () => {
    // median([0.1,0.2,0.3])=0.2, halfWeight=0.3(既定):
    // ratio=0.2/0.3=0.6667, weight=1/(1+0.4444)=0.6923。
    const weight = starShapeQualityWeight([0.1, 0.2, 0.3]);
    assert.ok(
      Math.abs(weight - 0.6923076923076923) < 1e-9,
      `expected ~0.6923, got ${weight}`,
    );
  },
);

test('starShapeQualityWeight: 完全な丸(roundness=0)の星ばかりなら重み1', () => {
  const weight = starShapeQualityWeight([0, 0, 0]);
  assert.equal(weight, 1);
});

test('starShapeQualityWeight: 検出星が無い場合は重み1(ペナルティなし)', () => {
  const weight = starShapeQualityWeight([]);
  assert.equal(weight, 1);
});

test(
  'starShapeQualityWeight: 少数の歪んだ検出に平均ではなく中央値が'
  + '頑健であることの検証',
  () => {
    // 9個の丸い星(roundness=0.05)と1個の極端に歪んだ星(roundness=0.9)。
    // 平均なら大きく引きずられるが、中央値は0.05のまま。
    const roundness = [
      ...Array(9).fill(0.05),
      0.9,
    ];
    const weight = starShapeQualityWeight(roundness);
    // median=0.05, halfWeight=0.3: ratio=0.1667, weight=1/(1+0.0278)=0.9730
    assert.ok(
      weight > 0.9,
      `expected weight close to 1 (median-robust), got ${weight}`,
    );
  },
);

test(
  'starCountQualityWeight: 参照より少ない検出数は逆二乗減衰で減点される'
  + '(手計算検証)',
  () => {
    // shortfall=10, halfWeightPoint=20*0.5=10, ratio=1, weight=0.5。
    const weight = starCountQualityWeight(10, 20);
    assert.ok(Math.abs(weight - 0.5) < 1e-9, `expected 0.5, got ${weight}`);
  },
);

test('starCountQualityWeight: 参照と同数以上なら重み1(減点なし)', () => {
  assert.equal(starCountQualityWeight(20, 20), 1);
  assert.equal(starCountQualityWeight(25, 20), 1);
});

test('starCountQualityWeight: 参照星数が0なら重み1', () => {
  assert.equal(starCountQualityWeight(5, 0), 1);
});

test(
  'comprehensiveFrameQualityWeight: 3つの要因が乗算で結合される'
  + '(手計算検証)',
  () => {
    // registrationWeight=0.8, shapeWeight(median=0.2,half=0.3)=0.6923,
    // countWeight(10/20)=0.5。combined=0.8*0.6923*0.5=0.27692。
    const combined = comprehensiveFrameQualityWeight({
      registrationWeight: 0.8,
      roundnessValues: [0.1, 0.2, 0.3],
      detectedStarCount: 10,
      referenceStarCount: 20,
    });
    assert.ok(
      Math.abs(combined - 0.8 * 0.6923076923076923 * 0.5) < 1e-9,
      `expected ~0.27692, got ${combined}`,
    );
  },
);

test(
  'comprehensiveFrameQualityWeight: 検出星情報が無い場合は'
  + 'registrationWeightのみに帰着する(既存挙動との後方互換性)',
  () => {
    const combined = comprehensiveFrameQualityWeight({
      registrationWeight: 0.73,
      roundnessValues: [],
      detectedStarCount: 20,
      referenceStarCount: 20,
    });
    assert.ok(Math.abs(combined - 0.73) < 1e-9);
  },
);

test(
  'comprehensiveFrameQualityWeight: minimumWeightで下限にクランプされる',
  () => {
    const combined = comprehensiveFrameQualityWeight({
      registrationWeight: 0.1,
      roundnessValues: [0.9, 0.9, 0.9],
      detectedStarCount: 1,
      referenceStarCount: 100,
      minimumWeight: 0.05,
    });
    assert.equal(combined, 0.05);
  },
);

test('不正なパラメータを拒否する', () => {
  assert.throws(
    () => starShapeQualityWeight([1.5]),
    InvalidFrameQualityWeightInput,
  );
  assert.throws(
    () => starShapeQualityWeight([0.1], { roundnessHalfWeight: 0 }),
    InvalidFrameQualityWeightInput,
  );
  assert.throws(
    () => starCountQualityWeight(-1, 10),
    InvalidFrameQualityWeightInput,
  );
  assert.throws(
    () => starCountQualityWeight(5, -1),
    InvalidFrameQualityWeightInput,
  );
  assert.throws(
    () => comprehensiveFrameQualityWeight({
      registrationWeight: 1.5,
      roundnessValues: [],
      detectedStarCount: 1,
      referenceStarCount: 1,
    }),
    InvalidFrameQualityWeightInput,
  );
});


test('frame-quality weighting rejects infinite quality scale parameters', () => {
  assert.throws(
    () => starShapeQualityWeight([0.1, 0.2], {
      roundnessHalfWeight: Number.POSITIVE_INFINITY,
    }),
    /finite and positive/,
  );
  assert.throws(
    () => starCountQualityWeight(5, 10, {
      countShortfallHalfWeightFraction: Number.POSITIVE_INFINITY,
    }),
    /finite and positive/,
  );
});


test('intrinsic reference score reuses existing shape/count quality model', () => {
  const sharpMany = intrinsicReferenceFrameQualityWeight({
    roundnessValues: [0.05, 0.08, 0.06],
    detectedStarCount: 100,
    bestObservedStarCount: 100,
  });
  const elongatedMany = intrinsicReferenceFrameQualityWeight({
    roundnessValues: [0.4, 0.45, 0.35],
    detectedStarCount: 100,
    bestObservedStarCount: 100,
  });
  const sharpFew = intrinsicReferenceFrameQualityWeight({
    roundnessValues: [0.05, 0.08, 0.06],
    detectedStarCount: 40,
    bestObservedStarCount: 100,
  });
  assert.ok(sharpMany > elongatedMany);
  assert.ok(sharpMany > sharpFew);
});
