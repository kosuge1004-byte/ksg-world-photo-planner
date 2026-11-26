import { VectorTile, type VectorTileLayer } from "@mapbox/vector-tile";
import Pbf from "pbf";

import {
  calculateKarneyDestinationPoint,
  calculateKarneySurfaceDistanceMeters,
  calculateKarneySurfaceMetrics,
} from "../src/geodesy/karneyGeodesic.ts";
import { createAbortError, createTimeoutError } from "./runtimeErrors.ts";
import {
  lookupGsiWaterSurfaceContexts,
  type GsiWaterSurfaceContext,
} from "./gsiWaterSurface.ts";

export type GsiBridgePoint = {
  latitude: number;
  longitude: number;
};

export type GsiBridgeSurfaceContext = {
  bridgeKey: string;
  positionFraction: number;
  centerlineDistanceMeters: number;
  startOutsidePoints: GsiBridgePoint[];
  endOutsidePoints: GsiBridgePoint[];
};

type TileAddress = { zoom: number; x: number; y: number };
type TilePosition = TileAddress & { worldX: number; worldY: number };
type DecodedTile = TileAddress & { state: "decoded"; vectorTile: VectorTile };
type MissingTile = TileAddress & { state: "missing" };
type TileResult = DecodedTile | MissingTile;
type TileGeometryPoint = { x: number; y: number };

export type PreparedBridgeLine = {
  bridgeKey: string;
  points: GsiBridgePoint[];
  halfWidthMeters: number;
  clippedAtTileBoundary: boolean;
};

const GSI_VECTOR_TILE_BASE_URL =
  "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap";
// z13 still carries the bridge/elevated road centreline and covers about 4 km
// per tile in Japan. That wider tile is intentional: a long bridge must have
// both true land-side endpoints in one decoded tile before we derive a slope.
const BRIDGE_GEOMETRY_ZOOM = 13;
const TILE_REQUEST_TIMEOUT_MS = 6_000;
const TILE_FETCH_CONCURRENCY = 6;
const MAX_TILE_CACHE_ENTRIES = 128;
const MAX_TILE_BYTES = 5 * 1024 * 1024;
const TILE_BOUNDARY_TOLERANCE = 1;
const ROAD_POSITION_TOLERANCE_METERS = 1.5;
const OUTSIDE_SAMPLE_DISTANCES_METERS = [6, 12, 24] as const;
const BRIDGE_CENTERLINE_FEATURE_CODES = new Set([2703, 2713, 2723, 2733]);

const completedTileCache = new Map<string, TileResult>();
const preparedBridgeTiles = new WeakMap<VectorTile, PreparedBridgeLine[]>();
const bridgeSupportObjects = new WeakSet<object>();

export function markBridgeSupportSurfaceSample(sample: object): void {
  bridgeSupportObjects.add(sample);
}

export function isBridgeSupportSurfaceSample(sample: object): boolean {
  return bridgeSupportObjects.has(sample);
}

function tileKey(address: TileAddress): string {
  return `${address.zoom}/${address.x}/${address.y}`;
}

function rememberTile(key: string, tile: TileResult): void {
  completedTileCache.delete(key);
  completedTileCache.set(key, tile);
  while (completedTileCache.size > MAX_TILE_CACHE_ENTRIES) {
    const oldest = completedTileCache.keys().next().value as string | undefined;
    if (!oldest) break;
    completedTileCache.delete(oldest);
  }
}

export function clearGsiBridgeTileCacheForTests(): void {
  completedTileCache.clear();
}

function positionAtZoom(point: GsiBridgePoint, zoom: number): TilePosition {
  const scale = 2 ** zoom;
  const latitudeRadians = point.latitude * Math.PI / 180;
  const worldX = (point.longitude + 180) / 360 * scale;
  const worldY = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale;
  return {
    zoom,
    x: Math.floor(worldX),
    y: Math.floor(worldY),
    worldX,
    worldY,
  };
}

