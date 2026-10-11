import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import type { PlateauRoofCandidate } from "../../src/types/plateauRoof.ts";

const DIRECTORY = "plateau-buildings";
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUILDINGS_PER_FILE = 500_000;
const CACHE_FILES = 16;
const CELL_DEGREES = 0.02;
const LOCAL_RADII = [0, 5, 10, 15, 20, 30, 50] as const;
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
const REFINE_RADII = [1, 3, 6] as const;
const REFINE_BEARINGS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const;

type ManifestRecord = {
  dataset: string;
  year: number | null;
  special: boolean;
  entry: string;
  file: string | null;
  bbox: [number, number, number, number] | null;
  storedBytes: number;
};

type Face = number[][];
type LodGeometry = {
  z?: [number, number];
  t?: Face[];
  zi?: [number, number];
  ti?: Face[];
};
type StoredBuilding = {
  id: string;
  mh?: number;
  bad?: number;
  b: [number, number, number, number];
  l?: Record<string, LodGeometry>;
};
type LoadedFile = { header: { dataset: string; entry: string }; buildings: StoredBuilding[] };

export type PlateauBuildingStore = {
  lookup(latitude: number, longitude: number): Promise<PlateauRoofCandidate | null>;
  entryCount: number;
};

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validBbox(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value[0] <= value[2] && value[1] <= value[3];
}

function validRange(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value[0] <= value[1];
}

function validManifestRecord(value: unknown): value is ManifestRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ManifestRecord>;
  return typeof record.dataset === "string" && /^[a-z0-9._-]+$/iu.test(record.dataset) &&
    typeof record.entry === "string" && record.entry.length > 0 &&
    (record.year === null || Number.isInteger(record.year)) &&
    typeof record.special === "boolean" &&
    (record.file === null || (typeof record.file === "string" &&
      /^buildings\/[a-z0-9._-]+\/[^/]+\.gml\.ndjson\.gz$/iu.test(record.file))) &&
    (record.bbox === null || validBbox(record.bbox)) &&
    Number.isSafeInteger(record.storedBytes) && (record.storedBytes as number) >= 0;
}

function cellKey(latitude: number, longitude: number): string {
  return `${Math.floor(latitude / CELL_DEGREES)},${Math.floor(longitude / CELL_DEGREES)}`;
}

function contains(bbox: readonly number[], latitude: number, longitude: number): boolean {
  return latitude >= bbox[0] && latitude <= bbox[2] && longitude >= bbox[1] && longitude <= bbox[3];
}

function pointOnSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-11) return false;
  const dot = (x - ax) * (x - bx) + (y - ay) * (y - by);
  return dot <= 1e-14;
}

