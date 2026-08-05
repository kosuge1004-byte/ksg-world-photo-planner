import { inflateSync } from "node:zlib";
import { serverPersistentCache } from "./cloudflareRuntime.ts";
import { bilinearInterpolate } from "./bilinearInterpolation.ts";

export type GsiElevationSource =
  | "DEM1A"
  | "DEM5A"
  | "DEM5B"
  | "DEM5C"
  | "DEM10B";

export type GsiElevationRequestPoint = {
  latitude: number;
  longitude: number;
  maximumDetail?: "1m" | "5m" | "10m";
};

export type GsiElevationSample = {
  heightMeters: number | null;
  source: GsiElevationSource | null;
};

type ElevationTileSource = {
  id: string;
  label: GsiElevationSource;
  zoom: number;
};

type DecodedPng = {
  width: number;
  height: number;
  bytesPerPixel: number;
  pixels: Uint8Array;
};

type DecodedElevationTile = {
  width: number;
  height: number;
  heightsCentimeters: Int32Array;
};

const GSI_TILE_SOURCES: ElevationTileSource[] = [
  // 国土地理院の公開順に合わせ、航空レーザ由来の1m/5m DEMを最優先する。
  { id: "dem1a_png", label: "DEM1A", zoom: 17 },
  { id: "dem5a_png", label: "DEM5A", zoom: 15 },
  { id: "dem5b_png", label: "DEM5B", zoom: 15 },
  { id: "dem5c_png", label: "DEM5C", zoom: 15 },
  { id: "dem_png", label: "DEM10B", zoom: 14 },
];

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_TILE_CACHE_ENTRIES = 512;
const PERSISTENT_TILE_FORMAT_VERSION = 1;
const NO_DATA_HEIGHT_CENTIMETERS = -2_147_483_648;
const MAX_CONCURRENT_GSI_TILE_REQUESTS = 8;
const tileCache = new Map<string, Promise<DecodedElevationTile | null>>();
let activeTileRequests = 0;
const tileRequestWaiters: Array<() => void> = [];

async function withTileRequestLimit<T>(task: () => Promise<T>): Promise<T> {
  if (activeTileRequests >= MAX_CONCURRENT_GSI_TILE_REQUESTS) {
    await new Promise<void>((resolve) => tileRequestWaiters.push(resolve));
  }
  activeTileRequests += 1;
  try {
    return await task();
  } finally {
    activeTileRequests -= 1;
    tileRequestWaiters.shift()?.();
  }
}

function isJapaneseCoverage(point: GsiElevationRequestPoint): boolean {
  return (
    point.latitude >= 20 &&
    point.latitude <= 46.5 &&
    point.longitude >= 122 &&
    point.longitude <= 154
  );
}

function readChunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(bytes: Uint8Array): DecodedPng {
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error("国土地理院標高タイルがPNG形式ではありません");
  }

  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  const idatParts: Uint8Array[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      4
    ).getUint32(0, false);
    const name = readChunkName(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error("国土地理院標高タイルのPNGデータが途中で終了しています");
    }
    if (name === "IHDR") {
      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset + dataStart,
        length
      );
      width = header.getUint32(0, false);
      height = header.getUint32(4, false);
      const bitDepth = header.getUint8(8);
      const colorType = header.getUint8(9);
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`未対応の標高PNG形式です（bit=${bitDepth}, color=${colorType}）`);
      }
      bytesPerPixel = colorType === 2 ? 3 : 4;
    } else if (name === "IDAT") {
      idatParts.push(bytes.slice(dataStart, dataEnd));
    } else if (name === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bytesPerPixel === 0 || idatParts.length === 0) {
    throw new Error("国土地理院標高タイルのPNGヘッダーを解析できません");
  }
  const compressedLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const part of idatParts) {
    compressed.set(part, compressedOffset);
    compressedOffset += part.length;
  }
  const inflated = inflateSync(compressed);
  const rowBytes = width * bytesPerPixel;
  if (inflated.length < (rowBytes + 1) * height) {
    throw new Error("国土地理院標高タイルの展開後データが不足しています");
  }
  const pixels = new Uint8Array(rowBytes * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[rowOffset - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[rowOffset - rowBytes + x - bytesPerPixel]
        : 0;
      const reconstructed = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : filter === 4
                ? raw + paethPredictor(left, above, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(reconstructed)) {
        throw new Error(`未対応のPNGフィルターです（${filter}）`);
      }
      pixels[rowOffset + x] = reconstructed & 0xff;
    }
    sourceOffset += rowBytes;
  }
  return { width, height, bytesPerPixel, pixels };
}


