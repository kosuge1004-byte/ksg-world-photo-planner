// 2026-09-30: 国土地理院 標高PNGタイルの合成サーバー（回帰テスト共用）。
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------- PNG encoder
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let n = 0; n < buffer.length; n += 1) {
    let c = (crc ^ buffer[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(name), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** GSI標高PNG仕様（x=h[cm]、負値は+2^24、NoDataは2^23）で符号化。全フィルター種別を使う。 */
export function encodeGsiPng(centimeters, rgba, seed) {
  const width = 256;
  const height = 256;
  const bpp = rgba ? 4 : 3;
  const raw = new Uint8Array(width * height * bpp);
  for (let index = 0; index < width * height; index += 1) {
    const value = centimeters[index];
    const x = value === -2_147_483_648 ? 2 ** 23 : value >= 0 ? value : value + 2 ** 24;
    raw[index * bpp] = (x >> 16) & 255;
    raw[index * bpp + 1] = (x >> 8) & 255;
    raw[index * bpp + 2] = x & 255;
    if (rgba) raw[index * bpp + 3] = 255;
  }
  const rowBytes = width * bpp;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const filter = (y + seed) % 5;
    filtered[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x += 1) {
      const r = raw[y * rowBytes + x];
      const a = x >= bpp ? raw[y * rowBytes + x - bpp] : 0;
      const b = y > 0 ? raw[(y - 1) * rowBytes + x] : 0;
      const c = y > 0 && x >= bpp ? raw[(y - 1) * rowBytes + x - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      filtered[y * (rowBytes + 1) + 1 + x] = (r - predictor) & 255;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = rgba ? 6 : 2;
  const compressed = deflateSync(filtered);
  const half = Math.floor(compressed.length / 2);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", compressed.subarray(0, half)),
    chunk("IDAT", compressed.subarray(half)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ------------------------------------------------------ synthetic GSI tile world
export function hash(...values) {
  let h = 2166136261;
  for (const value of values) {
    h ^= value;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
/** DEM1Aは約半数が404、DEM5AはNoData帯を含む、DEM10Bは全域。滑らかな地形＋ノイズ。 */
export function syntheticTile(sourceId, zoom, x, y) {
  if (sourceId === "dem1a_png" && hash(x, y) % 2 === 0) return null;
  if ((sourceId === "dem5b_png" || sourceId === "dem5c_png") && hash(x, y, 7) % 3 !== 0) return null;
  const centimeters = new Int32Array(256 * 256);
  for (let py = 0; py < 256; py += 1) {
    for (let px = 0; px < 256; px += 1) {
      const gx = x * 256 + px;
      const gy = y * 256 + py;
      if (sourceId === "dem5a_png" && (gx + gy) % 97 < 6) {
        centimeters[py * 256 + px] = -2_147_483_648;
        continue;
      }
      const base = Math.sin(gx / (40 * 2 ** (zoom - 14))) * 5000 + Math.cos(gy / (55 * 2 ** (zoom - 14))) * 7000;
      centimeters[py * 256 + px] = Math.round(base + (hash(gx, gy, zoom) % 200) - 100 + (zoom === 17 ? 37 : 0));
    }
  }
  return encodeGsiPng(centimeters, hash(x, y, zoom) % 2 === 0, hash(x, zoom));
}


const GSI_TILE_PATTERN = /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/([a-z0-9_]+)\/(\d+)\/(\d+)\/(\d+)\.png$/;

/** URLが国土地理院標高タイルなら合成PNG（または404）を返し、それ以外はnull。 */
export function syntheticGsiTileResponse(url) {
  const match = String(url).match(GSI_TILE_PATTERN);
  if (!match) return null;
  const png = syntheticTile(match[1], Number(match[2]), Number(match[3]), Number(match[4]));
  return png
    ? new Response(png, { headers: { "Content-Type": "image/png" } })
    : new Response(null, { status: 404 });
}
