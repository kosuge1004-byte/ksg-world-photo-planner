import type { GsiElevationApiSample } from "../types/geospatial";
import type { GsiElevationClientPoint } from "./gsiElevationClient";

/**
 * Device-side decoded GSI DEM tile cache.
 *
 * Safety rules:
 * - This cache never quantizes query coordinates.
 * - A point is resolved locally only when every tile needed to reproduce the
 *   server-side source-priority/interpolation decision is present.
 * - Any missing/corrupt/expired tile returns `null` so the caller uses the
 *   existing /api/gsi-elevation path instead.
 * - Empty (404/not-covered) tiles are cached explicitly; transient failures are not.
 */

type GsiSource = "DEM1A" | "DEM5A" | "DEM5B" | "DEM5C" | "DEM10B";
type MaximumDetail = "1m" | "5m" | "10m";
type InterpolationMode = "los-safe" | "neutral";

type SourceDefinition = {
  label: GsiSource;
  id: string;
  zoom: number;
};

const SOURCES: readonly SourceDefinition[] = [
  { id: "dem1a_png", label: "DEM1A", zoom: 17 },
  { id: "dem5a_png", label: "DEM5A", zoom: 15 },
  { id: "dem5b_png", label: "DEM5B", zoom: 15 },
  { id: "dem5c_png", label: "DEM5C", zoom: 15 },
  { id: "dem_png", label: "DEM10B", zoom: 14 },
] as const;

const DB_NAME = "ksg-world-photo-planner-dem-tiles-v1";
const STORE_NAME = "tiles";
const CACHE_SCHEMA_VERSION = "gsi-dem-device-v1";
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const NO_DATA_HEIGHT_CENTIMETERS = -2_147_483_648;
const TILE_SIZE = 256;
const MEMORY_MAX_ENTRIES = 48;
const PERSISTED_MAX_ENTRIES = 192;
const PREFETCH_CONCURRENCY = 2;
const PREFETCH_MAX_TILES_PER_CALL = 24;

type StoredTile = {
  key: string;
  width: number;
  height: number;
  empty: boolean;
  heightsBuffer: ArrayBuffer | null;
  updatedAt: number;
  accessedAt: number;
};

type DecodedTile = {
  width: number;
  height: number;
  heightsCentimeters: Int32Array;
};

type TileLookup = { kind: "empty" } | { kind: "data"; tile: DecodedTile };

type IdbRequest<T> = {
  result: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};

type IdbStore = {
  get: (key: string) => IdbRequest<unknown>;
  put: (value: unknown) => IdbRequest<unknown>;
  delete: (key: string) => IdbRequest<unknown>;
  getAll: () => IdbRequest<unknown>;
};

type IdbTransaction = {
  objectStore: (name: string) => IdbStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

type IdbDatabase = {
  objectStoreNames: { contains: (name: string) => boolean };
  createObjectStore: (name: string, options: { keyPath: string }) => IdbStore;
  transaction: (name: string, mode: "readonly" | "readwrite") => IdbTransaction;
  close: () => void;
  onversionchange?: (() => void) | null;
};

type IdbFactory = { open: (name: string, version: number) => IdbRequest<IdbDatabase> };

const memoryCache = new Map<string, TileLookup>();
const inFlightPrefetch = new Map<string, Promise<void>>();
const inFlightReads = new Map<string, Promise<TileLookup | null>>();
let databasePromise: Promise<IdbDatabase | null> | null = null;
let writesSinceCleanup = 0;

function getIndexedDbFactory(): IdbFactory | null {
  const runtimeGlobal = globalThis as unknown as { indexedDB?: IdbFactory };
  return runtimeGlobal.indexedDB ?? null;
}

function openDatabase(): Promise<IdbDatabase | null> {
  const indexedDb = getIndexedDbFactory();
  if (!indexedDb) return Promise.resolve(null);
  databasePromise ??= new Promise((resolve) => {
    const request = indexedDb.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      resolve(null);
    };
  });
  return databasePromise;
}

function tileKey(source: SourceDefinition, x: number, y: number): string {
  return `${CACHE_SCHEMA_VERSION}/${source.id}/${source.zoom}/${x}/${y}`;
}

function writeMemory(key: string, value: TileLookup): void {
  memoryCache.delete(key);
  memoryCache.set(key, value);
  while (memoryCache.size > MEMORY_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryCache.delete(oldest);
  }
}