async function fetchTile(address: TileAddress, signal?: AbortSignal): Promise<TileResult> {
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
    () => controller.abort(createTimeoutError("GSI bridge vector tile timeout")),
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
    if (!response.ok) throw new Error(`GSI bridge tile request failed: ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TILE_BYTES) {
      throw new Error("GSI bridge tile exceeded the byte limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TILE_BYTES) throw new Error("GSI bridge tile exceeded the byte limit");
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
  const unique = new Map<string, TileAddress>();
  for (const address of addresses) unique.set(tileKey(address), address);
  const queue = [...unique.values()];
  const results = new Map<string, TileResult>();
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(TILE_FETCH_CONCURRENCY, queue.length) },
    async () => {
      while (nextIndex < queue.length) {
        const address = queue[nextIndex++];
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

function tilePointToCoordinate(
  address: TileAddress,
  point: TileGeometryPoint,
  extent: number
): GsiBridgePoint {
  const scale = 2 ** address.zoom;
  const worldX = (address.x + point.x / extent) / scale;
  const worldY = (address.y + point.y / extent) / scale;
  return {
    longitude: worldX * 360 - 180,
    latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI,
  };
}

function isAtTileBoundary(point: TileGeometryPoint, extent: number): boolean {
  return point.x <= TILE_BOUNDARY_TOLERANCE || point.y <= TILE_BOUNDARY_TOLERANCE ||
    point.x >= extent - TILE_BOUNDARY_TOLERANCE ||
    point.y >= extent - TILE_BOUNDARY_TOLERANCE;
}

function roadHalfWidthMeters(properties: Record<string, unknown>): number {
  const rank = Number(properties.rnkWidth);
  // GSI width ranks are categorical. Values are deliberately conservative:
  // the extra 1.5 m positional tolerance is added separately below.
  const byRank: Record<number, number> = {
    0: 3,
    1: 1.5,
    2: 2.75,
    3: 4.5,
    4: 9.75,
    5: 14,
  };
  return byRank[rank] ?? 3;
}

function prepareBridgeTile(tile: DecodedTile): PreparedBridgeLine[] {
  const cached = preparedBridgeTiles.get(tile.vectorTile);
  if (cached) return cached;
  const layer: VectorTileLayer | undefined = tile.vectorTile.layers.road;
  type RawBridgeLine = {
    ids: number[];
    raw: TileGeometryPoint[];
    halfWidthMeters: number;
  };
  const rawLines: RawBridgeLine[] = [];
  if (layer) {
    for (let featureIndex = 0; featureIndex < layer.length; featureIndex += 1) {
      const feature = layer.feature(featureIndex);
      if (!BRIDGE_CENTERLINE_FEATURE_CODES.has(Number(feature.properties.ftCode))) continue;
      const geometry = feature.loadGeometry();
      for (let lineIndex = 0; lineIndex < geometry.length; lineIndex += 1) {
        const raw = geometry[lineIndex];
        if (raw.length < 2) continue;
        rawLines.push({
          ids: [featureIndex * 100 + lineIndex],
          raw: raw.map((point) => ({ x: point.x, y: point.y })),
          halfWidthMeters: roadHalfWidthMeters(feature.properties),
        });
      }
    }
  }
  // GSI may split one bridge at attribute changes or data-maintenance nodes.
  // Join only exactly identical quantized endpoints. A distance tolerance
  // would accidentally connect parallel carriageways that are less than a
  // metre apart, producing an approach from the wrong deck.
  const endpointKey = (point: TileGeometryPoint) => `${point.x}:${point.y}`;
  let joined = true;
  while (joined) {
    joined = false;
    outer: for (let leftIndex = 0; leftIndex < rawLines.length; leftIndex += 1) {
      const left = rawLines[leftIndex];
      const leftStart = endpointKey(left.raw[0]);
      const leftEnd = endpointKey(left.raw[left.raw.length - 1]);
      for (let rightIndex = leftIndex + 1; rightIndex < rawLines.length; rightIndex += 1) {
        const right = rawLines[rightIndex];
        const rightStart = endpointKey(right.raw[0]);
        const rightEnd = endpointKey(right.raw[right.raw.length - 1]);
        let merged: TileGeometryPoint[] | null = null;
        if (leftEnd === rightStart) {
          merged = [...left.raw, ...right.raw.slice(1)];
        } else if (leftEnd === rightEnd) {
          merged = [...left.raw, ...[...right.raw].reverse().slice(1)];
        } else if (leftStart === rightEnd) {
          merged = [...right.raw, ...left.raw.slice(1)];
        } else if (leftStart === rightStart) {
          merged = [...[...right.raw].reverse(), ...left.raw.slice(1)];
        }
        if (!merged) continue;
        rawLines[leftIndex] = {
          ids: [...left.ids, ...right.ids].sort((a, b) => a - b),
          raw: merged,
          halfWidthMeters: Math.max(left.halfWidthMeters, right.halfWidthMeters),
        };
        rawLines.splice(rightIndex, 1);
        joined = true;
        break outer;
      }
    }
  }

  const lines: PreparedBridgeLine[] = [];
  for (const rawLine of rawLines) {
    if (endpointKey(rawLine.raw[0]) === endpointKey(rawLine.raw[rawLine.raw.length - 1])) continue;
    const points = rawLine.raw.map((point) => tilePointToCoordinate(tile, point, layer?.extent ?? 4096));
    const lengthMeters = points.slice(1).reduce(
      (sum, point, index) => sum + calculateKarneySurfaceDistanceMeters(points[index], point),
      0
    );
    if (!(lengthMeters >= 3)) continue;
    lines.push({
      bridgeKey: `${tileKey(tile)}/road/${rawLine.ids.join("-")}`,
      points,
      halfWidthMeters: rawLine.halfWidthMeters,
      clippedAtTileBoundary:
        isAtTileBoundary(rawLine.raw[0], layer?.extent ?? 4096) ||
        isAtTileBoundary(rawLine.raw[rawLine.raw.length - 1], layer?.extent ?? 4096),
    });
  }
  preparedBridgeTiles.set(tile.vectorTile, lines);
  return lines;
}

function projectedRatioAndDistance(
  query: GsiBridgePoint,
  start: GsiBridgePoint,
  end: GsiBridgePoint
): { ratio: number; distanceMeters: number } {
  const latitudeRadians = query.latitude * Math.PI / 180;
  const metersPerLatitudeDegree = 111_132;
  const metersPerLongitudeDegree = 111_320 * Math.cos(latitudeRadians);
  const startX = (start.longitude - query.longitude) * metersPerLongitudeDegree;
  const startY = (start.latitude - query.latitude) * metersPerLatitudeDegree;
  const endX = (end.longitude - query.longitude) * metersPerLongitudeDegree;
  const endY = (end.latitude - query.latitude) * metersPerLatitudeDegree;
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared > 1e-9
    ? Math.max(0, Math.min(1, -(startX * dx + startY * dy) / lengthSquared))
    : 0;
  const x = startX + ratio * dx;
  const y = startY + ratio * dy;
  return { ratio, distanceMeters: Math.hypot(x, y) };
}

function outsidePoints(
  endpoint: GsiBridgePoint,
  adjacent: GsiBridgePoint,
  reverse: boolean
): GsiBridgePoint[] {
  const metrics = reverse
    ? calculateKarneySurfaceMetrics(adjacent, endpoint)
    : calculateKarneySurfaceMetrics(endpoint, adjacent);
  const bearing = reverse ? metrics.bearingDegrees : (metrics.bearingDegrees + 180) % 360;
  return OUTSIDE_SAMPLE_DISTANCES_METERS.map((distanceMeters) => {
    const destination = calculateKarneyDestinationPoint(
      { ...endpoint, height: 0, label: "bridge approach" },
      bearing,
      distanceMeters
    );
    return { latitude: destination.latitude, longitude: destination.longitude };
  });
}

/**
 * Pure geometry selection used by production and regression tests. A feature
 * clipped by the tile edge is rejected because its true bridge endpoints are
 * unknown; guessing those endpoints would create a false deck slope.
 */
export function bridgeSurfaceContextForPreparedLines(
  point: GsiBridgePoint,
  lines: readonly PreparedBridgeLine[]
): GsiBridgeSurfaceContext | null {
  const selected = selectPreparedBridgeLine(point, lines, false);
  if (!selected) return null;
  return endpointBridgeContext(selected);
}

type BridgeSelection = {
  line: PreparedBridgeLine;
  positionDistanceMeters: number;
  totalLengthMeters: number;
  distanceMeters: number;
};

function selectPreparedBridgeLine(
  point: GsiBridgePoint,
  lines: readonly PreparedBridgeLine[],
  allowClipped: boolean
): BridgeSelection | null {
  let selected: BridgeSelection | null = null;
  for (const line of lines) {
    if ((!allowClipped && line.clippedAtTileBoundary) || line.points.length < 2) continue;
    const segmentLengths = line.points.slice(1).map((target, index) =>
      calculateKarneySurfaceDistanceMeters(line.points[index], target)
    );
    const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
    if (!(totalLength > 0)) continue;
    let traversed = 0;
    for (let index = 1; index < line.points.length; index += 1) {
      const nearest = projectedRatioAndDistance(point, line.points[index - 1], line.points[index]);
      if (nearest.distanceMeters <= line.halfWidthMeters + ROAD_POSITION_TOLERANCE_METERS &&
        (!selected || nearest.distanceMeters < selected.distanceMeters)) {
        selected = {
          line,
          positionDistanceMeters: traversed + segmentLengths[index - 1] * nearest.ratio,
          totalLengthMeters: totalLength,
          distanceMeters: nearest.distanceMeters,
        };
      }
      traversed += segmentLengths[index - 1];
    }
  }
  return selected;
}

function endpointBridgeContext(selected: BridgeSelection): GsiBridgeSurfaceContext {
  const line = selected.line;
  return {
    bridgeKey: line.bridgeKey,
    positionFraction: Math.max(0, Math.min(
      1,
      selected.positionDistanceMeters / selected.totalLengthMeters
    )),
    centerlineDistanceMeters: selected.distanceMeters,
    startOutsidePoints: outsidePoints(line.points[0], line.points[1], false),
    endOutsidePoints: outsidePoints(
      line.points[line.points.length - 1],
      line.points[line.points.length - 2],
      true
    ),
  };
}

function pointAlongBridgeLine(
  selection: BridgeSelection,
  signedOffsetMeters: number
): { point: GsiBridgePoint; actualOffsetMeters: number } | null {
  const target = Math.max(0, Math.min(
    selection.totalLengthMeters,
    selection.positionDistanceMeters + signedOffsetMeters
  ));
  if (Math.abs(target - selection.positionDistanceMeters) < 1) return null;
  let traversed = 0;
  for (let index = 1; index < selection.line.points.length; index += 1) {
    const start = selection.line.points[index - 1];
    const end = selection.line.points[index];
    const length = calculateKarneySurfaceDistanceMeters(start, end);
    if (target <= traversed + length || index === selection.line.points.length - 1) {
      const inside = Math.max(0, Math.min(length, target - traversed));
      const metrics = calculateKarneySurfaceMetrics(start, end);
      const destination = calculateKarneyDestinationPoint(
        { ...start, height: 0, label: "bridge centreline" },
        metrics.bearingDegrees,
        inside
      );
      return {
        point: { latitude: destination.latitude, longitude: destination.longitude },
        actualOffsetMeters: target - selection.positionDistanceMeters,
      };
    }
    traversed += length;
  }
  return null;
}

const APPROACH_SEARCH_DISTANCES_METERS = [24, 48, 96, 192, 384, 768, 1_536, 2_500] as const;

type ApproachCandidate = {
  point: GsiBridgePoint;
  actualOffsetMeters: number;
};

function approachCandidates(
  selection: BridgeSelection,
  direction: -1 | 1
): ApproachCandidate[] {
  const candidates: ApproachCandidate[] = [];
  const seen = new Set<string>();
  for (const distance of APPROACH_SEARCH_DISTANCES_METERS) {
    const candidate = pointAlongBridgeLine(selection, direction * distance);
    if (!candidate) continue;
    const key = `${candidate.point.latitude}:${candidate.point.longitude}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

export async function lookupGsiBridgeSurfaceContexts(
  points: GsiBridgePoint[],
  signal?: AbortSignal
): Promise<Array<GsiBridgeSurfaceContext | null> | null> {
  if (points.length === 0) return [];
  if (signal?.aborted) throw createAbortError();
  const positions = points.map((point) => positionAtZoom(point, BRIDGE_GEOMETRY_ZOOM));
  try {
    const tiles = await fetchTiles(positions, signal);
    const selections = positions.map((position, index) => {
      const tile = tiles.get(tileKey(position));
      if (!tile || tile.state === "missing") return null;
      return selectPreparedBridgeLine(points[index], prepareBridgeTile(tile), true);
    });
    const searchEntries: Array<{
      pointIndex: number;
      side: "query" | "start" | "end";
      candidate: ApproachCandidate;
    }> = [];
    selections.forEach((selection, pointIndex) => {
      if (!selection) return;
      searchEntries.push({
        pointIndex,
        side: "query",
        candidate: { point: points[pointIndex], actualOffsetMeters: 0 },
      });
      for (const candidate of approachCandidates(selection, -1)) {
        searchEntries.push({ pointIndex, side: "start", candidate });
      }
      for (const candidate of approachCandidates(selection, 1)) {
        searchEntries.push({ pointIndex, side: "end", candidate });
      }
    });
    const water = searchEntries.length > 0
      ? await lookupGsiWaterSurfaceContexts(
          searchEntries.map((entry) => entry.candidate.point),
          signal
        )
      : [];
    const entriesByPoint = new Map<number, Array<{
      entry: (typeof searchEntries)[number];
      water: GsiWaterSurfaceContext | null | undefined;
    }>>();
    searchEntries.forEach((entry, index) => {
      const grouped = entriesByPoint.get(entry.pointIndex) ?? [];
      grouped.push({ entry, water: water?.[index] });
      entriesByPoint.set(entry.pointIndex, grouped);
    });

    return selections.map((selection, pointIndex) => {
      if (!selection) return null;
      const entries = entriesByPoint.get(pointIndex) ?? [];
      const query = entries.find(({ entry }) => entry.side === "query")?.water;
      if (query?.onWaterSurface) {
        const dryStart = entries.filter(({ entry, water: waterContext }) =>
          entry.side === "start" && waterContext?.onWaterSurface === false
        ).slice(0, 3);
        const dryEnd = entries.filter(({ entry, water: waterContext }) =>
          entry.side === "end" && waterContext?.onWaterSurface === false
        ).slice(0, 3);
        if (dryStart.length > 0 && dryEnd.length > 0) {
          const startDistance = Math.min(...dryStart.map(({ entry }) =>
            Math.abs(entry.candidate.actualOffsetMeters)
          ));
          const endDistance = Math.min(...dryEnd.map(({ entry }) =>
            Math.abs(entry.candidate.actualOffsetMeters)
          ));
          return {
            bridgeKey: `${selection.line.bridgeKey}/water/${Math.round(
              selection.positionDistanceMeters / 25
            )}`,
            positionFraction: startDistance / (startDistance + endDistance),
            centerlineDistanceMeters: selection.distanceMeters,
            startOutsidePoints: dryStart.map(({ entry }) => entry.candidate.point),
            endOutsidePoints: dryEnd.map(({ entry }) => entry.candidate.point),
          };
        }
        return null;
      }
      // For a bridge/elevated road over land, only true un-clipped feature
      // endpoints are safe approach anchors. If water classification itself
      // failed, the same conservative fallback applies.
      return selection.line.clippedAtTileBoundary ? null : endpointBridgeContext(selection);
    });
  } catch {
    if (signal?.aborted) throw createAbortError();
    // Bridge support is an enhancement. If the vector tile is temporarily
    // unavailable, keep the original DEM rather than failing the search.
    return null;
  }
}

function medianFinite(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 1
    ? finite[middle]
    : (finite[middle - 1] + finite[middle]) / 2;
}

export const EXISTING_BRIDGE_HEIGHT_TOLERANCE_METERS = 1;

/**
 * Resolves one bridge point in orthometric metres. Existing DEM that already
 * agrees with the deck is retained byte-for-byte. Otherwise, the road heights
 * immediately before and after the bridge define a sloped (not flat) deck.
 */
export function resolveBridgeDeckOrthometricHeight(input: {
  existingHeightMeters: number;
  startApproachHeightsMeters: readonly number[];
  endApproachHeightsMeters: readonly number[];
  positionFraction: number;
}): number | null {
  const start = medianFinite(input.startApproachHeightsMeters);
  const end = medianFinite(input.endApproachHeightsMeters);
  if (start === null || end === null || !Number.isFinite(input.positionFraction)) return null;
  const fraction = Math.max(0, Math.min(1, input.positionFraction));
  const interpolated = start + (end - start) * fraction;
  // Preserve a measured deck not only when it follows the straight approach
  // grade, but also when it rises above that grade (arched/suspension bridges).
  // The approach interpolation replaces only a value clearly below both road
  // approaches, which is the riverbed/water DEM failure this model targets.
  return Number.isFinite(input.existingHeightMeters) &&
      input.existingHeightMeters >=
        Math.min(start, end) - EXISTING_BRIDGE_HEIGHT_TOLERANCE_METERS
    ? input.existingHeightMeters
    : interpolated;
}
