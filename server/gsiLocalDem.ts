import { gunzipSync } from "node:zlib";
import { bilinearInterpolate } from "./bilinearInterpolation.ts";
import {
  constrainedBicubicInterpolate,
  type BicubicGrid4x4,
} from "./constrainedBicubicInterpolation.ts";
import { serverPersistentCache } from "./cloudflareRuntime.ts";
import { createAbortError } from "./runtimeErrors.ts";

/**
 * R2 に事前配置する、基盤地図情報 GML 由来のローカル DEM。
 * DEM10A は配布データの保存対象には含めるが、現在の AstroSight の
 * authoritative source 順には無いため lookup 側からは要求されない。
 */
export type LocalGsiDemSource =
  | "DEM1A"
  | "DEM5A"
  | "DEM5B"
  | "DEM5C"
  | "DEM10A"
  | "DEM10B";

export type LocalDemGridAsset = {
  width: number;
  height: number;
  south: number;
  west: number;
  north: number;
  east: number;
  latitudeStep: number;
  longitudeStep: number;
  /** +x-y（西から東、その後北から南）、単位 cm。 */
  heightsCentimeters: Int32Array;
};

export type LocalDemLookupRequest = {
  index: number;
  latitude: number;
  longitude: number;
  interpolation: "bilinear" | "constrained-bicubic";
  interpolationMode: "los-safe" | "neutral";
};

const LOCAL_DEM_PREFIX = "gsi-local-dem-v1";
export const LOCAL_DEM_MANIFEST_KEY = `${LOCAL_DEM_PREFIX}/manifest.json`;
export const LOCAL_DEM_NO_DATA_CENTIMETERS = -2_147_483_648;

const MAGIC = new TextEncoder().encode("ASDEM001");
const HEADER_BYTES = 80;
const ENCODING_CENTIMETERS_INT32_LE = 1;
const MAX_GRID_POINTS = 2_000_000;
// The same isolate also owns the decoded PNG fallback cache and batch response.
// Leave enough of Workers' 128 MiB limit for those paths and temporary gunzip
// buffers. One largest observed native grid is about 3.4 MiB, so 32 MiB still
// keeps the base grid and all eight neighbours needed by a 4x4 interpolation.
const WORKER_MEMORY_BYTES = 32 * 1024 * 1024;
let maximumMemoryBytes = WORKER_MEMORY_BYTES;
const LOCAL_READ_CONCURRENCY = 2;
const MISSING_ASSET_TTL_MS = 5 * 60_000;
const INVALID_ASSET_TTL_MS = 30_000;
const MAX_NEGATIVE_CACHE_ENTRIES = 4_096;

type MemoryEntry = { asset: LocalDemGridAsset; bytes: number };
const memoryAssets = new Map<string, MemoryEntry>();
const inFlightAssets = new Map<string, Promise<LocalDemGridAsset | null>>();
const unavailableAssets = new Map<string, number>();
let memoryBytes = 0;

let manifestPromise: Promise<boolean> | null = null;
let manifestResult: { enabled: boolean; expiresAt: number } | null = null;