function decodeElevationTile(bytes: Uint8Array): DecodedElevationTile {
  const png = decodePng(bytes);
  const pixelCount = png.width * png.height;
  const heightsCentimeters = new Int32Array(pixelCount);
  const noDataValue = NO_DATA_HEIGHT_CENTIMETERS;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * png.bytesPerPixel;
    const encoded =
      png.pixels[offset] * 65_536 +
      png.pixels[offset + 1] * 256 +
      png.pixels[offset + 2];
    heightsCentimeters[pixelIndex] = encoded === 2 ** 23
      ? noDataValue
      : encoded < 2 ** 23
        ? encoded
        : encoded - 2 ** 24;
  }
  return { width: png.width, height: png.height, heightsCentimeters };
}

function tileCoordinates(
  point: GsiElevationRequestPoint,
  zoom: number
): { x: number; y: number; pixelX: number; pixelY: number; fracX: number; fracY: number } {
  const scale = 2 ** zoom;
  const normalizedX = (point.longitude + 180) / 360 * scale;
  const latitudeRadians = point.latitude * Math.PI / 180;
  const normalizedY = (
    1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI
  ) / 2 * scale;
  const x = Math.floor(normalizedX);
  const y = Math.floor(normalizedY);
  const pixelPositionX = Math.max(0, Math.min(255.999, (normalizedX - x) * 256));
  const pixelPositionY = Math.max(0, Math.min(255.999, (normalizedY - y) * 256));
  return {
    x,
    y,
    pixelX: Math.floor(pixelPositionX),
    pixelY: Math.floor(pixelPositionY),
    fracX: pixelPositionX - Math.floor(pixelPositionX),
    fracY: pixelPositionY - Math.floor(pixelPositionY),
  };
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function persistentTileKey(source: ElevationTileSource, x: number, y: number): string {
  return `gsi-decoded-dem-v1/${source.id}/${source.zoom}/${x}/${y}.bin`;
}

function deserializeDecodedElevationTile(bytes: ArrayBuffer): DecodedElevationTile | null {
  const headerBytes = 12;
  if (bytes.byteLength < headerBytes) return null;
  const view = new DataView(bytes);
  const version = view.getUint32(0, true);
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  if (
    version !== PERSISTENT_TILE_FORMAT_VERSION ||
    width <= 0 ||
    height <= 0 ||
    width * height > 1_048_576 ||
    bytes.byteLength !== headerBytes + width * height * Int32Array.BYTES_PER_ELEMENT
  ) {
    return null;
  }
  const copied = bytes.slice(headerBytes);
  return { width, height, heightsCentimeters: new Int32Array(copied) };
}

async function readPersistentDecodedTile(
  source: ElevationTileSource,
  x: number,
  y: number
): Promise<DecodedElevationTile | null> {
  const persistentCache = serverPersistentCache();
  if (!persistentCache) return null;
  try {
    const bytes = await persistentCache.get(persistentTileKey(source, x, y), {
      type: "arrayBuffer",
    });
    return bytes instanceof ArrayBuffer ? deserializeDecodedElevationTile(bytes) : null;
  } catch {
    // ローカル開発やBlob未設定環境では永続キャッシュを使わず従来処理を継続する。
    return null;
  }
}

/**
 * DEMタイルは検索中に大量取得されるためWorkers KVへ書き込まない。
 * 既存KVの読み取り互換性だけ維持し、新規取得分はプロセスメモリの
 * tileCacheで再利用する。時間変更・三脚候補更新・検索進捗による
 * KV PUTを確実に0回にするための設計。
 */

const GSI_TILE_REQUEST_TIMEOUT_MS = 8_000;

async function fetchGsiTileWithTimeout(url: string): Promise<Response> {
  // 通信自体に打ち切りが無いと、国土地理院側が応答しない場合に検索処理全体が
  // 無期限に停止してしまうため、タイル取得だけ独自タイムアウトを持たせる。
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("国土地理院標高タイル取得タイムアウト", "TimeoutError")),
    GSI_TILE_REQUEST_TIMEOUT_MS
  );
  try {
    return await fetch(url, {
      headers: { Accept: "image/png" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDecodedTile(
  source: ElevationTileSource,
  x: number,
  y: number,
  signal?: AbortSignal
): Promise<DecodedElevationTile | null> {
  const key = `${source.id}/${source.zoom}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return awaitWithAbort(cached, signal);

  // 同一タイルの通信・PNG展開Promiseを要求間で共有する。
  // 個々の検索中断で共有処理そのものを停止させると、別検索まで巻き込むため、
  // 基礎Promiseは中断信号から独立させ、各呼び出し側の待機だけを中断可能にする。
  const promise = withTileRequestLimit(async () => {
    const persistent = await readPersistentDecodedTile(source, x, y);
    if (persistent) return persistent;

    const response = await fetchGsiTileWithTimeout(
      `https://cyberjapandata.gsi.go.jp/xyz/${source.id}/${source.zoom}/${x}/${y}.png`
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`国土地理院標高タイル取得エラー：${response.status}`);
    }
    const decoded = decodeElevationTile(new Uint8Array(await response.arrayBuffer()));
    return decoded;
  }).catch((error: unknown) => {
    // 中断や一時的な通信失敗をキャッシュせず、次の判定で再取得できるようにする。
    tileCache.delete(key);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    console.warn(`国土地理院標高タイル ${key} を利用できません`, error);
    return null;
  });

  tileCache.set(key, promise);
  if (tileCache.size > MAX_TILE_CACHE_ENTRIES) {
    const oldestKey = tileCache.keys().next().value;
    if (typeof oldestKey === "string") tileCache.delete(oldestKey);
  }
  return awaitWithAbort(promise, signal);
}

