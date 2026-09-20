import {
  VectorTile,
  type VectorTileLayer,
} from "@mapbox/vector-tile";
import Pbf from "pbf";
import { createAbortError, createTimeoutError } from "./runtimeErrors.ts";

export type GsiWaterPoint = {
  latitude: number;
  longitude: number;
};

export type GsiWaterSurfaceContext = {
  onWaterSurface: boolean;
  waterSurfaceKind: "none" | "river" | "sea-or-other-water";
};

type VectorTilePoint = {
  x: number;
  y: number;
};

type TileAddress = {
  zoom: number;
  x: number;
  y: number;
};

type DecodedTile = TileAddress & {
  state: "decoded";
  vectorTile: VectorTile;
};

type MissingTile = TileAddress & {
  state: "missing";
};

type TileResult = DecodedTile | MissingTile;

type TilePosition = TileAddress & {
  worldX: number;
  worldY: number;
};

const GSI_VECTOR_TILE_BASE_URL =
  "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap";
const WATER_GEOMETRY_ZOOM = 16;
const WATER_KIND_FALLBACK_ZOOM = 14;
const WATER_MASK_FALLBACK_ZOOM = 13;
const TILE_REQUEST_TIMEOUT_MS = 6_000;
const TILE_FETCH_CONCURRENCY = 6;
const MAX_TILE_CACHE_ENTRIES = 128;
const MAX_TILE_BYTES = 5 * 1024 * 1024;
const POLYGON_BOUNDARY_TOLERANCE = 0.75;

// Cloudflare isolates reuse module state. Keeping only completed decoded tiles
// avoids repeated GSI traffic during nearby searches without sharing an
// abortable in-flight request between unrelated users.
const completedTileCache = new Map<string, TileResult>();

function tileKey(address: TileAddress): string {
  return `${address.zoom}/${address.x}/${address.y}`;
}

function rememberTile(key: string, tile: TileResult): void {
  completedTileCache.delete(key);
  completedTileCache.set(key, tile);
  while (completedTileCache.size > MAX_TILE_CACHE_ENTRIES) {
    const oldestKey = completedTileCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    completedTileCache.delete(oldestKey);
  }
}

export function clearGsiWaterTileCacheForTests(): void {
  completedTileCache.clear();
}

function positionAtZoom(point: GsiWaterPoint, zoom: number): TilePosition {
  const scale = 2 ** zoom;
  const latitudeRadians = point.latitude * Math.PI / 180;
  const worldX = (point.longitude + 180) / 360 * scale;
  const worldY = (
    1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI
  ) / 2 * scale;
  return {
    zoom,
    x: Math.floor(worldX),
    y: Math.floor(worldY),
    worldX,
    worldY,
  };
}

