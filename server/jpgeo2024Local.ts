import {
  JPGEO2024_COLUMNS,
  JPGEO2024_LATITUDE_MAX,
  JPGEO2024_LATITUDE_MIN,
  JPGEO2024_LATITUDE_STEP,
  JPGEO2024_LONGITUDE_MAX,
  JPGEO2024_LONGITUDE_MIN,
  JPGEO2024_LONGITUDE_STEP,
  JPGEO2024_ROWS,
  JPGEO2024_SOURCE_ARCHIVE_SHA256,
  JPGEO2024_SOURCE_ENTRY_SHA256,
  JPGEO2024_TILE_BASE64,
  JPGEO2024_TILE_COLUMNS,
  JPGEO2024_TILE_ROWS,
  JPGEO2024_TILE_SIZE,
  JPGEO2024_VALUE_SCALE,
} from "./data/jpgeo2024.generated.ts";

const TILE_CACHE_MAX_ENTRIES = 96;
const tileCache = new Map<number, Int32Array>();

export const JPGEO2024_LOCAL_DATASET = Object.freeze({
  model: "JPGEO2024",
  sourceFormat: "ISG 2.0",
  sourceOrdering: "N-to-S, W-to-E",
  units: "metres",
  latitudeMin: JPGEO2024_LATITUDE_MIN,
  latitudeMax: JPGEO2024_LATITUDE_MAX,
  longitudeMin: JPGEO2024_LONGITUDE_MIN,
  longitudeMax: JPGEO2024_LONGITUDE_MAX,
  latitudeStep: JPGEO2024_LATITUDE_STEP,
  longitudeStep: JPGEO2024_LONGITUDE_STEP,
  rows: JPGEO2024_ROWS,
  columns: JPGEO2024_COLUMNS,
  points: JPGEO2024_ROWS * JPGEO2024_COLUMNS,
  sourceArchiveSha256: JPGEO2024_SOURCE_ARCHIVE_SHA256,
  sourceEntrySha256: JPGEO2024_SOURCE_ENTRY_SHA256,
});

function signedInt16(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset] | (bytes[offset + 1] << 8);
  return value & 0x8000 ? value - 0x10000 : value;
}

function signedInt32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function tileDimensions(tileRow: number, tileColumn: number): { height: number; width: number } {
  return {
    height: Math.min(JPGEO2024_TILE_SIZE, JPGEO2024_ROWS - tileRow * JPGEO2024_TILE_SIZE),
    width: Math.min(JPGEO2024_TILE_SIZE, JPGEO2024_COLUMNS - tileColumn * JPGEO2024_TILE_SIZE),
  };
}

/** Decode one independently addressable, lossless tile from the generated asset. */
function decodeTile(tileIndex: number): Int32Array {
  const tileRow = Math.floor(tileIndex / JPGEO2024_TILE_COLUMNS);
  const tileColumn = tileIndex - tileRow * JPGEO2024_TILE_COLUMNS;
  const { height, width } = tileDimensions(tileRow, tileColumn);
  const encoded = JPGEO2024_TILE_BASE64[tileIndex];
  if (typeof encoded !== "string") throw new Error(`JPGEO2024ローカルデータのタイル${tileIndex}がありません`);
  const bytes = decodeBase64(encoded);
  const values = new Int32Array(width * height);
  let offset = 0;

  values[0] = signedInt32(bytes, offset);
  offset += 4;
  for (let column = 1; column < width; column += 1) {
    values[column] = values[column - 1] + signedInt16(bytes, offset);
    offset += 2;
  }
  for (let row = 1; row < height; row += 1) {
    values[row * width] = values[(row - 1) * width] + signedInt16(bytes, offset);
    offset += 2;
  }
  for (let row = 1; row < height; row += 1) {
    for (let column = 1; column < width; column += 1) {
      let residual: number;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0x80) {
        residual = signedInt16(bytes, offset);
        offset += 2;
      } else {
        residual = marker >= 0x80 ? marker - 0x100 : marker;
      }
      const index = row * width + column;
      values[index] = values[index - 1] + values[index - width] - values[index - width - 1] + residual;
    }
  }
  if (offset !== bytes.length) {
    throw new Error(`JPGEO2024ローカルデータのタイル${tileIndex}が破損しています`);
  }
  return values;
}