function byteView(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function validateAsset(asset: LocalDemGridAsset): void {
  const pointCount = asset.width * asset.height;
  if (
    !Number.isInteger(asset.width) ||
    !Number.isInteger(asset.height) ||
    asset.width <= 1 ||
    asset.height <= 1 ||
    pointCount > MAX_GRID_POINTS ||
    asset.heightsCentimeters.length !== pointCount ||
    !Number.isFinite(asset.south) ||
    !Number.isFinite(asset.west) ||
    !Number.isFinite(asset.north) ||
    !Number.isFinite(asset.east) ||
    !Number.isFinite(asset.latitudeStep) ||
    !Number.isFinite(asset.longitudeStep) ||
    asset.south >= asset.north ||
    asset.west >= asset.east ||
    asset.latitudeStep <= 0 ||
    asset.longitudeStep <= 0
  ) {
    throw new Error("ローカルDEMグリッドのメタデータが不正です");
  }
  const expectedLatitudeStep = (asset.north - asset.south) / asset.height;
  const expectedLongitudeStep = (asset.east - asset.west) / asset.width;
  const epsilon = 1e-11;
  if (
    Math.abs(asset.latitudeStep - expectedLatitudeStep) > epsilon ||
    Math.abs(asset.longitudeStep - expectedLongitudeStep) > epsilon
  ) {
    throw new Error("ローカルDEMグリッドの格子間隔がbboxと一致しません");
  }
}

/**
 * R2 オブジェクトの非圧縮本体を作る。呼び出し側の前処理スクリプトはこれを
 * gzip し、`.bin.gz` として配置する。高さは現行 PNG タイルと同じ cm 整数で
 * 保持するため、シリアライズによる精度低下は生じない。
 */
export function encodeLocalDemAsset(asset: LocalDemGridAsset): ArrayBuffer {
  validateAsset(asset);
  const output = new ArrayBuffer(
    HEADER_BYTES + asset.heightsCentimeters.length * Int32Array.BYTES_PER_ELEMENT
  );
  const bytes = new Uint8Array(output);
  bytes.set(MAGIC, 0);
  const view = new DataView(output);
  view.setUint32(8, HEADER_BYTES, true);
  view.setUint32(12, asset.width, true);
  view.setUint32(16, asset.height, true);
  view.setFloat64(20, asset.south, true);
  view.setFloat64(28, asset.west, true);
  view.setFloat64(36, asset.north, true);
  view.setFloat64(44, asset.east, true);
  view.setFloat64(52, asset.latitudeStep, true);
  view.setFloat64(60, asset.longitudeStep, true);
  view.setUint32(68, ENCODING_CENTIMETERS_INT32_LE, true);
  view.setUint32(72, asset.heightsCentimeters.length, true);
  view.setUint32(76, 0, true);
  for (let index = 0; index < asset.heightsCentimeters.length; index += 1) {
    view.setInt32(
      HEADER_BYTES + index * Int32Array.BYTES_PER_ELEMENT,
      asset.heightsCentimeters[index],
      true
    );
  }
  return output;
}

/** gzip 済み・非圧縮のどちらも読み取れる（テストと段階移行用）。 */
export function decodeLocalDemAsset(
  input: ArrayBuffer | Uint8Array
): LocalDemGridAsset {
  let bytes = byteView(input);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = gunzipSync(bytes);
  }
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error("ローカルDEMアセットが短すぎます");
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      throw new Error("ローカルDEMアセットの識別子が不正です");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerBytes = view.getUint32(8, true);
  const width = view.getUint32(12, true);
  const height = view.getUint32(16, true);
  const pointCount = view.getUint32(72, true);
  if (
    headerBytes !== HEADER_BYTES ||
    view.getUint32(68, true) !== ENCODING_CENTIMETERS_INT32_LE ||
    pointCount !== width * height ||
    pointCount > MAX_GRID_POINTS ||
    bytes.byteLength !== HEADER_BYTES + pointCount * Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("ローカルDEMアセットの寸法または符号化が不正です");
  }
  const heightsCentimeters = new Int32Array(pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    heightsCentimeters[index] = view.getInt32(
      HEADER_BYTES + index * Int32Array.BYTES_PER_ELEMENT,
      true
    );
  }
  const asset: LocalDemGridAsset = {
    width,
    height,
    south: view.getFloat64(20, true),
    west: view.getFloat64(28, true),
    north: view.getFloat64(36, true),
    east: view.getFloat64(44, true),
    latitudeStep: view.getFloat64(52, true),
    longitudeStep: view.getFloat64(60, true),
    heightsCentimeters,
  };
  validateAsset(asset);
  return asset;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** JIS X 0410 の2次（6桁）または3次（8桁）メッシュコード。 */
export function localDemMeshCode(
  source: LocalGsiDemSource,
  latitude: number,
  longitude: number
): string | null {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < 0 ||
    latitude >= 66.6666666667 ||
    longitude < 100 ||
    longitude >= 180
  ) {
    return null;
  }
  const latitudeUnits = latitude * 1.5;
  const primaryLatitude = Math.floor(latitudeUnits);
  const primaryLongitude = Math.floor(longitude) - 100;
  const latitudeWithinPrimary = (latitudeUnits - primaryLatitude) * 8;
  const longitudeWithinPrimary = (longitude - Math.floor(longitude)) * 8;
  const secondaryLatitude = Math.min(7, Math.floor(latitudeWithinPrimary + 1e-10));
  const secondaryLongitude = Math.min(7, Math.floor(longitudeWithinPrimary + 1e-10));
  const second =
    `${twoDigits(primaryLatitude)}${twoDigits(primaryLongitude)}` +
    `${secondaryLatitude}${secondaryLongitude}`;
  if (source === "DEM10A" || source === "DEM10B") return second;

  const tertiaryLatitude = Math.min(
    9,
    Math.floor((latitudeWithinPrimary - secondaryLatitude) * 10 + 1e-9)
  );
  const tertiaryLongitude = Math.min(
    9,
    Math.floor((longitudeWithinPrimary - secondaryLongitude) * 10 + 1e-9)
  );
  return `${second}${Math.max(0, tertiaryLatitude)}${Math.max(0, tertiaryLongitude)}`;
}