function insideRing(latitude: number, longitude: number, ring: readonly number[]): boolean {
  if (ring.length < 12 || ring.length % 3 !== 0) return false;
  let inside = false;
  const count = ring.length / 3;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const yi = ring[index * 3];
    const xi = ring[index * 3 + 1];
    const yj = ring[previous * 3];
    const xj = ring[previous * 3 + 1];
    if (pointOnSegment(longitude, latitude, xi, yi, xj, yj)) return true;
    if ((yi > latitude) !== (yj > latitude) &&
      longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideFace(latitude: number, longitude: number, face: Face): boolean {
  if (!Array.isArray(face) || face.length < 1 || !insideRing(latitude, longitude, face[0])) return false;
  return face.slice(1).every((hole) => !insideRing(latitude, longitude, hole));
}

function planeHeight(latitude: number, longitude: number, ring: readonly number[]): number | null {
  if (ring.length < 9) return null;
  const lat0 = ring[0];
  const lon0 = ring[1];
  const z0 = ring[2];
  const cos = Math.cos(lat0 * Math.PI / 180);
  const point = (offset: number) => ({
    x: (ring[offset + 1] - lon0) * cos * 111_320,
    y: (ring[offset] - lat0) * 110_540,
    z: ring[offset + 2] - z0,
  });
  const first = point(3);
  let normal: { x: number; y: number; z: number } | null = null;
  for (let offset = 6; offset < ring.length; offset += 3) {
    const second = point(offset);
    const candidate = {
      x: first.y * second.z - first.z * second.y,
      y: first.z * second.x - first.x * second.z,
      z: first.x * second.y - first.y * second.x,
    };
    if (Math.abs(candidate.z) > 1e-8) { normal = candidate; break; }
  }
  if (!normal) return null;
  const x = (longitude - lon0) * cos * 111_320;
  const y = (latitude - lat0) * 110_540;
  const height = z0 - (normal.x * x + normal.y * y) / normal.z;
  return Number.isFinite(height) ? height : null;
}

function destination(latitude: number, longitude: number, distance: number, bearing: number) {
  if (distance === 0) return { latitude, longitude };
  const radians = bearing * Math.PI / 180;
  return {
    latitude: latitude + Math.cos(radians) * distance / 110_540,
    longitude: longitude + Math.sin(radians) * distance / (111_320 * Math.cos(latitude * Math.PI / 180)),
  };
}

function samples(latitude: number, longitude: number, radii: readonly number[], bearings: readonly number[]) {
  const values: Array<{ latitude: number; longitude: number }> = [];
  for (const radius of radii) {
    if (radius === 0) values.push({ latitude, longitude });
    else for (const bearing of bearings) values.push(destination(latitude, longitude, radius, bearing));
  }
  return values;
}

function roofAtPoint(record: ManifestRecord, building: StoredBuilding, latitude: number, longitude: number): PlateauRoofCandidate | null {
  if (!contains(building.b, latitude, longitude) || (building.bad ?? 0) !== 0) return null;
  const levels = Object.keys(building.l ?? {}).map(Number)
    .filter((level): level is 2 | 3 | 4 => level === 2 || level === 3 || level === 4)
    .sort((left, right) => right - left);
  for (const lod of levels) {
    const geometry = building.l?.[String(lod)];
    if (!geometry || !Array.isArray(geometry.t) || !validRange(geometry.z)) continue;
    // The sampled point identifies the intended building. Once identified,
    // return the highest explicit roof vertex of that same building rather
    // than the height at the sample point. This places a subject pin on the
    // true roof/top and still prevents a nearby unrelated building from being
    // selected merely because its bbox overlaps the search ring.
    const intersectsRoof = geometry.t.some((face) =>
      insideFace(latitude, longitude, face) && planeHeight(latitude, longitude, face[0]) !== null);
    if (!intersectsRoof) continue;
    let peakLatitude = latitude;
    let peakLongitude = longitude;
    let peakHeight = -Infinity;
    for (const face of geometry.t) for (const ring of face) {
      for (let offset = 0; offset + 2 < ring.length; offset += 3) {
        if (Number.isFinite(ring[offset + 2]) && ring[offset + 2] > peakHeight) {
          peakLatitude = ring[offset];
          peakLongitude = ring[offset + 1];
          peakHeight = ring[offset + 2];
        }
      }
    }
    if (!Number.isFinite(peakHeight)) continue;
    return {
      dataset: record.dataset,
      year: record.year,
      buildingId: building.id,
      lod,
      latitude: peakLatitude,
      longitude: peakLongitude,
      orthometricHeightMeters: peakHeight,
      buildingMinHeightMeters: geometry.z[0],
      buildingMaxHeightMeters: geometry.z[1],
      installationMaxHeightMeters: Array.isArray(geometry.zi) && geometry.zi.every(Number.isFinite)
        ? geometry.zi[1]
        : null,
      measuredHeightMeters: Number.isFinite(building.mh) ? building.mh as number : null,
      badCoordinatePolygons: building.bad ?? 0,
    };
  }
  return null;
}

export async function createPlateauBuildingStore(configuredRoot: string): Promise<PlateauBuildingStore | null> {
  const dataRoot = await realpath(path.resolve(configuredRoot));
  const root = path.resolve(dataRoot, DIRECTORY);
  if (!isInside(dataRoot, root)) throw new Error("invalid building data root");
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("building data root is unavailable");
  }
  if (!isInside(dataRoot, canonicalRoot)) throw new Error("invalid building data root");
  const manifestPath = path.resolve(canonicalRoot, "manifest.ndjson");
  const manifestStat = await stat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size < 1 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error("building manifest is invalid");
  }
  const handle = await open(manifestPath, constants.O_RDONLY);
  let text: string;
  try { text = await handle.readFile({ encoding: "utf8" }); } finally { await handle.close(); }
  const records: ManifestRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as unknown;
    if (!validManifestRecord(value)) throw new Error("building manifest record is invalid");
    if (!value.special && value.file && value.bbox) records.push(value);
  }

  const cells = new Map<string, number[]>();
  records.forEach((record, index) => {
    const bbox = record.bbox as [number, number, number, number];
    const south = Math.floor(bbox[0] / CELL_DEGREES);
    const north = Math.floor(bbox[2] / CELL_DEGREES);
    const west = Math.floor(bbox[1] / CELL_DEGREES);
    const east = Math.floor(bbox[3] / CELL_DEGREES);
    if ((north - south + 1) * (east - west + 1) > 10_000) throw new Error("building manifest bbox is too large");
    for (let y = south; y <= north; y += 1) for (let x = west; x <= east; x += 1) {
      const key = `${y},${x}`;
      const list = cells.get(key) ?? [];
      list.push(index);
      cells.set(key, list);
    }
  });

  const cache = new Map<string, LoadedFile>();
  const loadFile = async (record: ManifestRecord): Promise<LoadedFile> => {
    const cached = cache.get(record.file as string);
    if (cached) {
      cache.delete(record.file as string);
      cache.set(record.file as string, cached);
      return cached;
    }
    const candidate = path.resolve(canonicalRoot, record.file as string);
    if (!isInside(canonicalRoot, candidate)) throw new Error("building file path is invalid");
    const canonical = await realpath(candidate);
    if (!isInside(canonicalRoot, canonical)) throw new Error("building file path is invalid");
    const metadata = await stat(canonical);
    if (!metadata.isFile() || metadata.size !== record.storedBytes || metadata.size > MAX_COMPRESSED_FILE_BYTES) {
      throw new Error("building file is invalid");
    }
    const input = createReadStream(canonical);
    const gunzip = zlib.createGunzip();
    const lines = readline.createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
    let header: LoadedFile["header"] | null = null;
    const buildings: StoredBuilding[] = [];
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        if (!header) {
          if (value?.type !== "header" || value.dataset !== record.dataset || value.entry !== record.entry) {
            throw new Error("building file header is invalid");
          }
          header = value;
          continue;
        }
        if (value?.type === "footer") continue;
        if (typeof value?.id !== "string" || !validBbox(value.b)) throw new Error("building record is invalid");
        buildings.push(value);
        if (buildings.length > MAX_BUILDINGS_PER_FILE) throw new Error("building file has too many records");
      }
    } finally {
      lines.close();
      input.destroy();
      gunzip.destroy();
    }
    if (!header) throw new Error("building file header is missing");
    const loaded = { header, buildings };
    cache.set(record.file as string, loaded);
    while (cache.size > CACHE_FILES) cache.delete(cache.keys().next().value as string);
    return loaded;
  };

  const lookupExact = async (latitude: number, longitude: number) => {
    const indexes = cells.get(cellKey(latitude, longitude)) ?? [];
    const candidates: PlateauRoofCandidate[] = [];
    for (const index of indexes) {
      const record = records[index];
      if (!contains(record.bbox as number[], latitude, longitude)) continue;
      const loaded = await loadFile(record);
      for (const building of loaded.buildings) {
        const candidate = roofAtPoint(record, building, latitude, longitude);
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates;
  };

  const selectHighest = (candidates: PlateauRoofCandidate[]) => candidates.reduce<PlateauRoofCandidate | null>(
    (highest, candidate) => !highest || candidate.orthometricHeightMeters > highest.orthometricHeightMeters
      ? candidate : highest,
    null
  );

  return {
    entryCount: records.length,
    lookup: async (latitude, longitude) => {
      const first: PlateauRoofCandidate[] = [];
      for (const point of samples(latitude, longitude, LOCAL_RADII, BEARINGS)) {
        first.push(...await lookupExact(point.latitude, point.longitude));
      }
      const peak = selectHighest(first);
      if (!peak) return null;
      const refined = [...first];
      for (const point of samples(peak.latitude, peak.longitude, REFINE_RADII, REFINE_BEARINGS)) {
        refined.push(...await lookupExact(point.latitude, point.longitude));
      }
      return selectHighest(refined);
    },
  };
}

export const plateauBuildingStoreInternalsForTests = {
  insideFace,
  insideRing,
  planeHeight,
  roofAtPoint,
};