async function fetchTile(
  address: TileAddress,
  signal?: AbortSignal
): Promise<TileResult> {
  if (signal?.aborted) throw createAbortError();
  const key = tileKey(address);
  const cached = completedTileCache.get(key);
  if (cached) {
    completedTileCache.delete(key);
    completedTileCache.set(key, cached);
    return cached;
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(createTimeoutError("GSI vector tile timeout")),
    TILE_REQUEST_TIMEOUT_MS
  );
  try {
    const response = await fetch(
      `${GSI_VECTOR_TILE_BASE_URL}/${address.zoom}/${address.x}/${address.y}.pbf`,
      {
        headers: { Accept: "application/x-protobuf, application/octet-stream" },
        signal: controller.signal,
      }
    );
    if (response.status === 404) {
      const missing: MissingTile = { ...address, state: "missing" };
      rememberTile(key, missing);
      return missing;
    }
    if (!response.ok) {
      throw new Error(`GSIベクトルタイル取得エラー：${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TILE_BYTES) {
      throw new Error("GSIベクトルタイルのサイズが上限を超えています");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TILE_BYTES) {
      throw new Error("GSIベクトルタイルのサイズが上限を超えています");
    }
    const decoded: DecodedTile = {
      ...address,
      state: "decoded",
      vectorTile: new VectorTile(new Pbf(bytes)),
    };
    rememberTile(key, decoded);
    return decoded;
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function fetchTiles(
  addresses: TileAddress[],
  signal?: AbortSignal
): Promise<Map<string, TileResult>> {
  const uniqueAddresses = new Map<string, TileAddress>();
  for (const address of addresses) {
    uniqueAddresses.set(tileKey(address), address);
  }
  const queue = [...uniqueAddresses.values()];
  const results = new Map<string, TileResult>();
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(TILE_FETCH_CONCURRENCY, queue.length) },
    async () => {
      while (nextIndex < queue.length) {
        const address = queue[nextIndex];
        nextIndex += 1;
        const tile = await fetchTile(address, signal);
        results.set(tileKey(address), tile);
      }
    }
  );
  const settled = await Promise.allSettled(workers);
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
  return results;
}

function pointSegmentDistanceSquared(
  point: VectorTilePoint,
  start: VectorTilePoint,
  end: VectorTilePoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const ratio = Math.max(0, Math.min(
    1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  ));
  const projectedX = start.x + ratio * dx;
  const projectedY = start.y + ratio * dy;
  return (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
}

function ringContainsPoint(
  ring: VectorTilePoint[],
  point: VectorTilePoint
): { inside: boolean; boundary: boolean } {
  if (ring.length < 3) return { inside: false, boundary: false };
  let inside = false;
  for (
    let current = 0, previous = ring.length - 1;
    current < ring.length;
    previous = current, current += 1
  ) {
    const a = ring[current];
    const b = ring[previous];
    if (
      pointSegmentDistanceSquared(point, a, b) <=
        POLYGON_BOUNDARY_TOLERANCE ** 2
    ) {
      return { inside: true, boundary: true };
    }
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return { inside, boundary: false };
}

function signedRingArea(ring: VectorTilePoint[]): number {
  let sum = 0;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const a = ring[current];
    const b = ring[previous];
    sum += (b.x - a.x) * (a.y + b.y);
  }
  return sum;
}

function classifyRings(rings: VectorTilePoint[][]): VectorTilePoint[][][] {
  if (rings.length <= 1) return rings.length === 0 ? [] : [rings];
  const polygons: VectorTilePoint[][][] = [];
  let polygon: VectorTilePoint[][] | null = null;
  let outerCounterClockwise: boolean | null = null;
  for (const ring of rings) {
    const area = signedRingArea(ring);
    if (area === 0) continue;
    if (outerCounterClockwise === null) outerCounterClockwise = area < 0;
    if ((area < 0) === outerCounterClockwise) {
      if (polygon) polygons.push(polygon);
      polygon = [ring];
    } else if (polygon) {
      polygon.push(ring);
    }
  }
  if (polygon) polygons.push(polygon);
  return polygons;
}

function polygonContainsPoint(
  rings: VectorTilePoint[][],
  point: VectorTilePoint
): boolean {
  const outer = rings[0] ? ringContainsPoint(rings[0], point) : null;
  if (!outer) return false;
  if (outer.boundary) return true;
  if (!outer.inside) return false;
  for (let index = 1; index < rings.length; index += 1) {
    const hole = ringContainsPoint(rings[index], point);
    // A boundary coordinate is treated as water on the safe side. Interior
    // hole coordinates are land.
    if (hole.boundary) return true;
    if (hole.inside) return false;
  }
  return true;
}

function localPoint(position: TilePosition, extent: number): VectorTilePoint {
  return {
    x: (position.worldX - position.x) * extent,
    y: (position.worldY - position.y) * extent,
  };
}

type LineSegment = {
  start: VectorTilePoint;
  end: VectorTilePoint;
};

type PreparedWaterPolygon = {
  rings: VectorTilePoint[][];
  kind: "river" | "sea-or-other-water" | "untyped-water";
};

type PreparedWaterTile = {
  extent: number;
  polygons: PreparedWaterPolygon[];
};

const preparedWaterTiles = new WeakMap<VectorTile, PreparedWaterTile>();
const RIVER_BOUNDARY_FEATURE_CODES = new Set([5201, 5202, 5203, 5301, 5321]);

function lineSegments(
  layer: VectorTileLayer | undefined,
  targetExtent: number,
  acceptFeature: (properties: Record<string, unknown>) => boolean
): LineSegment[] {
  if (!layer) return [];
  const scale = targetExtent / layer.extent;
  const segments: LineSegment[] = [];
  for (let featureIndex = 0; featureIndex < layer.length; featureIndex += 1) {
    const feature = layer.feature(featureIndex);
    if (!acceptFeature(feature.properties)) continue;
    for (const line of feature.loadGeometry()) {
      for (let index = 1; index < line.length; index += 1) {
        segments.push({
          start: { x: line[index - 1].x * scale, y: line[index - 1].y * scale },
          end: { x: line[index].x * scale, y: line[index].y * scale },
        });
      }
    }
  }
  return segments;
}

function segmentsSharePositiveLength(
  first: LineSegment,
  second: LineSegment
): boolean {
  const dx = first.end.x - first.start.x;
  const dy = first.end.y - first.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= POLYGON_BOUNDARY_TOLERANCE) return false;
  const crossStart = Math.abs(
    dx * (second.start.y - first.start.y) -
    dy * (second.start.x - first.start.x)
  ) / length;
  const crossEnd = Math.abs(
    dx * (second.end.y - first.start.y) -
    dy * (second.end.x - first.start.x)
  ) / length;
  if (
    crossStart > POLYGON_BOUNDARY_TOLERANCE ||
    crossEnd > POLYGON_BOUNDARY_TOLERANCE
  ) {
    return false;
  }
  const lengthSquared = length * length;
  const startRatio = (
    (second.start.x - first.start.x) * dx +
    (second.start.y - first.start.y) * dy
  ) / lengthSquared;
  const endRatio = (
    (second.end.x - first.start.x) * dx +
    (second.end.y - first.start.y) * dy
  ) / lengthSquared;
  const overlapStart = Math.max(0, Math.min(startRatio, endRatio));
  const overlapEnd = Math.min(1, Math.max(startRatio, endRatio));
  return (overlapEnd - overlapStart) * length > POLYGON_BOUNDARY_TOLERANCE;
}

function polygonTouchesBoundary(
  rings: VectorTilePoint[][],
  typedSegments: LineSegment[]
): boolean {
  for (const ring of rings) {
    for (let index = 1; index < ring.length; index += 1) {
      const boundary = { start: ring[index - 1], end: ring[index] };
      if (typedSegments.some((typed) => segmentsSharePositiveLength(boundary, typed))) {
        return true;
      }
    }
  }
  return false;
}

function prepareWaterTile(tile: DecodedTile): PreparedWaterTile {
  const cached = preparedWaterTiles.get(tile.vectorTile);
  if (cached) return cached;
  const layers = tile.vectorTile.layers;
  const waterLayer = layers.waterarea;
  const extent = waterLayer?.extent ?? 4096;
  const riverSegments = lineSegments(
    layers.river,
    extent,
    (properties) => RIVER_BOUNDARY_FEATURE_CODES.has(Number(properties.ftCode))
  );
  const genericSegments = [
    ...lineSegments(layers.lake, extent, () => true),
    ...lineSegments(layers.coastline, extent, () => true),
  ];
  const polygons: PreparedWaterPolygon[] = [];
  if (waterLayer) {
    for (let featureIndex = 0; featureIndex < waterLayer.length; featureIndex += 1) {
      for (const rings of classifyRings(waterLayer.feature(featureIndex).loadGeometry())) {
        polygons.push({
          rings,
          kind: polygonTouchesBoundary(rings, riverSegments)
            ? "river"
            : polygonTouchesBoundary(rings, genericSegments)
              ? "sea-or-other-water"
              : "untyped-water",
        });
      }
    }
  }
  const prepared = { extent, polygons };
  preparedWaterTiles.set(tile.vectorTile, prepared);
  return prepared;
}

function waterKindAtPoint(
  tile: DecodedTile,
  position: TilePosition
): "none" | "river" | "sea-or-other-water" | "untyped-water" {
  const prepared = prepareWaterTile(tile);
  const point = localPoint(position, prepared.extent);
  let genericWater = false;
  let untypedWater = false;
  for (const polygon of prepared.polygons) {
    if (!polygonContainsPoint(polygon.rings, point)) continue;
    if (polygon.kind === "river") return "river";
    if (polygon.kind === "sea-or-other-water") genericWater = true;
    else untypedWater = true;
  }
  return genericWater
    ? "sea-or-other-water"
    : untypedWater
      ? "untyped-water"
      : "none";
}

function hasOnlyHydrographicLayers(tile: DecodedTile): boolean {
  const hydrographicLayers = new Set([
    "waterarea",
    "river",
    "lake",
    "coastline",
    "label",
    "symbol",
    "boundary",
  ]);
  const layerNames = Object.keys(tile.vectorTile.layers);
  return layerNames.length === 0 ||
    layerNames.every((layerName) => hydrographicLayers.has(layerName));
}

/**
 * Uses GSI's z16 nationwide vector tiles (including the z17 source detail) to
 * classify every supplied point. A null result means the batch cannot be
 * classified safely and the caller should use its existing Overpass fallback.
 */
export async function lookupGsiWaterSurfaceContexts(
  points: GsiWaterPoint[],
  signal?: AbortSignal
): Promise<GsiWaterSurfaceContext[] | null> {
  if (points.length === 0) return [];
  if (signal?.aborted) throw createAbortError();
  const positions = points.map((point) =>
    positionAtZoom(point, WATER_GEOMETRY_ZOOM)
  );
  try {
    const tiles = await fetchTiles(positions, signal);
    const contexts: Array<GsiWaterSurfaceContext | null> = [];
    const ambiguousWaterIndexes: number[] = [];
    const uncertainMaskIndexes: number[] = [];

    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index];
      const tile = tiles.get(tileKey(position));
      if (!tile) return null;
      if (tile.state === "missing") {
        contexts.push(null);
        uncertainMaskIndexes.push(index);
        continue;
      }
      const kind = waterKindAtPoint(tile, position);
      if (kind === "none") {
        if (hasOnlyHydrographicLayers(tile)) {
          // At high zoom the GSI offshore mask can be sparse even inside a
          // valid 200 tile. Consult the complete z13 sea mask before deciding.
          contexts.push(null);
          uncertainMaskIndexes.push(index);
        } else {
          contexts.push({ onWaterSurface: false, waterSurfaceKind: "none" });
        }
        continue;
      }
      if (kind !== "untyped-water") {
        contexts.push({ onWaterSurface: true, waterSurfaceKind: kind });
      } else {
        contexts.push(null);
        ambiguousWaterIndexes.push(index);
      }
    }

    if (uncertainMaskIndexes.length > 0) {
      const maskPositions = new Map<number, TilePosition>();
      for (const index of uncertainMaskIndexes) {
        maskPositions.set(
          index,
          positionAtZoom(points[index], WATER_MASK_FALLBACK_ZOOM)
        );
      }
      const maskTiles = await fetchTiles([...maskPositions.values()], signal);
      for (const index of uncertainMaskIndexes) {
        const maskPosition = maskPositions.get(index);
        const maskTile = maskPosition && maskTiles.get(tileKey(maskPosition));
        const highResolutionTile = tiles.get(tileKey(positions[index]));
        if (
          maskPosition &&
          maskTile?.state === "decoded" &&
          waterKindAtPoint(maskTile, maskPosition) !== "none"
        ) {
          contexts[index] = {
            onWaterSurface: true,
            waterSurfaceKind: "sea-or-other-water",
          };
        } else if (highResolutionTile?.state === "decoded" && maskTile?.state === "decoded") {
          contexts[index] = {
            onWaterSurface: false,
            waterSurfaceKind: "none",
          };
        } else {
          // A missing z16 tile outside the complete low-zoom sea mask may be
          // outside GSI coverage. Let Overpass decide instead of assuming land.
          return null;
        }
      }
    }

    if (ambiguousWaterIndexes.length > 0) {
      const fallbackPositions = new Map<number, TilePosition>();
      for (const index of ambiguousWaterIndexes) {
        fallbackPositions.set(
          index,
          positionAtZoom(points[index], WATER_KIND_FALLBACK_ZOOM)
        );
      }
      let fallbackTiles: Map<string, TileResult> | null = null;
      try {
        fallbackTiles = await fetchTiles([...fallbackPositions.values()], signal);
      } catch {
        if (signal?.aborted) throw createAbortError();
        return null;
      }
      for (const index of ambiguousWaterIndexes) {
        const position = fallbackPositions.get(index);
        const tile = position && fallbackTiles?.get(tileKey(position));
        const kind = tile?.state === "decoded" && position
          ? waterKindAtPoint(tile, position)
          : "none";
        if (kind === "none") return null;
        // z16 already proved the point is water. At z14, an untyped water
        // polygon whose natural boundary remains outside the tile is a wide
        // lake or sea; a Japanese river boundary fits within this wider tile.
        contexts[index] = {
          onWaterSurface: true,
          waterSurfaceKind: kind === "river" ? "river" : "sea-or-other-water",
        };
      }
    }

    return contexts.every((context): context is GsiWaterSurfaceContext => context !== null)
      ? contexts
      : null;
  } catch {
    if (signal?.aborted) throw createAbortError();
    return null;
  }
}