export function localDemAssetKey(source: LocalGsiDemSource, meshCode: string): string {
  return `${LOCAL_DEM_PREFIX}/${source}/${meshCode}.bin.gz`;
}

export type LocalDemMeshBounds = {
  south: number;
  west: number;
  north: number;
  east: number;
};

/** Exact JIS X 0410 bounds represented by a 2nd/3rd-level mesh code. */
export function localDemMeshBounds(meshCode: string): LocalDemMeshBounds | null {
  if (!/^\d{6}(?:\d{2})?$/.test(meshCode)) return null;
  const primaryLatitude = Number(meshCode.slice(0, 2));
  const primaryLongitude = Number(meshCode.slice(2, 4));
  const secondaryLatitude = Number(meshCode[4]);
  const secondaryLongitude = Number(meshCode[5]);
  if (
    primaryLatitude > 99 ||
    primaryLongitude > 99 ||
    secondaryLatitude > 7 ||
    secondaryLongitude > 7
  ) {
    return null;
  }
  let south = primaryLatitude / 1.5 + secondaryLatitude / 12;
  let west = primaryLongitude + 100 + secondaryLongitude / 8;
  let latitudeSpan = 1 / 12;
  let longitudeSpan = 1 / 8;
  if (meshCode.length === 8) {
    const tertiaryLatitude = Number(meshCode[6]);
    const tertiaryLongitude = Number(meshCode[7]);
    south += tertiaryLatitude / 120;
    west += tertiaryLongitude / 80;
    latitudeSpan = 1 / 120;
    longitudeSpan = 1 / 80;
  }
  return {
    south,
    west,
    north: south + latitudeSpan,
    east: west + longitudeSpan,
  };
}

function validateAssetIdentity(
  source: LocalGsiDemSource,
  meshCode: string,
  asset: LocalDemGridAsset
): void {
  const expectedLength = source === "DEM10A" || source === "DEM10B" ? 6 : 8;
  const bounds = localDemMeshBounds(meshCode);
  if (!bounds || meshCode.length !== expectedLength) {
    throw new Error(`ローカルDEMのメッシュコードが${source}と一致しません`);
  }
  // GML writes repeating fractions to nine decimal places, so compare bounds
  // with a tolerance while still rejecting an asset from any adjacent mesh.
  const toleranceDegrees = 2e-9;
  if (
    Math.abs(asset.south - bounds.south) > toleranceDegrees ||
    Math.abs(asset.west - bounds.west) > toleranceDegrees ||
    Math.abs(asset.north - bounds.north) > toleranceDegrees ||
    Math.abs(asset.east - bounds.east) > toleranceDegrees
  ) {
    throw new Error(`ローカルDEM ${source}/${meshCode} のbboxがメッシュ範囲と一致しません`);
  }
}

function rawHeight(
  asset: LocalDemGridAsset,
  x: number,
  y: number
): number | null | undefined {
  if (x < 0 || y < 0 || x >= asset.width || y >= asset.height) return undefined;
  const centimeters = asset.heightsCentimeters[y * asset.width + x];
  return centimeters === LOCAL_DEM_NO_DATA_CENTIMETERS ? null : centimeters * 0.01;
}

/**
 * 配布 GML の bbox はセル外周、tupleList はセル中心の値であるため、
 * 西端/北端から半セルずらして連続グリッド座標へ変換する。
 *
 * メッシュ境界では隣接 GML を暗黙複製しない。必要な近傍が同一アセットに
 * 無い場合は null を返し、呼び出し元が既存タイルへフォールバックする。
 */