function copyInt32ArrayToArrayBuffer(values: Int32Array): ArrayBuffer {
  const copy = new Int32Array(values.length);
  copy.set(values);
  return copy.buffer;
}

function storedToLookup(record: StoredTile): TileLookup | null {
  if (record.empty) return { kind: "empty" };
  if (!record.heightsBuffer || record.width <= 0 || record.height <= 0) return null;
  if (record.heightsBuffer.byteLength !== record.width * record.height * Int32Array.BYTES_PER_ELEMENT) {
    return null;
  }
  // Copy so IndexedDB-owned buffers cannot be detached/mutated under us.
  const copied = record.heightsBuffer.slice(0);
  return {
    kind: "data",
    tile: { width: record.width, height: record.height, heightsCentimeters: new Int32Array(copied) },
  };
}

async function readTile(source: SourceDefinition, x: number, y: number): Promise<TileLookup | null> {
  const key = tileKey(source, x, y);
  const memory = memoryCache.get(key);
  if (memory) {
    memoryCache.delete(key);
    memoryCache.set(key, memory);
    return memory;
  }
  // Multiple celestial candidates often ask for the same DEM tile at the same
  // moment. Share the IndexedDB read so precision/data are unchanged while the
  // browser performs only one transaction/request for that tile.
  const existing = inFlightReads.get(key);
  if (existing) return existing;
  const requestPromise = (async (): Promise<TileLookup | null> => {
    const database = await openDatabase();
    if (!database) return null;
    return await new Promise<TileLookup | null>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => {
        const record = request.result as StoredTile | undefined;
        if (!record || Date.now() - record.updatedAt > MAX_AGE_MS) {
          resolve(null);
          return;
        }
        const lookup = storedToLookup(record);
        if (lookup) writeMemory(key, lookup);
        resolve(lookup);
      };
      request.onerror = () => resolve(null);
    });
  })().finally(() => {
    if (inFlightReads.get(key) === requestPromise) inFlightReads.delete(key);
  });
  inFlightReads.set(key, requestPromise);
  return requestPromise;
}



async function readTilesBatch(
  requests: ReadonlyArray<{ source: SourceDefinition; x: number; y: number }>
): Promise<Map<string, TileLookup | null>> {
  const results = new Map<string, TileLookup | null>();
  if (requests.length === 0) return results;
  const unique = new Map<string, { source: SourceDefinition; x: number; y: number }>();
  for (const request of requests) unique.set(tileKey(request.source, request.x, request.y), request);

  const inFlightEntries: Array<{ key: string; promise: Promise<TileLookup | null> }> = [];
  const missing: Array<{ key: string; source: SourceDefinition; x: number; y: number }> = [];
  for (const [key, request] of unique) {
    const memory = memoryCache.get(key);
    if (memory) {
      memoryCache.delete(key);
      memoryCache.set(key, memory);
      results.set(key, memory);
      continue;
    }
    const inFlight = inFlightReads.get(key);
    if (inFlight) {
      inFlightEntries.push({ key, promise: inFlight });
      continue;
    }
    missing.push({ key, ...request });
  }

  // Existing in-flight reads and the new batch transaction are independent.
  // Run them concurrently instead of serially; this changes only waiting time,
  // never source priority, expiry rules, decoded values, or interpolation.
  const inFlightTask = inFlightEntries.length > 0
    ? Promise.all(inFlightEntries.map((entry) => entry.promise)).then((values) => {
        values.forEach((value, index) => results.set(inFlightEntries[index].key, value));
      })
    : Promise.resolve();

  const missingTask = (async () => {
    if (missing.length === 0) return;
    const database = await openDatabase();
    if (!database) {
      missing.forEach(({ key }) => results.set(key, null));
      return;
    }
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const now = Date.now();
    await Promise.all(missing.map(({ key }) => new Promise<void>((resolve) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result as StoredTile | undefined;
        if (!record || now - record.updatedAt > MAX_AGE_MS) {
          results.set(key, null);
          resolve();
          return;
        }
        const lookup = storedToLookup(record);
        if (lookup) writeMemory(key, lookup);
        results.set(key, lookup);
        resolve();
      };
      request.onerror = () => {
        results.set(key, null);
        resolve();
      };
    })));
  })();

  await Promise.all([inFlightTask, missingTask]);
  return results;
}