function rawHeightAt(
  tile: DecodedElevationTile,
  pixelX: number,
  pixelY: number
): number | null {
  const clampedX = Math.max(0, Math.min(tile.width - 1, pixelX));
  const clampedY = Math.max(0, Math.min(tile.height - 1, pixelY));
  const heightCentimeters = tile.heightsCentimeters[clampedY * tile.width + clampedX];
  if (heightCentimeters === NO_DATA_HEIGHT_CENTIMETERS) return null;
  return heightCentimeters * 0.01;
}

/**
 * タイル内4点（左上・右上・左下・右下）をBilinear補間して標高を求める。
 * 4隅のいずれかがNO_DATA（データ欠測）の場合は補間すると誤った値になるため、
 * 問い合わせ座標に最も近い1点（最近傍）へ安全にフォールバックする。
 * pixelX/pixelYが隣接タイルにまたがる境界付近では、タイル端のピクセルを
 * 再利用して補間する（追加のタイル取得を避けるための簡略化）。
 */
function heightFromTile(
  tile: DecodedElevationTile,
  pixelX: number,
  pixelY: number,
  fracX: number,
  fracY: number
): number | null {
  if (pixelX >= tile.width || pixelY >= tile.height) return null;

  const topLeft = rawHeightAt(tile, pixelX, pixelY);
  const topRight = rawHeightAt(tile, pixelX + 1, pixelY);
  const bottomLeft = rawHeightAt(tile, pixelX, pixelY + 1);
  const bottomRight = rawHeightAt(tile, pixelX + 1, pixelY + 1);

  if (topLeft === null && topRight === null && bottomLeft === null && bottomRight === null) {
    return null;
  }
  if (topLeft === null || topRight === null || bottomLeft === null || bottomRight === null) {
    // 周辺にNO_DATAがある場合は補間せず、最近傍点を採用する。
    return fracX < 0.5
      ? fracY < 0.5 ? topLeft : bottomLeft
      : fracY < 0.5 ? topRight : bottomRight;
  }

  return bilinearInterpolate({ topLeft, topRight, bottomLeft, bottomRight }, fracX, fracY);
}

function sourceIsAllowedForPoint(
  source: ElevationTileSource,
  point: GsiElevationRequestPoint
): boolean {
  if (point.maximumDetail === "10m") return source.label === "DEM10B";
  if (point.maximumDetail === "5m") return source.label !== "DEM1A";
  return true;
}