export function heightFromLocalDemAsset(
  asset: LocalDemGridAsset,
  latitude: number,
  longitude: number,
  interpolation: "bilinear" | "constrained-bicubic",
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): number | null {
  const gridX = (longitude - asset.west) / asset.longitudeStep - 0.5;
  const gridY = (asset.north - latitude) / asset.latitudeStep - 0.5;
  if (!Number.isFinite(gridX) || !Number.isFinite(gridY)) return null;
  const pixelX = Math.floor(gridX);
  const pixelY = Math.floor(gridY);
  const fracX = gridX - pixelX;
  const fracY = gridY - pixelY;

  const topLeft = rawHeight(asset, pixelX, pixelY);
  const topRight = rawHeight(asset, pixelX + 1, pixelY);
  const bottomLeft = rawHeight(asset, pixelX, pixelY + 1);
  const bottomRight = rawHeight(asset, pixelX + 1, pixelY + 1);
  // undefined はアセット境界。既存経路へ戻し、端値の複製による精度低下を防ぐ。
  if (
    topLeft === undefined ||
    topRight === undefined ||
    bottomLeft === undefined ||
    bottomRight === undefined
  ) {
    return null;
  }
  if (topLeft === null && topRight === null && bottomLeft === null && bottomRight === null) {
    return null;
  }
  if (topLeft === null || topRight === null || bottomLeft === null || bottomRight === null) {
    return fracX < 0.5
      ? fracY < 0.5 ? topLeft : bottomLeft
      : fracY < 0.5 ? topRight : bottomRight;
  }
  const bilinearHeight = bilinearInterpolate(
    { topLeft, topRight, bottomLeft, bottomRight },
    fracX,
    fracY
  );
  if (interpolation === "bilinear") return bilinearHeight;

  const rows: number[][] = [];
  for (let offsetY = -1; offsetY <= 2; offsetY += 1) {
    const row: number[] = [];
    for (let offsetX = -1; offsetX <= 2; offsetX += 1) {
      const value = rawHeight(asset, pixelX + offsetX, pixelY + offsetY);
      // GML メッシュ境界なら公開タイル経路へ戻す。NoData だけなら現行と同じ
      // Bilinear フォールバックを使う。
      if (value === undefined) return null;
      if (value === null) return bilinearHeight;
      row.push(value);
    }
    rows.push(row);
  }
  const bicubicHeight = constrainedBicubicInterpolate(
    rows as unknown as BicubicGrid4x4,
    fracX,
    fracY
  );
  return interpolationMode === "neutral"
    ? bicubicHeight
    : Math.max(bilinearHeight, bicubicHeight);
}

function gridPosition(
  asset: LocalDemGridAsset,
  latitude: number,
  longitude: number
): { pixelX: number; pixelY: number; fracX: number; fracY: number } | null {
  const gridX = (longitude - asset.west) / asset.longitudeStep - 0.5;
  const gridY = (asset.north - latitude) / asset.latitudeStep - 0.5;
  if (!Number.isFinite(gridX) || !Number.isFinite(gridY)) return null;
  const pixelX = Math.floor(gridX);
  const pixelY = Math.floor(gridY);
  return {
    pixelX,
    pixelY,
    fracX: gridX - pixelX,
    fracY: gridY - pixelY,
  };
}

function coordinateForGridSample(
  asset: LocalDemGridAsset,
  x: number,
  y: number
): { latitude: number; longitude: number } {
  return {
    latitude: asset.north - (y + 0.5) * asset.latitudeStep,
    longitude: asset.west + (x + 0.5) * asset.longitudeStep,
  };
}

function rawHeightAtCoordinate(
  asset: LocalDemGridAsset,
  latitude: number,
  longitude: number
): number | null | undefined {
  const gridX = (longitude - asset.west) / asset.longitudeStep - 0.5;
  const gridY = (asset.north - latitude) / asset.latitudeStep - 0.5;
  const x = Math.round(gridX);
  const y = Math.round(gridY);
  // GML bounds use decimal representations of repeating fractions. Permit the
  // resulting sub-cell floating error, but never silently snap a real offset.
  if (Math.abs(gridX - x) > 0.001 || Math.abs(gridY - y) > 0.001) return undefined;
  return rawHeight(asset, x, y);
}