/**
 * Cache-only bulk read used by warm-up. It intentionally performs no network
 * access and preserves the same expiry/corruption checks as readTile(), but
 * shares one readonly transaction across all missing tile keys.
 */
async function readTilesFromPersistentCacheBatch(
  requests: ReadonlyArray<{ source: SourceDefinition; x: number; y: number }>
): Promise<void> {
  await readTilesBatch(requests);
}

async function cleanupOldTiles(database: IdbDatabase): Promise<void> {
  const records = await new Promise<StoredTile[]>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(
      Array.isArray(request.result)
        ? (request.result as StoredTile[]).filter((value) => value && typeof value.key === "string")
        : []
    );
    request.onerror = () => resolve([]);
  });
  const now = Date.now();
  const expired = records.filter((record) => now - record.updatedAt > MAX_AGE_MS);
  const valid = records
    .filter((record) => now - record.updatedAt <= MAX_AGE_MS)
    .sort((a, b) => b.accessedAt - a.accessedAt);
  const excess = valid.slice(PERSISTED_MAX_ENTRIES);
  const deleteKeys = [...expired, ...excess].map((record) => record.key);
  if (deleteKeys.length === 0) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    deleteKeys.forEach((key) => store.delete(key));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

async function writeTile(
  source: SourceDefinition,
  x: number,
  y: number,
  lookup: TileLookup
): Promise<void> {
  const key = tileKey(source, x, y);
  writeMemory(key, lookup);
  const database = await openDatabase();
  if (!database) return;
  const now = Date.now();
  const record: StoredTile = lookup.kind === "empty"
    ? { key, width: 0, height: 0, empty: true, heightsBuffer: null, updatedAt: now, accessedAt: now }
    : {
        key,
        width: lookup.tile.width,
        height: lookup.tile.height,
        empty: false,
        heightsBuffer: copyInt32ArrayToArrayBuffer(lookup.tile.heightsCentimeters),
        updatedAt: now,
        accessedAt: now,
      };
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  writesSinceCleanup += 1;
  if (writesSinceCleanup >= 16) {
    writesSinceCleanup = 0;
    void cleanupOldTiles(database);
  }
}

