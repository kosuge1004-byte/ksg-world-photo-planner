import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidLocalResidualFitInput,
  fitLocalResidualCorrectionField,
} from '../local_residual_correction_reference.mjs';

function trueResidualX(x, y) {
  return 0.5 + 0.1 * x + 0.05 * y + 0.02 * x * x
    + 0.01 * x * y + 0.015 * y * y;
}

function trueResidualY(x, y) {
  return -0.3 + 0.08 * x - 0.06 * y + 0.01 * x * x
    - 0.02 * x * y + 0.025 * y * y;
}

function buildGridMatches() {
  const matches = [];
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      matches.push({
        referenceX: x,
        referenceY: y,
        residualX: trueResidualX(x, y),
        residualY: trueResidualY(x, y),
      });
    }
  }
  return matches; // 25点(5x5グリッド)
}

test(
  '既知の2次多項式歪み場から生成したデータに対し、フィットが元の'
  + '関数値を正確に復元する(訓練データ点での検証)',
  () => {
    const matches = buildGridMatches();
    const field = fitLocalResidualCorrectionField(matches, {
      minimumMatchesPerCoefficient: 4, // 25点 >= 6*4=24なので条件を満たす
    });
    assert.equal(field.fitted, true);
    for (const point of [
      { x: -2, y: -2 }, { x: 0, y: 0 }, { x: 1, y: -1 }, { x: 2, y: 2 },
    ]) {
      const { dx, dy } = field.evaluate(point.x, point.y);
      const expectedDx = trueResidualX(point.x, point.y);
      const expectedDy = trueResidualY(point.x, point.y);
      assert.ok(
        Math.abs(dx - expectedDx) < 1e-6,
        `x=${point.x},y=${point.y}: expected dx~${expectedDx}, got ${dx}`,
      );
      assert.ok(
        Math.abs(dy - expectedDy) < 1e-6,
        `x=${point.x},y=${point.y}: expected dy~${expectedDy}, got ${dy}`,
      );
    }
  },
);

test(
  '一様な(位置に依存しない)残差データに対しては、定数項だけが復元'
  + 'される',
  () => {
    const matches = [];
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        matches.push({
          referenceX: x, referenceY: y, residualX: 1.5, residualY: -0.8,
        });
      }
    }
    const field = fitLocalResidualCorrectionField(matches, {
      minimumMatchesPerCoefficient: 4,
    });
    assert.equal(field.fitted, true);
    const { dx, dy } = field.evaluate(100, -50); // 訓練範囲外でも定数のまま
    assert.ok(Math.abs(dx - 1.5) < 1e-6);
    assert.ok(Math.abs(dy - (-0.8)) < 1e-6);
  },
);

test(
  'マッチ数が不足している場合、フィットせず常に0を返す'
  + '(過剰適合の防止)',
  () => {
    const matches = buildGridMatches().slice(0, 10); // 6*4=24未満
    const field = fitLocalResidualCorrectionField(matches, {
      minimumMatchesPerCoefficient: 4,
    });
    assert.equal(field.fitted, false);
    const { dx, dy } = field.evaluate(0, 0);
    assert.equal(dx, 0);
    assert.equal(dy, 0);
  },
);

test(
  'maximumCorrectionMagnitudeを超える補正はクランプされる'
  + '(過剰なワープの禁止)',
  () => {
    const matches = [];
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        // 極端に大きな一様残差(100)を仕込む。
        matches.push({
          referenceX: x, referenceY: y, residualX: 100, residualY: 0,
        });
      }
    }
    const field = fitLocalResidualCorrectionField(matches, {
      minimumMatchesPerCoefficient: 4,
      maximumCorrectionMagnitude: 3,
    });
    const { dx, dy } = field.evaluate(0, 0);
    const magnitude = Math.sqrt(dx * dx + dy * dy);
    assert.ok(
      Math.abs(magnitude - 3) < 1e-9,
      `expected magnitude clamped to 3, got ${magnitude}`,
    );
  },
);

test(
  '全ての点が同一直線上(縮退)にある場合、singularなためfitted=false'
  + 'になる',
  () => {
    const matches = [];
    for (let x = -3; x <= 3; x++) {
      for (let i = 0; i < 5; i++) {
        // yを常に0に固定 -> yに関する項が全て縮退する。
        matches.push({
          referenceX: x, referenceY: 0, residualX: x, residualY: 0,
        });
      }
    }
    const field = fitLocalResidualCorrectionField(matches, {
      minimumMatchesPerCoefficient: 4,
    });
    assert.equal(field.fitted, false);
  },
);