function interpolationOffsets(
  interpolation: "bilinear" | "constrained-bicubic"
): Array<{ x: number; y: number }> {
  const offsets: Array<{ x: number; y: number }> = [];
  const start = interpolation === "constrained-bicubic" ? -1 : 0;
  const end = interpolation === "constrained-bicubic" ? 2 : 1;
  for (let y = start; y <= end; y += 1) {
    for (let x = start; x <= end; x += 1) offsets.push({ x, y });
  }
  return offsets;
}

function requiredMeshCodes(
  source: LocalGsiDemSource,
  baseAsset: LocalDemGridAsset,
  latitude: number,
  longitude: number,
  interpolation: "bilinear" | "constrained-bicubic"
): Set<string> | null {
  const position = gridPosition(baseAsset, latitude, longitude);
  if (!position) return null;
  const meshCodes = new Set<string>();
  for (const offset of interpolationOffsets(interpolation)) {
    const coordinate = coordinateForGridSample(
      baseAsset,
      position.pixelX + offset.x,
      position.pixelY + offset.y
    );
    const meshCode = localDemMeshCode(source, coordinate.latitude, coordinate.longitude);
    if (!meshCode) return null;
    meshCodes.add(meshCode);
  }
  return meshCodes;
}

/**
 * Interpolate across native GML mesh boundaries using the true adjacent asset.
 * If any required asset is absent or misaligned, return null so the existing
 * decoded-PNG path performs the whole calculation instead of mixing grids.
 */
export function heightFromLocalDemAssetSet(
  source: LocalGsiDemSource,
  assetsByMeshCode: ReadonlyMap<string, LocalDemGridAsset>,
  latitude: number,
  longitude: number,
  interpolation: "bilinear" | "constrained-bicubic",
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): number | null {
  const baseMeshCode = localDemMeshCode(source, latitude, longitude);
  if (!baseMeshCode) return null;
  const baseAsset = assetsByMeshCode.get(baseMeshCode);
  if (!baseAsset) return null;
  const position = gridPosition(baseAsset, latitude, longitude);
  if (!position) return null;

  const sample = (offsetX: number, offsetY: number): number | null | undefined => {
    const coordinate = coordinateForGridSample(
      baseAsset,
      position.pixelX + offsetX,
      position.pixelY + offsetY
    );
    const meshCode = localDemMeshCode(source, coordinate.latitude, coordinate.longitude);
    if (!meshCode) return undefined;
    const asset = assetsByMeshCode.get(meshCode);
    if (!asset) return undefined;
    return rawHeightAtCoordinate(asset, coordinate.latitude, coordinate.longitude);
  };

  const topLeft = sample(0, 0);
  const topRight = sample(1, 0);
  const bottomLeft = sample(0, 1);
  const bottomRight = sample(1, 1);
  if (
    topLeft === undefined ||
    topRight === undefined ||
    bottomLeft === undefined ||
    bottomRight === undefined
  ) {
    return null;
  }
  if (topLeft === null && topRight === null && bottomLeft === null && bottomRight === null) {
    return null;
  }
  if (topLeft === null || topRight === null || bottomLeft === null || bottomRight === null) {
    return position.fracX < 0.5
      ? position.fracY < 0.5 ? topLeft : bottomLeft
      : position.fracY < 0.5 ? topRight : bottomRight;
  }
  const bilinearHeight = bilinearInterpolate(
    { topLeft, topRight, bottomLeft, bottomRight },
    position.fracX,
    position.fracY
  );
  if (interpolation === "bilinear") return bilinearHeight;

  const rows: number[][] = [];
  for (let offsetY = -1; offsetY <= 2; offsetY += 1) {
    const row: number[] = [];
    for (let offsetX = -1; offsetX <= 2; offsetX += 1) {
      const value = sample(offsetX, offsetY);
      if (value === undefined) return null;
      if (value === null) return bilinearHeight;
      row.push(value);
    }
    rows.push(row);
  }
  const bicubicHeight = constrainedBicubicInterpolate(
    rows as unknown as BicubicGrid4x4,
    position.fracX,
    position.fracY
  );
  return interpolationMode === "neutral"
    ? bicubicHeight
    : Math.max(bilinearHeight, bicubicHeight);
}