function tileCoordinates(
  latitude: number,
  longitude: number,
  zoom: number
): { x: number; y: number; pixelX: number; pixelY: number; fracX: number; fracY: number } {
  const scale = 2 ** zoom;
  const normalizedX = (longitude + 180) / 360 * scale;
  const latitudeRadians = latitude * Math.PI / 180;
  const normalizedY = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale;
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

function sourceAllowed(source: SourceDefinition, maximumDetail?: MaximumDetail): boolean {
  if (maximumDetail === "10m") return source.label === "DEM10B";
  if (maximumDetail === "5m") return source.label !== "DEM1A";
  return true;
}

function isJapaneseCoverage(latitude: number, longitude: number): boolean {
  return latitude >= 20 && latitude <= 46.5 && longitude >= 122 && longitude <= 154;
}

function resolveGridCoordinate(pixel: number): { tileOffset: -1 | 0 | 1; localPixel: number } {
  if (pixel < 0) return { tileOffset: -1, localPixel: pixel + TILE_SIZE };
  if (pixel >= TILE_SIZE) return { tileOffset: 1, localPixel: pixel - TILE_SIZE };
  return { tileOffset: 0, localPixel: pixel };
}

function neighborOffsets(pixelX: number, pixelY: number): Array<{ x: -1 | 0 | 1; y: -1 | 0 | 1 }> {
  const seen = new Set<string>();
  const result: Array<{ x: -1 | 0 | 1; y: -1 | 0 | 1 }> = [];
  for (let offsetY = -1; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 2; offsetX += 1) {
      const gridX = resolveGridCoordinate(pixelX + offsetX);
      const gridY = resolveGridCoordinate(pixelY + offsetY);
      const key = `${gridX.tileOffset}/${gridY.tileOffset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ x: gridX.tileOffset, y: gridY.tileOffset });
    }
  }
  return result;
}

function rawHeight(tile: DecodedTile, pixelX: number, pixelY: number): number | null {
  const x = Math.max(0, Math.min(tile.width - 1, pixelX));
  const y = Math.max(0, Math.min(tile.height - 1, pixelY));
  const centimeters = tile.heightsCentimeters[y * tile.width + x];
  return centimeters === NO_DATA_HEIGHT_CENTIMETERS ? null : centimeters * 0.01;
}

function bilinear(a: number, b: number, c: number, d: number, fracX: number, fracY: number): number {
  const x = Math.max(0, Math.min(1, fracX));
  const y = Math.max(0, Math.min(1, fracY));
  const top = a + (b - a) * x;
  const bottom = c + (d - c) * x;
  return top + (bottom - top) * y;
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const a1 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const a2 = -0.5 * p0 + 0.5 * p2;
  return ((a0 * u + a1) * u + a2) * u + p1;
}

function constrainedBicubic(grid: number[][], fracX: number, fracY: number): number {
  const rows = grid.map((row) => cubic(row[0], row[1], row[2], row[3], fracX));
  const raw = cubic(rows[0], rows[1], rows[2], rows[3], fracY);
  const center = [grid[1][1], grid[1][2], grid[2][1], grid[2][2]];
  return Math.max(Math.min(...center), Math.min(Math.max(...center), raw));
}

function sampleNeighborhood(
  tiles: ReadonlyMap<string, DecodedTile | null>,
  baseX: number,
  baseY: number,
  pixelX: number,
  pixelY: number,
  offsetX: number,
  offsetY: number
): number | null {
  const gx = resolveGridCoordinate(pixelX + offsetX);
  const gy = resolveGridCoordinate(pixelY + offsetY);
  const tile = tiles.get(`${baseX + gx.tileOffset}/${baseY + gy.tileOffset}`) ?? null;
  return tile ? rawHeight(tile, gx.localPixel, gy.localPixel) : null;
}

function interpolateNeighborhood(
  tiles: ReadonlyMap<string, DecodedTile | null>,
  baseX: number,
  baseY: number,
  pixelX: number,
  pixelY: number,
  fracX: number,
  fracY: number,
  mode: InterpolationMode
): number | null {
  const sample = (ox: number, oy: number) => sampleNeighborhood(
    tiles, baseX, baseY, pixelX, pixelY, ox, oy
  );
  const tl = sample(0, 0);
  const tr = sample(1, 0);
  const bl = sample(0, 1);
  const br = sample(1, 1);
  if (tl === null && tr === null && bl === null && br === null) return null;
  if (tl === null || tr === null || bl === null || br === null) {
    return fracX < 0.5 ? (fracY < 0.5 ? tl : bl) : (fracY < 0.5 ? tr : br);
  }
  const bilinearHeight = bilinear(tl, tr, bl, br, fracX, fracY);
  const grid: number[][] = [];
  for (let oy = -1; oy <= 2; oy += 1) {
    const row: number[] = [];
    for (let ox = -1; ox <= 2; ox += 1) {
      const value = sample(ox, oy);
      if (value === null) return bilinearHeight;
      row.push(value);
    }
    grid.push(row);
  }
  const bicubicHeight = constrainedBicubic(grid, fracX, fracY);
  return mode === "neutral" ? bicubicHeight : Math.max(bilinearHeight, bicubicHeight);
}

function interpolateBilinear(
  tile: DecodedTile,
  pixelX: number,
  pixelY: number,
  fracX: number,
  fracY: number
): number | null {
  const tl = rawHeight(tile, pixelX, pixelY);
  const tr = rawHeight(tile, pixelX + 1, pixelY);
  const bl = rawHeight(tile, pixelX, pixelY + 1);
  const br = rawHeight(tile, pixelX + 1, pixelY + 1);
  if (tl === null && tr === null && bl === null && br === null) return null;
  if (tl === null || tr === null || bl === null || br === null) {
    return fracX < 0.5 ? (fracY < 0.5 ? tl : bl) : (fracY < 0.5 ? tr : br);
  }
  return bilinear(tl, tr, bl, br, fracX, fracY);
}

export async function resolveGsiSamplesFromDeviceTiles(
  points: GsiElevationClientPoint[]
): Promise<Array<GsiElevationApiSample | null>> {
  const results: Array<GsiElevationApiSample | null | undefined> = points.map((point) =>
    isJapaneseCoverage(point.latitude, point.longitude)
      ? undefined
      : { heightMeters: null, source: null }
  );
  // If a higher-priority source tile is absent from the device cache, we cannot
  // prove what the server would choose. That point is immediately marked null so
  // the caller uses the authoritative API. We never skip a missing higher source
  // and silently consume a lower-priority cached source.
  const mustUseNetwork = new Set<number>();

  // Read every potentially relevant base tile with one batched IndexedDB pass.
  // Source selection itself remains strictly ordered below. Reading lower-priority
  // candidates early cannot make them win; it only removes transaction latency.
  const coordinateBySourceAndPoint = new Map<string, ReturnType<typeof tileCoordinates>>();
  const allBaseRequests: Array<{ source: SourceDefinition; x: number; y: number }> = [];
  for (const source of SOURCES) {
    points.forEach((point, index) => {
      if (results[index] !== undefined || !sourceAllowed(source, point.maximumDetail)) return;
      const coordinate = tileCoordinates(point.latitude, point.longitude, source.zoom);
      coordinateBySourceAndPoint.set(`${source.id}:${index}`, coordinate);
      allBaseRequests.push({ source, x: coordinate.x, y: coordinate.y });
    });
  }
  const allBases = await readTilesBatch(allBaseRequests);

  for (const source of SOURCES) {
    const active = points.map((point, index) => ({ point, index }))
      .filter(({ point, index }) =>
        results[index] === undefined && !mustUseNetwork.has(index) && sourceAllowed(source, point.maximumDetail)
      );
    if (active.length === 0) continue;

    const oneMeterWithBase: Array<{ point: GsiElevationClientPoint; index: number; base: TileLookup & { kind: "data" } }> = [];
    for (const { point, index } of active) {
      const coordinate = coordinateBySourceAndPoint.get(`${source.id}:${index}`)!;
      const base = allBases.get(tileKey(source, coordinate.x, coordinate.y)) ?? null;
      if (base === null) {
        mustUseNetwork.add(index);
        continue;
      }
      if (base.kind === "empty") continue;
      if (point.maximumDetail === "1m") {
        oneMeterWithBase.push({ point, index, base });
        continue;
      }
      const height = interpolateBilinear(
        base.tile,
        coordinate.pixelX,
        coordinate.pixelY,
        coordinate.fracX,
        coordinate.fracY
      );
      if (height !== null) results[index] = { heightMeters: height, source: source.label };
    }

    if (oneMeterWithBase.length > 0) {
      const neighborRequests: Array<{ source: SourceDefinition; x: number; y: number }> = [];
      for (const { index } of oneMeterWithBase) {
        const coordinate = coordinateBySourceAndPoint.get(`${source.id}:${index}`)!;
        for (const offset of neighborOffsets(coordinate.pixelX, coordinate.pixelY)) {
          neighborRequests.push({ source, x: coordinate.x + offset.x, y: coordinate.y + offset.y });
        }
      }
      const neighbors = await readTilesBatch(neighborRequests);
      for (const { point, index } of oneMeterWithBase) {
        const coordinate = coordinateBySourceAndPoint.get(`${source.id}:${index}`)!;
        const tiles = new Map<string, DecodedTile | null>();
        let complete = true;
        for (const offset of neighborOffsets(coordinate.pixelX, coordinate.pixelY)) {
          const x = coordinate.x + offset.x;
          const y = coordinate.y + offset.y;
          const lookup = neighbors.get(tileKey(source, x, y)) ?? null;
          if (lookup === null) {
            complete = false;
            break;
          }
          tiles.set(`${x}/${y}`, lookup.kind === "data" ? lookup.tile : null);
        }
        if (!complete) {
          mustUseNetwork.add(index);
          continue;
        }
        const height = interpolateNeighborhood(
          tiles,
          coordinate.x,
          coordinate.y,
          coordinate.pixelX,
          coordinate.pixelY,
          coordinate.fracX,
          coordinate.fracY,
          point.interpolationMode ?? "los-safe"
        );
        if (height !== null) results[index] = { heightMeters: height, source: source.label };
      }
    }
  }

  return results.map((result, index) => {
    if (mustUseNetwork.has(index)) return null;
    return result ?? { heightMeters: null, source: null };
  });
}

/**
 * Cache-only warm-up. Reads likely tiles from IndexedDB into the existing memory
 * LRU but never performs network I/O. Missing tiles are ignored, so this cannot
 * change the terrain source selected by the solver.
 */
export async function warmGsiDeviceTilesFromPersistentCache(
  points: Array<{ latitude: number; longitude: number }>
): Promise<void> {
  const unique = new Map<string, { source: SourceDefinition; x: number; y: number }>();
  for (const point of points) {
    if (!isJapaneseCoverage(point.latitude, point.longitude)) continue;
    for (const source of SOURCES) {
      const coordinate = tileCoordinates(point.latitude, point.longitude, source.zoom);
      for (const offset of neighborOffsets(coordinate.pixelX, coordinate.pixelY)) {
        const x = coordinate.x + offset.x;
        const y = coordinate.y + offset.y;
        unique.set(tileKey(source, x, y), { source, x, y });
      }
    }
  }
  await readTilesFromPersistentCacheBatch([...unique.values()]);
}

function sourceIndex(label: GsiSource): number {
  return SOURCES.findIndex((source) => source.label === label);
}

function tileRequestsForSample(
  point: GsiElevationClientPoint,
  sample: GsiElevationApiSample
): Array<{ source: SourceDefinition; x: number; y: number }> {
  if (!sample.source) return [];
  const winningIndex = sourceIndex(sample.source);
  if (winningIndex < 0) return [];
  const requests = new Map<string, { source: SourceDefinition; x: number; y: number }>();
  for (let index = 0; index <= winningIndex; index += 1) {
    const source = SOURCES[index];
    if (!sourceAllowed(source, point.maximumDetail)) continue;
    const coordinate = tileCoordinates(point.latitude, point.longitude, source.zoom);
    requests.set(tileKey(source, coordinate.x, coordinate.y), { source, x: coordinate.x, y: coordinate.y });
    if (source.label === sample.source && point.maximumDetail === "1m") {
      for (const offset of neighborOffsets(coordinate.pixelX, coordinate.pixelY)) {
        requests.set(
          tileKey(source, coordinate.x + offset.x, coordinate.y + offset.y),
          { source, x: coordinate.x + offset.x, y: coordinate.y + offset.y }
        );
      }
    }
  }
  return [...requests.values()];
}

async function fetchAndStoreTile(source: SourceDefinition, x: number, y: number): Promise<void> {
  const key = tileKey(source, x, y);
  if (await readTile(source, x, y)) return;
  const existing = inFlightPrefetch.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const params = new URLSearchParams({ source: source.label, x: String(x), y: String(y) });
    const response = await fetch(`/api/gsi-dem-tile?${params.toString()}`, {
      headers: { Accept: "application/octet-stream" },
    });
    if (response.status === 404) {
      await writeTile(source, x, y, { kind: "empty" });
      return;
    }
    if (!response.ok) return;
    const width = Number(response.headers.get("x-astrosight-dem-width"));
    const height = Number(response.headers.get("x-astrosight-dem-height"));
    const bytes = await response.arrayBuffer();
    if (
      !Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 || width * height > 1_048_576 ||
      bytes.byteLength !== width * height * Int32Array.BYTES_PER_ELEMENT
    ) return;
    // Endpoint writes little-endian int32. Rebuild explicitly; do not assume host endian.
    const view = new DataView(bytes);
    const heights = new Int32Array(width * height);
    for (let index = 0; index < heights.length; index += 1) {
      heights[index] = view.getInt32(index * 4, true);
    }
    await writeTile(source, x, y, { kind: "data", tile: { width, height, heightsCentimeters: heights } });
  })().catch(() => {
    // Best-effort warm-up only. Never alter current search result on failure.
  }).finally(() => {
    inFlightPrefetch.delete(key);
  });
  inFlightPrefetch.set(key, promise);
  return promise;
}

export function prefetchGsiDeviceTilesForSamples(
  points: GsiElevationClientPoint[],
  samples: GsiElevationApiSample[]
): void {
  const requests = new Map<string, { source: SourceDefinition; x: number; y: number }>();
  points.forEach((point, index) => {
    if (point.interpolationMode !== "neutral") return;
    const sample = samples[index];
    if (!sample || !isJapaneseCoverage(point.latitude, point.longitude)) return;
    for (const request of tileRequestsForSample(point, sample)) {
      requests.set(tileKey(request.source, request.x, request.y), request);
    }
  });
  const queue = [...requests.values()].slice(0, PREFETCH_MAX_TILES_PER_CALL);
  if (queue.length === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const index = next;
      next += 1;
      const request = queue[index];
      await fetchAndStoreTile(request.source, request.x, request.y);
    }
  };
  void Promise.all(
    Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, () => worker())
  );
}

export const __testGsiDemTileCacheInternals = { tileCoordinates, interpolateNeighborhood, interpolateBilinear };