test('不正なパラメータを拒否する', () => {
  assert.throws(
    () => fitLocalResidualCorrectionField(
      [],
      { minimumMatchesPerCoefficient: 0 },
    ),
    InvalidLocalResidualFitInput,
  );
  assert.throws(
    () => fitLocalResidualCorrectionField(
      [],
      { maximumCorrectionMagnitude: -1 },
    ),
    InvalidLocalResidualFitInput,
  );
});

test(
  '実際の画像座標系スケール(0-4000px)・不規則な星の分布でも、'
  + '座標正規化(Work124)により数値的に安定してフィットできる',
  () => {
    // 手計算で事前に用意した既知の2次多項式歪み場(定数項・1次項・
    // 2次項を含む)から、不規則な位置(乱数)にある30個のマッチを
    // 生成し、フィットが元の関数値を正確に復元することを確認する。
    function trueResidualX(x, y) {
      return 0.0015 * (x - 2000) - 0.0008 * (y - 1500)
        + 0.0000004 * (x - 2000) * (x - 2000)
        + 0.0000002 * (x - 2000) * (y - 1500);
    }
    function trueResidualY(x, y) {
      return -0.001 * (x - 2000) + 0.0012 * (y - 1500)
        + 0.0000003 * (y - 1500) * (y - 1500);
    }
    let seed = 777;
    function next() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    const matches = [];
    for (let i = 0; i < 30; i++) {
      const x = next() * 4000;
      const y = next() * 3000;
      matches.push({
        referenceX: x,
        referenceY: y,
        residualX: trueResidualX(x, y),
        residualY: trueResidualY(x, y),
      });
    }
    const field = fitLocalResidualCorrectionField(matches, {
      minimumMatchesPerCoefficient: 4,
    });
    assert.equal(field.fitted, true);

    // クランプ(maximumCorrectionMagnitude、既定3)の影響を受けない、
    // 補正の大きさが3未満に収まる検証点だけで精度を確認する。
    for (const [testX, testY] of [[500, 500], [3500, 2500], [2000, 1500]]) {
      const result = field.evaluate(testX, testY);
      const expectedX = trueResidualX(testX, testY);
      const expectedY = trueResidualY(testX, testY);
      assert.ok(
        Math.abs(result.dx - expectedX) < 1e-9,
        `x mismatch at (${testX},${testY}): expected ${expectedX}, got `
          + `${result.dx}`,
      );
      assert.ok(
        Math.abs(result.dy - expectedY) < 1e-9,
        `y mismatch at (${testX},${testY}): expected ${expectedY}, got `
          + `${result.dy}`,
      );
    }
  },
);


test('local residual fit rejects non-finite match data', () => {
  const matches = buildGridMatches();
  matches[0] = { ...matches[0], residualX: NaN };
  assert.throws(
    () => fitLocalResidualCorrectionField(matches),
    /only finite values/,
  );
});

test('fitted local residual field rejects non-finite evaluation coordinates', () => {
  const field = fitLocalResidualCorrectionField(buildGridMatches(), {
    minimumMatchesPerCoefficient: 1,
    maximumCorrectionMagnitude: 100,
  });
  assert.equal(field.fitted, true);
  assert.throws(() => field.evaluate(NaN, 0), /coordinates must be finite/);
  assert.throws(() => field.evaluate(0, Infinity), /coordinates must be finite/);
});

test('one gross mismatched star is MAD-rejected before final local residual refit', () => {
  const matches = buildGridMatches();
  matches.push({
    referenceX: 0.35,
    referenceY: -0.45,
    residualX: 40,
    residualY: -35,
  });
  const field = fitLocalResidualCorrectionField(matches, {
    minimumMatchesPerCoefficient: 4,
    maximumCorrectionMagnitude: 100,
  });
  assert.equal(field.fitted, true);
  for (const [x, y] of [[-2, -2], [0, 0], [2, 2], [1, -1]]) {
    const correction = field.evaluate(x, y);
    assert.ok(Math.abs(correction.dx - trueResidualX(x, y)) < 1e-6,
      `dx mismatch at ${x},${y}: ${correction.dx}`);
    assert.ok(Math.abs(correction.dy - trueResidualY(x, y)) < 1e-6,
      `dy mismatch at ${x},${y}: ${correction.dy}`);
  }
});