function getTile(tileIndex: number): Int32Array {
  const cached = tileCache.get(tileIndex);
  if (cached) {
    tileCache.delete(tileIndex);
    tileCache.set(tileIndex, cached);
    return cached;
  }
  const decoded = decodeTile(tileIndex);
  tileCache.set(tileIndex, decoded);
  while (tileCache.size > TILE_CACHE_MAX_ENTRIES) {
    const oldest = tileCache.keys().next().value;
    if (typeof oldest !== "number") break;
    tileCache.delete(oldest);
  }
  return decoded;
}

function scaledGridValue(row: number, column: number): number {
  const tileRow = Math.floor(row / JPGEO2024_TILE_SIZE);
  const tileColumn = Math.floor(column / JPGEO2024_TILE_SIZE);
  const tileIndex = tileRow * JPGEO2024_TILE_COLUMNS + tileColumn;
  const localRow = row - tileRow * JPGEO2024_TILE_SIZE;
  const localColumn = column - tileColumn * JPGEO2024_TILE_SIZE;
  const { width } = tileDimensions(tileRow, tileColumn);
  return getTile(tileIndex)[localRow * width + localColumn];
}

export function hasLocalJpgeo2024Coverage(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= JPGEO2024_LATITUDE_MIN && latitude <= JPGEO2024_LATITUDE_MAX &&
    longitude >= JPGEO2024_LONGITUDE_MIN && longitude <= JPGEO2024_LONGITUDE_MAX;
}

/**
 * Return the JPGEO2024 geoid height N in metres using GSI's grid ordering and
 * bilinear interpolation. The generated integer tiles preserve all four source
 * decimals, so the only arithmetic after decoding is the interpolation itself.
 * `null` means the bundled Japan rectangle does not cover the coordinate.
 */
export function lookupLocalJpgeo2024Height(latitude: number, longitude: number): number | null {
  if (!hasLocalJpgeo2024Coverage(latitude, longitude)) return null;

  const safeLatitude = Math.min(JPGEO2024_LATITUDE_MAX, Math.max(JPGEO2024_LATITUDE_MIN, latitude));
  const safeLongitude = Math.min(JPGEO2024_LONGITUDE_MAX, Math.max(JPGEO2024_LONGITUDE_MIN, longitude));
  const rowCoordinate = (JPGEO2024_LATITUDE_MAX - safeLatitude) / JPGEO2024_LATITUDE_STEP;
  const columnCoordinate = (safeLongitude - JPGEO2024_LONGITUDE_MIN) / JPGEO2024_LONGITUDE_STEP;

  let northRow = Math.floor(rowCoordinate);
  let westColumn = Math.floor(columnCoordinate);
  let southWeight = rowCoordinate - northRow;
  let eastWeight = columnCoordinate - westColumn;
  if (northRow >= JPGEO2024_ROWS - 1) {
    northRow = JPGEO2024_ROWS - 2;
    southWeight = 1;
  }
  if (westColumn >= JPGEO2024_COLUMNS - 1) {
    westColumn = JPGEO2024_COLUMNS - 2;
    eastWeight = 1;
  }
  southWeight = Math.min(1, Math.max(0, southWeight));
  eastWeight = Math.min(1, Math.max(0, eastWeight));

  const northWest = scaledGridValue(northRow, westColumn);
  const northEast = scaledGridValue(northRow, westColumn + 1);
  const southWest = scaledGridValue(northRow + 1, westColumn);
  const southEast = scaledGridValue(northRow + 1, westColumn + 1);
  const north = northWest + (northEast - northWest) * eastWeight;
  const south = southWest + (southEast - southWest) * eastWeight;
  return (north + (south - north) * southWeight) / JPGEO2024_VALUE_SCALE;
}

/** Test/diagnostic hook; production correctness never depends on cache state. */
export function clearLocalJpgeo2024TileCache(): void {
  tileCache.clear();
}

if (JPGEO2024_TILE_BASE64.length !== JPGEO2024_TILE_ROWS * JPGEO2024_TILE_COLUMNS) {
  throw new Error("JPGEO2024ローカルデータのタイル数が不正です");
}