function rememberAsset(key: string, asset: LocalDemGridAsset): void {
  const bytes = asset.heightsCentimeters.byteLength + HEADER_BYTES;
  const previous = memoryAssets.get(key);
  if (previous) memoryBytes -= previous.bytes;
  memoryAssets.delete(key);
  memoryAssets.set(key, { asset, bytes });
  memoryBytes += bytes;
  while (memoryBytes > maximumMemoryBytes && memoryAssets.size > 1) {
    const oldestKey = memoryAssets.keys().next().value;
    if (typeof oldestKey !== "string") break;
    const oldest = memoryAssets.get(oldestKey);
    memoryAssets.delete(oldestKey);
    memoryBytes -= oldest?.bytes ?? 0;
  }
}

/**
 * The Cloudflare default stays at 32 MiB. The private PC origin and the offline
 * generator may opt into a larger LRU because they have much more memory and
 * repeatedly revisit the same native meshes while calculating 360 bearings.
 */
export function configureLocalDemMemoryBudgetForPrivateOrigin(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < WORKER_MEMORY_BYTES || bytes > 2 * 1024 * 1024 * 1024) {
    throw new Error("local DEM memory budget is invalid");
  }
  maximumMemoryBytes = bytes;
}

async function localDemManifestAvailable(): Promise<boolean> {
  const persistentCache = serverPersistentCache();
  if (!persistentCache) return false;
  const now = Date.now();
  if (manifestResult && manifestResult.expiresAt > now) return manifestResult.enabled;
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const fallback = persistentCache.getWithStatus
        ? undefined
        : await persistentCache.get(LOCAL_DEM_MANIFEST_KEY, { type: "arrayBuffer" });
      const read = persistentCache.getWithStatus
        ? await persistentCache.getWithStatus(LOCAL_DEM_MANIFEST_KEY, { type: "arrayBuffer" })
        : {
            status: fallback instanceof ArrayBuffer ? "hit" as const : "miss" as const,
            value: fallback ?? null,
          };
      if (read.status !== "hit" || !(read.value instanceof ArrayBuffer)) {
        // 通常の未導入環境では短時間だけ負の結果を保持し、各DEMソースごとの
        // 存在確認を増やさない。bypass は一過性の可能性があるため保持しない。
        if (read.status === "miss") {
          manifestResult = { enabled: false, expiresAt: now + 30_000 };
        }
        return false;
      }
      const parsed = JSON.parse(new TextDecoder().decode(read.value)) as {
        schemaVersion?: unknown;
        format?: unknown;
      };
      const enabled = parsed.schemaVersion === 1 && parsed.format === "astrosight-gsi-local-dem-v1";
      manifestResult = { enabled, expiresAt: now + (enabled ? 300_000 : 30_000) };
      return enabled;
    } catch {
      return false;
    } finally {
      manifestPromise = null;
    }
  })();
  return manifestPromise;
}

function unavailableAssetIsFresh(key: string): boolean {
  const expiresAt = unavailableAssets.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    unavailableAssets.delete(key);
    return false;
  }
  // Refresh Map insertion order so frequently requested missing coverage stays
  // cached while old one-off misses are discarded first.
  unavailableAssets.delete(key);
  unavailableAssets.set(key, expiresAt);
  return true;
}

function rememberUnavailableAsset(key: string, ttlMs: number): void {
  unavailableAssets.delete(key);
  unavailableAssets.set(key, Date.now() + ttlMs);
  while (unavailableAssets.size > MAX_NEGATIVE_CACHE_ENTRIES) {
    const oldestKey = unavailableAssets.keys().next().value;
    if (typeof oldestKey !== "string") break;
    unavailableAssets.delete(oldestKey);
  }
}

