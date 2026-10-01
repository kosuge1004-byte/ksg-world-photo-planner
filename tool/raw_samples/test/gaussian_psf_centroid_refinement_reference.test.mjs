import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidPsfRefinementInput,
  refineAxisWithGaussianMarginalFit,
  refineCentroidWithGaussianPsfFit,
} from '../gaussian_psf_centroid_refinement_reference.mjs';

function gaussianValue(x, center, sigma) {
  return Math.exp(-((x - center) ** 2) / (2 * sigma * sigma));
}

test(
  '真のガウシアンプロファイルに対し、3点対数放物線フィットが正確な'
  + 'sub-pixel位置を復元する(手計算検証: sigma=1.5, x0=2.3)',
  () => {
    const trueCenter = 2.3;
    const sigma = 1.5;
    const profile = [0, 1, 2, 3, 4].map(
      (x) => gaussianValue(x, trueCenter, sigma),
    );
    // 初期位置(既存の重心法などから来た大まかな近似)を2とする。
    const refined = refineAxisWithGaussianMarginalFit(profile, 0, 2);
    assert.ok(
      Math.abs(refined - trueCenter) < 1e-3,
      `expected ~${trueCenter}, got ${refined}`,
    );
  },
);

test('プロファイルが完全に対称なら、精緻化後もピーク位置は変わらない', () => {
  const sigma = 1.2;
  const profile = [0, 1, 2, 3, 4].map((x) => gaussianValue(x, 2, sigma));
  const refined = refineAxisWithGaussianMarginalFit(profile, 0, 2);
  assert.ok(Math.abs(refined - 2) < 1e-9);
});

test(
  '中心候補がプロファイルの端(両隣を参照できない)場合は、初期位置を'
  + 'そのまま返す',
  () => {
    const profile = [5, 4, 3];
    const refined = refineAxisWithGaussianMarginalFit(profile, 0, 0);
    assert.equal(refined, 0);
    const refinedRight = refineAxisWithGaussianMarginalFit(profile, 0, 2);
    assert.equal(refinedRight, 2);
  },
);

test('隣接点に0以下の値がある場合は、初期位置をそのまま返す', () => {
  const profile = [5, 10, 0, 8, 5];
  const refined = refineAxisWithGaussianMarginalFit(profile, 0, 2);
  assert.equal(refined, 2); // 対数が定義できないためフィットしない
});

test(
  '3点が実際にはピークを描いていない(単調増加等)場合は、初期位置を'
  + 'そのまま返す',
  () => {
    const profile = [1, 2, 3, 4, 5]; // 単調増加、ピークが無い
    const refined = refineAxisWithGaussianMarginalFit(profile, 0, 2);
    assert.equal(refined, 2);
  },
);

test('profileの要素数が3未満だとInvalidPsfRefinementInputを投げる', () => {
  assert.throws(
    () => refineAxisWithGaussianMarginalFit([1, 2], 0, 0),
    InvalidPsfRefinementInput,
  );
});

test(
  'refineCentroidWithGaussianPsfFit: x・y独立に、2次元的に分離可能な'
  + 'ガウシアンPSFに対して正確な位置を復元する',
  () => {
    const width = 9;
    const height = 9;
    const trueX = 4.3;
    const trueY = 4.6;
    const sigma = 1.4;
    const backgroundMedian = 10;
    const samples = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 分離可能な2次元ガウシアン: gx(x)*gy(y)。
        const value = 100 * gaussianValue(x, trueX, sigma)
          * gaussianValue(y, trueY, sigma);
        samples[y * width + x] = backgroundMedian + value;
      }
    }
    const source = { width, height, samples };
    const refined = refineCentroidWithGaussianPsfFit({
      source,
      peakX: 4,
      peakY: 5,
      initialX: 4,
      initialY: 5,
      backgroundMedian,
      windowRadius: 3,
    });
    assert.ok(
      Math.abs(refined.x - trueX) < 1e-2,
      `expected x~${trueX}, got ${refined.x}`,
    );
    assert.ok(
      Math.abs(refined.y - trueY) < 1e-2,
      `expected y~${trueY}, got ${refined.y}`,
    );
  },
);

test(
  'sourceのサンプル数が寸法と一致しない場合はInvalidPsfRefinementInput'
  + 'を投げる',
  () => {
    assert.throws(
      () => refineCentroidWithGaussianPsfFit({
        source: { width: 3, height: 3, samples: new Float64Array(4) },
        peakX: 1,
        peakY: 1,
        initialX: 1,
        initialY: 1,
        backgroundMedian: 0,
        windowRadius: 1,
      }),
      InvalidPsfRefinementInput,
    );
  },
);

test(
  'windowRadiusが正の整数でない場合はInvalidPsfRefinementInputを投げる',
  () => {
    const source = { width: 3, height: 3, samples: new Float64Array(9) };
    assert.throws(
      () => refineCentroidWithGaussianPsfFit({
        source,
        peakX: 1,
        peakY: 1,
        initialX: 1,
        initialY: 1,
        backgroundMedian: 0,
        windowRadius: 0,
      }),
      InvalidPsfRefinementInput,
    );
  },
);


test('PSF refinement rejects non-finite luminance and centroid inputs', () => {
  const source = {
    width: 5,
    height: 5,
    samples: new Float32Array(25).fill(1),
  };
  source.samples[12] = Number.NaN;
  assert.throws(
    () => refineCentroidWithGaussianPsfFit({
      source,
      peakX: 2,
      peakY: 2,
      initialX: 2,
      initialY: 2,
      backgroundMedian: 0,
      windowRadius: 2,
    }),
    /finite luminance and centroid inputs/,
  );

  const clean = {
    width: 5,
    height: 5,
    samples: new Float32Array(25).fill(1),
  };
  assert.throws(
    () => refineCentroidWithGaussianPsfFit({
      source: clean,
      peakX: 2,
      peakY: 2,
      initialX: Number.POSITIVE_INFINITY,
      initialY: 2,
      backgroundMedian: 0,
      windowRadius: 2,
    }),
    /finite luminance and centroid inputs/,
  );
});

test('PSF refinement rejects peak coordinates outside the source', () => {
  const source = {
    width: 5,
    height: 5,
    samples: new Float32Array(25).fill(1),
  };
  assert.throws(
    () => refineCentroidWithGaussianPsfFit({
      source,
      peakX: 5,
      peakY: 2,
      initialX: 4,
      initialY: 2,
      backgroundMedian: 0,
      windowRadius: 2,
    }),
    /peak coordinates must lie inside/,
  );
});
