import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidLocalCorrectionInversionInput,
  invertSimilarityTransformWithLocalCorrection,
} from '../invert_similarity_transform_with_local_correction_reference.mjs';
import { invertSimilarityTransform } from '../cfa_drizzle_reference.mjs';

// applySimilarityForwardに相当するJS版はcfa_drizzle_reference.mjsに
// 存在しない(Dart側でのみ必要になり追加された)ため、テストでは
// AffineSamplingTransform.similarityと同じ数式で自前に定義する。
function applySimilarityForward(estimate, x, y) {
  const radians = estimate.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const ox = x - estimate.centerX;
  const oy = y - estimate.centerY;
  return {
    x: estimate.centerX + cosine * ox - sine * oy + estimate.sourceOffsetX,
    y: estimate.centerY + sine * ox + cosine * oy + estimate.sourceOffsetY,
  };
}

const zeroCorrectionField = { evaluate: () => ({ dx: 0, dy: 0 }) };

test(
  '局所補正が常に0の場合、反復ベースの逆変換は既存の解析的な'
  + 'invertSimilarityTransformと厳密に一致する(後方互換性の検証)',
  () => {
    const estimate = {
      rotationDegrees: 15,
      sourceOffsetX: 3,
      sourceOffsetY: -2,
      centerX: 50,
      centerY: 40,
    };
    const globalOnlyInverse = invertSimilarityTransform(estimate);
    const combinedInverse = invertSimilarityTransformWithLocalCorrection(
      estimate,
      zeroCorrectionField,
      applySimilarityForward,
      globalOnlyInverse,
    );

    for (const [sourceX, sourceY] of [[10, 20], [100, 5], [-30, 60]]) {
      const expected = globalOnlyInverse(sourceX, sourceY);
      const actual = combinedInverse(sourceX, sourceY);
      assert.ok(
        Math.abs(actual.x - expected.x) < 1e-9,
        `x mismatch at (${sourceX},${sourceY}): expected ${expected.x}, `
          + `got ${actual.x}`,
      );
      assert.ok(
        Math.abs(actual.y - expected.y) < 1e-9,
        `y mismatch at (${sourceX},${sourceY}): expected ${expected.y}, `
          + `got ${actual.y}`,
      );
    }
  },
);

test(
  '大域変換が恒等・局所補正が定数の場合、逆変換は単純な減算になる'
  + '(手計算検証)',
  () => {
    // 大域変換=恒等、局所補正=定数(0.5, -0.3)。
    // 真の順方向: source = reference + (0.5, -0.3)。
    // 真の逆変換: reference = source - (0.5, -0.3)。
    // source=(10,20) -> reference=(9.5, 20.3)であるはず。
    const estimate = {
      rotationDegrees: 0,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
      centerX: 0,
      centerY: 0,
    };
    const constantCorrectionField = {
      evaluate: () => ({ dx: 0.5, dy: -0.3 }),
    };
    const globalOnlyInverse = invertSimilarityTransform(estimate);
    const combinedInverse = invertSimilarityTransformWithLocalCorrection(
      estimate,
      constantCorrectionField,
      applySimilarityForward,
      globalOnlyInverse,
    );

    const result = combinedInverse(10, 20);
    assert.ok(
      Math.abs(result.x - 9.5) < 1e-6,
      `expected x~9.5, got ${result.x}`,
    );
    assert.ok(
      Math.abs(result.y - 20.3) < 1e-6,
      `expected y~20.3, got ${result.y}`,
    );
  },
);

test(
  '逆変換した結果を順方向(大域+局所)へ適用し直すと、元のsource位置に'
  + '戻る(round-trip検証、位置依存の局所補正を含む)',
  () => {
    // 位置に依存する局所補正場(小さな線形勾配)を使い、round-trip
    // (逆変換->順変換)が元の位置を正確に復元することを確認する。
    const estimate = {
      rotationDegrees: 10,
      sourceOffsetX: 5,
      sourceOffsetY: -3,
      centerX: 20,
      centerY: 15,
    };
    const linearCorrectionField = {
      evaluate: (x, y) => ({ dx: 0.01 * x, dy: 0.02 * y }),
    };
    const globalOnlyInverse = invertSimilarityTransform(estimate);
    const combinedInverse = invertSimilarityTransformWithLocalCorrection(
      estimate,
      linearCorrectionField,
      applySimilarityForward,
      globalOnlyInverse,
      { iterationCount: 6 },
    );

    for (const [sourceX, sourceY] of [[40, 30], [0, 0], [-10, 50]]) {
      const reference = combinedInverse(sourceX, sourceY);
      const globalPrediction = applySimilarityForward(
        estimate,
        reference.x,
        reference.y,
      );
      const correction = linearCorrectionField.evaluate(
        reference.x,
        reference.y,
      );
      const roundTripSourceX = globalPrediction.x + correction.dx;
      const roundTripSourceY = globalPrediction.y + correction.dy;
      assert.ok(
        Math.abs(roundTripSourceX - sourceX) < 1e-4,
        `round-trip x mismatch at (${sourceX},${sourceY}): got `
          + `${roundTripSourceX}`,
      );
      assert.ok(
        Math.abs(roundTripSourceY - sourceY) < 1e-4,
        `round-trip y mismatch at (${sourceX},${sourceY}): got `
          + `${roundTripSourceY}`,
      );
    }
  },
);

test(
  'iterationCountが正の整数でない場合は'
  + 'InvalidLocalCorrectionInversionInputを投げる',
  () => {
    const estimate = {
      rotationDegrees: 0,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
      centerX: 0,
      centerY: 0,
    };
    assert.throws(
      () => invertSimilarityTransformWithLocalCorrection(
        estimate,
        zeroCorrectionField,
        applySimilarityForward,
        invertSimilarityTransform(estimate),
        { iterationCount: 0 },
      ),
      InvalidLocalCorrectionInversionInput,
    );
  },
);


test('local-correction inverse rejects non-finite source coordinates', () => {
  const estimate = {
    rotationDegrees: 0,
    sourceOffsetX: 0,
    sourceOffsetY: 0,
    centerX: 0,
    centerY: 0,
  };
  const inverse = invertSimilarityTransformWithLocalCorrection(
    estimate,
    zeroCorrectionField,
    applySimilarityForward,
    (x, y) => ({ x, y }),
  );
  assert.throws(() => inverse(NaN, 0), /Source coordinates must be finite/);
});

test('local-correction inverse rejects non-finite initial guesses/predictions', () => {
  const estimate = {
    rotationDegrees: 0,
    sourceOffsetX: 0,
    sourceOffsetY: 0,
    centerX: 0,
    centerY: 0,
  };
  const badGuess = invertSimilarityTransformWithLocalCorrection(
    estimate,
    zeroCorrectionField,
    applySimilarityForward,
    () => ({ x: Infinity, y: 0 }),
  );
  assert.throws(() => badGuess(1, 1), /Initial inverse-transform guess/);

  const badCorrection = invertSimilarityTransformWithLocalCorrection(
    estimate,
    { evaluate: () => ({ dx: NaN, dy: 0 }) },
    applySimilarityForward,
    (x, y) => ({ x, y }),
  );
  assert.throws(() => badCorrection(1, 1), /non-finite prediction/);
});
