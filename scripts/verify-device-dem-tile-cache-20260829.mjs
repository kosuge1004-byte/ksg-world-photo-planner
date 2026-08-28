import { __testGsiDemTileCacheInternals as client } from "../src/cesium/gsiDemTileCache.ts";
import {
  heightFromNeighborhood as serverNeighborhood,
  heightFromTile as serverBilinear,
  tileCoordinates as serverTileCoordinates,
} from "../server/gsiElevation.ts";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

const NO_DATA = -2_147_483_648;
function makeTile(base) {
  const data = new Int32Array(256 * 256);
  for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      data[y * 256 + x] = Math.round((base + x * 0.037 + y * 0.061 + Math.sin(x / 9) * 0.11) * 100);
    }
  }
  return { width: 256, height: 256, heightsCentimeters: data };
}

for (const zoom of [14, 15, 17]) {
  for (const [lat, lon] of [[35.3622, 136.7848], [35.7101, 139.8107], [43.0642, 141.3469]]) {
    const s = serverTileCoordinates({ latitude: lat, longitude: lon }, zoom);
    const c = client.tileCoordinates(lat, lon, zoom);
    for (const key of ["x", "y", "pixelX", "pixelY", "fracX", "fracY"]) {
      if (Math.abs(s[key] - c[key]) > 1e-12) fail(`tileCoordinates mismatch ${zoom} ${lat},${lon} ${key}`);
    }
  }
}

const baseX = 1000;
const baseY = 2000;
const tiles = new Map();
for (let oy = -1; oy <= 1; oy += 1) {
  for (let ox = -1; ox <= 1; ox += 1) {
    tiles.set(`${baseX + ox}/${baseY + oy}`, makeTile(120 + ox * 7 + oy * 11));
  }
}

for (const [px, py] of [[10, 20], [0, 0], [255, 255], [254, 1], [1, 254], [128, 128]]) {
  for (const [fx, fy] of [[0, 0], [0.2, 0.7], [0.999, 0.001], [0.5, 0.5]]) {
    for (const mode of ["neutral", "los-safe"]) {
      const s = serverNeighborhood(tiles, baseX, baseY, px, py, fx, fy, mode);
      const c = client.interpolateNeighborhood(tiles, baseX, baseY, px, py, fx, fy, mode);
      if (s === null || c === null || Math.abs(s - c) > 1e-12) {
        fail(`neighborhood mismatch px=${px} py=${py} fx=${fx} fy=${fy} mode=${mode}: ${s} vs ${c}`);
      }
    }
    const base = tiles.get(`${baseX}/${baseY}`);
    const sBil = serverBilinear(base, px, py, fx, fy);
    const cBil = client.interpolateBilinear(base, px, py, fx, fy);
    if (sBil === null || cBil === null || Math.abs(sBil - cBil) > 1e-12) {
      fail(`bilinear mismatch px=${px} py=${py} fx=${fx} fy=${fy}: ${sBil} vs ${cBil}`);
    }
  }
}

// NO_DATA parity: both paths must choose the same nearest/fallback behavior.
const noDataTile = makeTile(50);
noDataTile.heightsCentimeters[20 * 256 + 10] = NO_DATA;
const noDataTiles = new Map([[`${baseX}/${baseY}`, noDataTile]]);
const sNoData = serverBilinear(noDataTile, 10, 20, 0.7, 0.2);
const cNoData = client.interpolateBilinear(noDataTile, 10, 20, 0.7, 0.2);
if (!Object.is(sNoData, cNoData)) fail(`NO_DATA mismatch: ${sNoData} vs ${cNoData}`);

if (!process.exitCode) console.log("PASS: device DEM tile cache math matches server DEM math");
