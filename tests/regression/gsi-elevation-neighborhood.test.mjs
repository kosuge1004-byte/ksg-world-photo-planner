import assert from "node:assert/strict";
import {
  heightFromNeighborhood,
  neighborTileOffsetsFor4x4Grid,
  resolveGridCoordinate,
  NO_DATA_HEIGHT_CENTIMETERS,
} from "../../server/gsiElevation.ts";

const TILE_SIZE = 256;

function uniformTile(heightMeters) {
  return {
    width: TILE_SIZE,
    height: TILE_SIZE,
    heightsCentimeters: new Int32Array(TILE_SIZE * TILE_SIZE).fill(
      Math.round(heightMeters * 100)
    ),
  };
}

/** heightsAt(x, y) -> meters (or null for NoData) を与えて任意パターンのタイルを作る。 */
function patternTile(heightsAt) {
  const heightsCentimeters = new Int32Array(TILE_SIZE * TILE_SIZE);
  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const meters = heightsAt(x, y);
      heightsCentimeters[y * TILE_SIZE + x] =
        meters === null ? NO_DATA_HEIGHT_CENTIMETERS : Math.round(meters * 100);
    }
  }
  return { width: TILE_SIZE, height: TILE_SIZE, heightsCentimeters };
}

// --- 1. タイル境界: 4x4近傍が本物の隣接タイルを参照すること ---------------
{
  const baseTile = uniformTile(10);
  const neighborEastTile = uniformTile(50);
  const tiles = new Map([
    ["10/20", baseTile],
    ["11/20", neighborEastTile], // 東隣（x+1）のタイル
  ]);

  // pixelX=255 は基準タイル右端。offsetX=+1,+2 は隣接タイル(11/20)へまたがる。
  const result = heightFromNeighborhood(tiles, 10, 20, 255, 100, 0.5, 0.5);
  assert.ok(result !== null, "boundary sample should resolve");
  // 4隅は base(10), neighbor(50), base(10), neighbor(50) の混在になるはずで、
  // 旧実装のように端ピクセルを複製していれば常に10になってしまう。
  assert.ok(
    result > 15 && result < 45,
    `expected neighbor tile data to be blended in (10..50 mix), got ${result}`
  );
}

// --- 2. NoData: 4隅のどこかが欠測ならBilinearへ安全にフォールバック -------
{
  const tileWithHole = patternTile((x, y) => (x === 128 && y === 128 ? null : 20));
  const tiles = new Map([["5/5", tileWithHole]]);
  // pixelX/pixelY=127: 中央セルの右下角(128,128)だけがNoData。fracを左上寄り
  // (0.1,0.1)にして「最近傍」が有効なtopLeftになるようにする。
  const result = heightFromNeighborhood(tiles, 5, 5, 127, 127, 0.1, 0.1);
  assert.ok(result !== null, "should not be null when the nearest corner resolves");
  assert.ok(
    Math.abs(result - 20) < 1e-9,
    `NoData near a corner should fall back to nearest-neighbor (20), got ${result}`
  );
}

// --- 3. 海域・国外など隣接タイルが存在しない場合 ---------------------------
{
  const baseTile = uniformTile(30);
  // 東隣タイルを意図的に登録しない（サーバー側のnullレスポンス＝海域相当）。
  const tiles = new Map([["8/8", baseTile]]);
  // fracを左上寄り(0.1,0.1)にして「最近傍」が取得済みのbaseTile側(topLeft)になるようにする。
  const result = heightFromNeighborhood(tiles, 8, 8, 255, 50, 0.1, 0.1);
  assert.ok(result !== null, "missing neighbor tile must still fall back, not throw/null");
  assert.ok(
    Math.abs(result - 30) < 1e-9,
    `missing neighbor should fall back to the nearest resolvable corner, got ${result}`
  );
}

