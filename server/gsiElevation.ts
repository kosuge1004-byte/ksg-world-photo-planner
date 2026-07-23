import { inflateSync } from "node:zlib";

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

const GSI_TILE_SOURCES: ElevationTileSource[] = [
  // 国土地理院の公開順に合わせ、航空レーザ由来の1m/5m DEMを最優先する。
  { id: "dem1a_png", label: "DEM1A", zoom: 17 },
  { id: "dem5a_png", label: "DEM5A", zoom: 15 },
  { id: "dem5b_png", label: "DEM5B", zoom: 15 },
  { id: "dem5c_png", label: "DEM5C", zoom: 15 },
  { id: "dem_png", label: "DEM10B", zoom: 14 },
];

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_TILE_CACHE_ENTRIES = 128;
const MAX_CONCURRENT_GSI_TILE_REQUESTS = 8;
const tileCache = new Map<string, Promise<DecodedPng | null>>();
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

function tileCoordinates(
  point: GsiElevationRequestPoint,
  zoom: number
): { x: number; y: number; pixelX: number; pixelY: number } {
  const scale = 2 ** zoom;
  const normalizedX = (point.longitude + 180) / 360 * scale;
  const latitudeRadians = point.latitude * Math.PI / 180;
  const normalizedY = (
    1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI
  ) / 2 * scale;
  const x = Math.floor(normalizedX);
  const y = Math.floor(normalizedY);
  return {
    x,
    y,
    pixelX: Math.max(0, Math.min(255, Math.floor((normalizedX - x) * 256))),
    pixelY: Math.max(0, Math.min(255, Math.floor((normalizedY - y) * 256))),
  };
}

async function fetchDecodedTile(
  source: ElevationTileSource,
  x: number,
  y: number,
  signal?: AbortSignal
): Promise<DecodedPng | null> {
  const key = `${source.id}/${source.zoom}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  // 地形見通し線では多数の標高点を調べるため、国土地理院タイルへの同時接続数を制限する。
  const promise = withTileRequestLimit(async () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await fetch(
      `https://cyberjapandata.gsi.go.jp/xyz/${source.id}/${source.zoom}/${x}/${y}.png`,
      {
        headers: { Accept: "image/png" },
        signal,
      }
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`国土地理院標高タイル取得エラー：${response.status}`);
    }
    return decodePng(new Uint8Array(await response.arrayBuffer()));
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
  return promise;
}

function heightFromTile(
  tile: DecodedPng,
  pixelX: number,
  pixelY: number
): number | null {
  if (pixelX >= tile.width || pixelY >= tile.height) return null;
  const offset = (pixelY * tile.width + pixelX) * tile.bytesPerPixel;
  const red = tile.pixels[offset];
  const green = tile.pixels[offset + 1];
  const blue = tile.pixels[offset + 2];
  const encoded = red * 65_536 + green * 256 + blue;
  if (encoded === 2 ** 23) return null;
  return (encoded < 2 ** 23 ? encoded : encoded - 2 ** 24) * 0.01;
}

async function lookupOneElevation(
  point: GsiElevationRequestPoint,
  signal?: AbortSignal
): Promise<GsiElevationSample> {
  if (!isJapaneseCoverage(point)) {
    return { heightMeters: null, source: null };
  }
  const allowedSources = point.maximumDetail === "10m"
    ? GSI_TILE_SOURCES.filter((source) => source.label === "DEM10B")
    : point.maximumDetail === "5m"
      ? GSI_TILE_SOURCES.filter((source) => source.label !== "DEM1A")
      : GSI_TILE_SOURCES;
  for (const source of allowedSources) {
    const coordinate = tileCoordinates(point, source.zoom);
    const tile = await fetchDecodedTile(source, coordinate.x, coordinate.y, signal);
    if (!tile) continue;
    const heightMeters = heightFromTile(tile, coordinate.pixelX, coordinate.pixelY);
    if (heightMeters !== null) {
      return { heightMeters, source: source.label };
    }
  }
  return { heightMeters: null, source: null };
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
  return Promise.all(points.map((point) => lookupOneElevation(point, signal)));
}