export async function lookupGsiElevations(
  points: GsiElevationRequestPoint[],
  signal?: AbortSignal
): Promise<GsiElevationSample[]> {
  if (points.length > 2_048) {
    throw new Error("一度に取得できる標高点は2,048点までです");
  }
  for (const point of points) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      point.latitude < -90 ||
      point.latitude > 90 ||
      point.longitude < -180 ||
      point.longitude > 180
    ) {
      throw new Error("標高取得座標が不正です");
    }
  }

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const results: GsiElevationSample[] = points.map(() => ({
    heightMeters: null,
    source: null,
  }));
  const unresolved = new Set<number>();
  points.forEach((point, index) => {
    if (isJapaneseCoverage(point)) unresolved.add(index);
  });

  // 点ごとに「タイル取得→待機」を繰り返さず、標高種別ごとに必要タイルを
  // 先に集約して一括取得する。標高種別の優先順位と各点の詳細度条件は
  // 従来どおり維持するため、取得結果・精度は変わらない。
  for (const source of GSI_TILE_SOURCES) {
    if (unresolved.size === 0) break;
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const requests: Array<{
      index: number;
      coordinate: ReturnType<typeof tileCoordinates>;
      tileKey: string;
    }> = [];
    const uniqueTiles = new Map<string, { x: number; y: number }>();

    for (const index of unresolved) {
      const point = points[index];
      if (!sourceIsAllowedForPoint(source, point)) continue;
      const coordinate = tileCoordinates(point, source.zoom);
      const tileKey = `${coordinate.x}/${coordinate.y}`;
      requests.push({ index, coordinate, tileKey });
      if (!uniqueTiles.has(tileKey)) {
        uniqueTiles.set(tileKey, { x: coordinate.x, y: coordinate.y });
      }
    }

    if (requests.length === 0) continue;

    const tileEntries = await Promise.all(
      [...uniqueTiles.entries()].map(async ([tileKey, coordinate]) => [
        tileKey,
        await fetchDecodedTile(source, coordinate.x, coordinate.y, signal),
      ] as const)
    );
    const tiles = new Map<string, DecodedElevationTile | null>(tileEntries);

    for (const request of requests) {
      const tile = tiles.get(request.tileKey) ?? null;
      if (!tile) continue;
      const heightMeters = heightFromTile(
        tile,
        request.coordinate.pixelX,
        request.coordinate.pixelY,
        request.coordinate.fracX,
        request.coordinate.fracY
      );
      if (heightMeters === null) continue;
      results[request.index] = { heightMeters, source: source.label };
      unresolved.delete(request.index);
    }
  }

  return results;
}


export type GsiTerrainAzimuthBand = {
  startDegrees: number;
  endDegrees: number;
};

function normalizeBearing(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function bearingsForBand(
  band: GsiTerrainAzimuthBand | undefined,
  directionCount: number
): number[] {
  if (!band) {
    return Array.from({ length: directionCount }, (_, index) =>
      index / directionCount * 360
    );
  }
  const start = normalizeBearing(band.startDegrees);
  const end = normalizeBearing(band.endDegrees);
  const span = (end - start + 360) % 360;
  const stepDegrees = 5;
  const steps = Math.max(1, Math.ceil(span / stepDegrees));
  const bearings = Array.from({ length: steps + 1 }, (_, index) =>
    normalizeBearing(start + span * index / steps)
  );
  // 幅がほぼ0度でも中心方向を必ず1本取得する。
  return bearings.length > 0 ? bearings : [start];
}

export async function prefetchGsiTerrainAroundSubject(
  latitude: number,
  longitude: number,
  maximumDistanceMeters = 10_000,
  directionCount = 24,
  samplesPerDirection = 12,
  signal?: AbortSignal,
  azimuthBand?: GsiTerrainAzimuthBand
): Promise<{ sampledPoints: number; sampledDirections: number }> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("先行地形取得座標が不正です");
  }
  const earthRadius = 6_378_137;
  const originLatitude = latitude * Math.PI / 180;
  const originLongitude = longitude * Math.PI / 180;
  const bearings = bearingsForBand(azimuthBand, directionCount);
  const points: GsiElevationRequestPoint[] = [{ latitude, longitude, maximumDetail: "10m" }];
  for (const bearingDegrees of bearings) {
    const bearing = bearingDegrees * Math.PI / 180;
    for (let step = 1; step <= samplesPerDirection; step += 1) {
      const distance = maximumDistanceMeters * step / samplesPerDirection;
      const angularDistance = distance / earthRadius;
      const targetLatitude = Math.asin(
        Math.sin(originLatitude) * Math.cos(angularDistance) +
        Math.cos(originLatitude) * Math.sin(angularDistance) * Math.cos(bearing)
      );
      const targetLongitude = originLongitude + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(originLatitude),
        Math.cos(angularDistance) - Math.sin(originLatitude) * Math.sin(targetLatitude)
      );
      points.push({
        latitude: targetLatitude * 180 / Math.PI,
        longitude: ((targetLongitude * 180 / Math.PI + 540) % 360) - 180,
        maximumDetail: "10m",
      });
    }
  }
  await lookupGsiElevations(points, signal);
  return { sampledPoints: points.length, sampledDirections: bearings.length };
}
