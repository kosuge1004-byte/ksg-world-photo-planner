import assert from 'node:assert/strict';
import test from 'node:test';

import { cfaColorAt } from '../mobile_stack_adaptive_demosaic_reference.mjs';
import {
  InvalidMosaicInput,
  extractGreenLuminanceFromMosaic,
} from '../extract_green_luminance_from_mosaic_reference.mjs';

const GREEN = 1;

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

test(
  'isGreenPosition (このモジュール内部)がcfaColorAtと全パターンで一致する',
  () => {
    // cfaColorAtは既にこのプロジェクトで検証済みの基準実装。ここでは
    // extractGreenLuminanceFromMosaicが「緑位置はそのまま使う」という
    // 動作を通じて、間接的にcfaColorAtと一致した緑位置判定をしている
    // ことを、全パターン・全4通りの偶奇の組み合わせで確認する。
    for (const pattern of ['rggb', 'bggr', 'grbg', 'gbrg']) {
      for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const isGreenByColorAt = cfaColorAt(pattern, x, y) === GREEN;
        // 4x4の一様でないモザイクを作り、(x,y)位置の値がそのまま出力に
        // 現れるかどうかで緑位置判定を検証する。
        const mosaic = makeMosaic(
          4,
          4,
          pattern,
          (mx, my) => (mx === x && my === y ? 999 : 1),
        );
        const result = extractGreenLuminanceFromMosaic(mosaic);
        const outputValue = result.samples[y * 4 + x];
        if (isGreenByColorAt) {
          assert.equal(
            outputValue,
            999,
            `pattern=${pattern} (${x},${y}): expected green position to `
              + 'pass through its own value unchanged',
          );
        } else {
          assert.notEqual(
            outputValue,
            999,
            `pattern=${pattern} (${x},${y}): expected non-green position `
              + 'to be interpolated, not passed through',
          );
        }
      }
    }
  },
);

test('緑位置の値は一切変更されずそのまま出力される', () => {
  const mosaic = makeMosaic(6, 6, 'rggb', (x, y) => x * 10 + y);
  const result = extractGreenLuminanceFromMosaic(mosaic);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      if (cfaColorAt('rggb', x, y) === GREEN) {
        assert.equal(result.samples[y * 6 + x], mosaic.samples[y * 6 + x]);
      }
    }
  }
});

test('内部の非緑位置は4方向の緑近傍の平均になる', () => {
  // rggbで(1,1)は緑ではない(evenX=false,evenY=false -> BLUE)。
  // 4近傍(0,1)(2,1)(1,0)(1,2)は全て緑(evenX!==evenY)のはず。
  const mosaic = makeMosaic(5, 5, 'rggb', (x, y) => {
    if (x === 0 && y === 1) return 10;
    if (x === 2 && y === 1) return 20;
    if (x === 1 && y === 0) return 30;
    if (x === 1 && y === 2) return 40;
    return 0; // 中心自身の値(青)は使われないはず
  });
  assert.equal(cfaColorAt('rggb', 1, 1), 2); // BLUE であることの前提確認
  const result = extractGreenLuminanceFromMosaic(mosaic);
  assert.equal(result.samples[1 * 5 + 1], (10 + 20 + 30 + 40) / 4);
});

test(
  '端・角の非緑位置は範囲内の近傍のみで平均される(範囲外をゼロ扱いしない)',
  () => {
    // rggbで(0,0)はRED(evenX&&evenY)。角なので近傍は右(1,0)と下(0,1)
    // の2つだけ(いずれも緑)。
    assert.equal(cfaColorAt('rggb', 0, 0), 0); // RED であることの前提確認
    const mosaic = makeMosaic(4, 4, 'rggb', (x, y) => {
      if (x === 1 && y === 0) return 6;
      if (x === 0 && y === 1) return 10;
      return 100; // 他の値(角の平均に混ざってはいけない)
    });
    const result = extractGreenLuminanceFromMosaic(mosaic);
    // 範囲外(x=-1やy=-1)をゼロとして4つで割ってしまうと
    // (6+10+0+0)/4=4になってしまうが、正しくは範囲内の2つだけの平均
    // (6+10)/2=8。
    assert.equal(result.samples[0], 8);
  },
);

test('4x4より小さい極小モザイクでもゼロ除算せず有限値を返す', () => {
  const mosaic = makeMosaic(2, 2, 'rggb', () => 5);
  const result = extractGreenLuminanceFromMosaic(mosaic);
  for (const value of result.samples) {
    assert.ok(Number.isFinite(value));
  }
});

test('サンプル数が寸法と一致しない場合はInvalidMosaicInputを投げる', () => {
  assert.throws(
    () => extractGreenLuminanceFromMosaic({
      width: 4,
      height: 4,
      cfaPattern: 'rggb',
      samples: new Float32Array(10),
    }),
    InvalidMosaicInput,
  );
});

test('未知のCFAパターンはInvalidMosaicInputを投げる', () => {
  assert.throws(
    () => extractGreenLuminanceFromMosaic({
      width: 2,
      height: 2,
      cfaPattern: 'xyzw',
      samples: new Float32Array(4),
    }),
    InvalidMosaicInput,
  );
});

test('出力の寸法は入力と同じ', () => {
  const mosaic = makeMosaic(7, 5, 'grbg', () => 1);
  const result = extractGreenLuminanceFromMosaic(mosaic);
  assert.equal(result.width, 7);
  assert.equal(result.height, 5);
  assert.equal(result.samples.length, 35);
});