async function loadAsset(
  source: LocalGsiDemSource,
  meshCode: string
): Promise<LocalDemGridAsset | null> {
  const key = localDemAssetKey(source, meshCode);
  const memory = memoryAssets.get(key);
  if (memory) {
    memoryAssets.delete(key);
    memoryAssets.set(key, memory);
    return memory.asset;
  }
  if (unavailableAssetIsFresh(key)) return null;
  const shared = inFlightAssets.get(key);
  if (shared) return shared;
  const promise = (async () => {
    const persistentCache = serverPersistentCache();
    if (!persistentCache) return null;
    try {
      const fallback = persistentCache.getWithStatus
        ? undefined
        : await persistentCache.get(key, { type: "arrayBuffer" });
      const read = persistentCache.getWithStatus
        ? await persistentCache.getWithStatus(key, { type: "arrayBuffer" })
        : {
            status: fallback instanceof ArrayBuffer ? "hit" as const : "miss" as const,
            value: fallback ?? null,
          };
      if (read.status !== "hit" || !(read.value instanceof ArrayBuffer)) {
        // Cache only authoritative misses. A safety-budget/R2 bypass must be
        // retried on the next call and immediately falls through to GSI now.
        if (read.status === "miss") rememberUnavailableAsset(key, MISSING_ASSET_TTL_MS);
        return null;
      }
      const asset = decodeLocalDemAsset(read.value);
      validateAssetIdentity(source, meshCode, asset);
      rememberAsset(key, asset);
      return asset;
    } catch (error) {
      rememberUnavailableAsset(key, INVALID_ASSET_TTL_MS);
      console.warn(`ローカルDEMアセット ${key} を利用できません`, error);
      return null;
    }
  })();
  inFlightAssets.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inFlightAssets.get(key) === promise) inFlightAssets.delete(key);
  }
}

/**
 * 1つの既存DEMソースについて R2 の GML 由来データを先に解決する。
 * 未導入・未収録・NoData・破損時は結果 Map に入れないため、呼び出し元の
 * 公開 PNG タイル経路がそのままフォールバックになる。補間がメッシュ境界を
 * またぐ場合は隣接ローカルアセットも読み、真の近傍値を使う。
 */
export async function lookupLocalDemElevationsForSource(
  source: Exclude<LocalGsiDemSource, "DEM10A">,
  requests: readonly LocalDemLookupRequest[],
  signal?: AbortSignal
): Promise<Map<number, number>> {
  const resolved = new Map<number, number>();
  if (requests.length === 0 || !await localDemManifestAvailable()) return resolved;
  if (signal?.aborted) throw createAbortError();

  const grouped = new Map<string, LocalDemLookupRequest[]>();
  for (const request of requests) {
    const meshCode = localDemMeshCode(source, request.latitude, request.longitude);
    if (!meshCode) continue;
    const group = grouped.get(meshCode);
    if (group) group.push(request);
    else grouped.set(meshCode, [request]);
  }
  // Process one base mesh at a time. A DEM1/DEM10 grid is about 3.4 MiB and a
  // bicubic point can require eight adjacent meshes; retaining several such
  // groups concurrently would leave too little headroom in a 128 MiB Worker.
  for (const [baseMeshCode, group] of grouped) {
    if (signal?.aborted) throw createAbortError();
    const baseAsset = await loadAsset(source, baseMeshCode);
    if (!baseAsset) continue;
    const neededMeshCodes = new Set<string>([baseMeshCode]);
    for (const request of group) {
      const required = requiredMeshCodes(
        source,
        baseAsset,
        request.latitude,
        request.longitude,
        request.interpolation
      );
      if (required) {
        for (const meshCode of required) neededMeshCodes.add(meshCode);
      }
    }
    const assets = new Map<string, LocalDemGridAsset>([[baseMeshCode, baseAsset]]);
    const neighbourCodes = [...neededMeshCodes].filter((meshCode) => meshCode !== baseMeshCode);
    for (let offset = 0; offset < neighbourCodes.length; offset += LOCAL_READ_CONCURRENCY) {
      if (signal?.aborted) throw createAbortError();
      const chunk = neighbourCodes.slice(offset, offset + LOCAL_READ_CONCURRENCY);
      const loaded = await Promise.all(chunk.map(async (meshCode) => ({
        meshCode,
        asset: await loadAsset(source, meshCode),
      })));
      for (const entry of loaded) {
        if (entry.asset) assets.set(entry.meshCode, entry.asset);
      }
    }
    for (const request of group) {
      const height = heightFromLocalDemAssetSet(
        source,
        assets,
        request.latitude,
        request.longitude,
        request.interpolation,
        request.interpolationMode
      );
      if (height !== null) resolved.set(request.index, height);
    }
  }
  return resolved;
}

/** Regression tests only; production callers must not depend on process cache state. */
export function resetLocalDemRuntimeCacheForTests(): void {
  memoryAssets.clear();
  inFlightAssets.clear();
  unavailableAssets.clear();
  memoryBytes = 0;
  manifestPromise = null;
  manifestResult = null;
}

/** Utility for scripts/tests that need an exact, offset-free ArrayBuffer. */
export function localDemBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return exactArrayBuffer(bytes);
}