{
  // 中央セルの角そのものが未取得タイルにある場合はnullを返す（呼び出し側が更に上位フォールバックする）。
  const tiles = new Map(); // 何も登録しない＝全域が海域扱い
  const result = heightFromNeighborhood(tiles, 8, 8, 255, 50, 0.5, 0.5);
  assert.equal(result, null, "fully missing tiles must resolve to null, not a fabricated height");
}

// --- 4. 崖・オーバーシュート: 補間結果が近傍実測値の範囲を超えない ---------
{
  // 中央に鋭い崖（0 -> 100）があるパターン。三次補間はオーバーシュートしやすい。
  const cliffTile = patternTile((x) => (x < 128 ? 0 : 100));
  const tiles = new Map([["3/3", cliffTile]]);
  const result = heightFromNeighborhood(tiles, 3, 3, 127, 100, 0.99, 0.5);
  assert.ok(result !== null);
  assert.ok(
    result >= 0 && result <= 100,
    `cliff interpolation must not overshoot outside 0..100, got ${result}`
  );
}

// --- 5. LOS逆転防止: 安全側判定はBilinear未満に落ちない -------------------
{
  // 中央がへこんだ谷地形（オーバーシュートすると三次補間が実測より低く出やすい）。
  const valleyTile = patternTile((x, y) => {
    const dx = x - 128;
    const dy = y - 128;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance < 40 ? 5 : 20;
  });
  const tiles = new Map([["1/1", valleyTile]]);
  const fracX = 0.5;
  const fracY = 0.5;
  const pixelX = 127;
  const pixelY = 127;

  const safeResult = heightFromNeighborhood(tiles, 1, 1, pixelX, pixelY, fracX, fracY);

  // 同じ4隅からBilinearだけを計算し、安全側判定がそれを下回らないことを確認する。
  const { bilinearInterpolate } = await import("../../server/bilinearInterpolation.ts");
  const topLeft = valleyTile.heightsCentimeters[pixelY * TILE_SIZE + pixelX] / 100;
  const topRight = valleyTile.heightsCentimeters[pixelY * TILE_SIZE + (pixelX + 1)] / 100;
  const bottomLeft = valleyTile.heightsCentimeters[(pixelY + 1) * TILE_SIZE + pixelX] / 100;
  const bottomRight = valleyTile.heightsCentimeters[(pixelY + 1) * TILE_SIZE + (pixelX + 1)] / 100;
  const bilinearOnly = bilinearInterpolate(
    { topLeft, topRight, bottomLeft, bottomRight },
    fracX,
    fracY
  );

  assert.ok(
    safeResult >= bilinearOnly - 1e-9,
    `LOS safe-side result (${safeResult}) must never undershoot bilinear (${bilinearOnly}) ` +
      "to avoid falsely reporting a clear line of sight"
  );
}

// --- neighborTileOffsetsFor4x4Grid / resolveGridCoordinate 単体確認 --------
{
  assert.deepEqual(resolveGridCoordinate(-1), { tileOffset: -1, localPixel: 255 });
  assert.deepEqual(resolveGridCoordinate(0), { tileOffset: 0, localPixel: 0 });
  assert.deepEqual(resolveGridCoordinate(255), { tileOffset: 0, localPixel: 255 });
  assert.deepEqual(resolveGridCoordinate(256), { tileOffset: 1, localPixel: 0 });
  assert.deepEqual(resolveGridCoordinate(257), { tileOffset: 1, localPixel: 1 });

  // 完全にタイル内側（境界から離れている）なら追加タイルは不要（自タイルのみ）。
  const interior = neighborTileOffsetsFor4x4Grid(128, 128);
  assert.equal(interior.length, 1);
  assert.deepEqual(interior[0], { tileOffsetX: 0, tileOffsetY: 0 });

  // 右下端に近い場合は最大4タイル（自身+右+下+右下）が必要になりうる。
  const corner = neighborTileOffsetsFor4x4Grid(255, 255);
  assert.ok(corner.length <= 4 && corner.length >= 2, `expected 2..4 tiles, got ${corner.length}`);
}

console.log("gsi elevation neighborhood (Phase F-1) tests passed");
