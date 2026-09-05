import { createAbortError, createTimeoutError } from "./runtimeErrors.ts";
import {
  precisionStructuresNear,
} from "./precisionStructures.ts";
import type {
  PrecisionStructureType,
} from "./precisionStructures.ts";
import { calculateKarneySurfaceMetrics } from "../src/geodesy/karneyGeodesic.ts";

export type OsmContextRequestPoint = {
  latitude: number;
  longitude: number;
};

export type OsmNearbyLandmark = {
  name: string;
  type:
    | "shrine"
    | "torii"
    | "historic-building"
    | "landmark-building"
    | "hotel"
    | "communications-tower"
    | "communications-mast"
    | "tower";
  distanceMeters: number;
};

export type OsmNearbyStructure = {
  name: string;
  type: PrecisionStructureType;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  groundElevationMeters: number | null;
  groundElevationSource: "GSI_DEM1A_LIDAR" | null;
  structureHeightMeters: number | null;
  heightSource: "surveyed" | "levels-estimate" | null;
  osmType: "node" | "way" | "relation";
  osmId: number;
  sourceUrl: string;
  note: string | null;
};

export type OsmNamedBuilding = {
  name: string;
  distanceMeters: number;
  heightMeters: number | null;
  heightSource: "surveyed" | "levels-estimate" | null;
  wikidata: string | null;
};

export type OsmSiteContext = {
  walkingAccessible: boolean;
  onMappedWay: boolean;
  restrictedAccess: boolean;
  onMotorRoad: boolean;
  onWaterSurface: boolean;
  waterSurfaceKind: "none" | "river" | "sea-or-other-water";
  nearbyLandmarks: OsmNearbyLandmark[];
  nearbyBuildings: OsmNamedBuilding[];
  nearbyStructures: OsmNearbyStructure[];
};

export type OsmCoordinate = { lat: number; lon: number };
export type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: OsmCoordinate;
  geometry?: OsmCoordinate[];
  tags?: Record<string, string>;
};

type OverpassResponse = { elements?: unknown };

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
] as const;
const OVERPASS_RETRY_DELAYS_MS = [0, 450] as const;
const OVERPASS_REQUEST_TIMEOUT_MS = 6_000;
const OVERPASS_TOTAL_TIMEOUT_MS = 15_000;
const PRIVATE_ACCESS_VALUES = new Set(["private", "no", "customers", "permit"]);
const NON_WALKABLE_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "construction",
  "proposed",
]);
const MOTOR_ROAD_HALF_WIDTH_METERS: Record<string, number> = {
  motorway: 7.5,
  motorway_link: 4,
  trunk: 6,
  trunk_link: 4,
  primary: 5,
  primary_link: 4,
  secondary: 4.5,
  secondary_link: 3.8,
  tertiary: 4,
  tertiary_link: 3.5,
  unclassified: 3.5,
  residential: 3.2,
  living_street: 3.2,
  service: 2.8,
  road: 3.5,
};

function isOsmElement(value: unknown): value is OsmElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "node" || value.type === "way" || value.type === "relation") &&
    "id" in value &&
    typeof value.id === "number"
  );
}

export function geometryOf(element: OsmElement): OsmCoordinate[] {
  if (Array.isArray(element.geometry)) {
    return element.geometry.filter((point) =>
      Number.isFinite(point.lat) && Number.isFinite(point.lon)
    );
  }
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
    return [{ lat: element.lat as number, lon: element.lon as number }];
  }
  return element.center ? [element.center] : [];
}

export function localMeters(
  coordinate: OsmCoordinate,
  origin: OsmContextRequestPoint
): { x: number; y: number } {
  const metrics = calculateKarneySurfaceMetrics(origin, {
    latitude: coordinate.lat,
    longitude: coordinate.lon,
  });
  const bearingRadians = metrics.bearingDegrees * Math.PI / 180;
  return {
    x: Math.sin(bearingRadians) * metrics.distanceMeters,
    y: Math.cos(bearingRadians) * metrics.distanceMeters,
  };
}

function pointSegmentDistanceMeters(
  start: OsmCoordinate,
  end: OsmCoordinate,
  point: OsmContextRequestPoint
): number {
  const a = localMeters(start, point);
  const b = localMeters(end, point);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-9) return Math.hypot(a.x, a.y);
  const ratio = Math.max(
    0,
    Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(a.x + ratio * dx, a.y + ratio * dy);
}

function distanceToElementMeters(
  element: OsmElement,
  point: OsmContextRequestPoint
): number {
  const geometry = geometryOf(element);
  if (geometry.length === 0) return Number.POSITIVE_INFINITY;
  if (geometry.length === 1) {
    const local = localMeters(geometry[0], point);
    return Math.hypot(local.x, local.y);
  }
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < geometry.length; index += 1) {
    distance = Math.min(
      distance,
      pointSegmentDistanceMeters(geometry[index - 1], geometry[index], point)
    );
  }
  return distance;
}

function polygonContainsPoint(
  geometry: OsmCoordinate[],
  point: OsmContextRequestPoint
): boolean {
  if (geometry.length < 4) return false;
  const first = geometry[0];
  const last = geometry.at(-1);
  if (!last || first.lat !== last.lat || first.lon !== last.lon) return false;
  let inside = false;
  for (let current = 0, previous = geometry.length - 1; current < geometry.length; previous = current, current += 1) {
    const a = geometry[current];
    const b = geometry[previous];
    const crosses = (a.lat > point.latitude) !== (b.lat > point.latitude) &&
      point.longitude <
        (b.lon - a.lon) * (point.latitude - a.lat) / (b.lat - a.lat) + a.lon;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function numericMeters(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("ft") || normalized.includes("'")) return null;
  const match = normalized.match(/^-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

const METERS_PER_BUILDING_LEVEL = 3;

export type EstimatedHeight = {
  heightMeters: number | null;
  heightSource: "surveyed" | "levels-estimate" | null;
};

/**
 * OSMの height / building:levels タグから建物高さを推定する共通ロジック。
 * height（実測値）があればそれを優先し、なければ building:levels ×3mで概算する。
 */
export function estimateHeightFromTags(tags: Record<string, string>): EstimatedHeight {
  const mappedHeight = numericMeters(tags.height);
  const levels = numericMeters(tags["building:levels"]);
  const heightMeters = mappedHeight ?? (levels === null ? null : levels * METERS_PER_BUILDING_LEVEL);
  return {
    heightMeters,
    heightSource: mappedHeight !== null
      ? "surveyed"
      : levels !== null
        ? "levels-estimate"
        : null,
  };
}

function isRestricted(element: OsmElement, point: OsmContextRequestPoint): boolean {
  const tags = element.tags ?? {};
  const restricted = PRIVATE_ACCESS_VALUES.has(tags.access) ||
    PRIVATE_ACCESS_VALUES.has(tags.foot);
  if (!restricted) return false;
  const geometry = geometryOf(element);
  return polygonContainsPoint(geometry, point) ||
    (Boolean(tags.highway) && distanceToElementMeters(element, point) <= 12);
}

function isWalkable(element: OsmElement, point: OsmContextRequestPoint): boolean {
  const tags = element.tags ?? {};
  if (!tags.highway || NON_WALKABLE_HIGHWAYS.has(tags.highway)) return false;
  if (PRIVATE_ACCESS_VALUES.has(tags.access) || PRIVATE_ACCESS_VALUES.has(tags.foot)) {
    return false;
  }
  return distanceToElementMeters(element, point) <= 25;
}

const OPEN_PUBLIC_LAND_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["landuse", "riverbank"],
  ["natural", "beach"],
  ["leisure", "park"],
  // 駐車場（amenity=parking）。私有地扱いのもの（access/footが制限値）は
  // 下のチェックで除外される。
  ["amenity", "parking"],
  // 運動場・競技場・グラウンド等の公共スポーツ施設用地。
  ["leisure", "pitch"],
  ["leisure", "sports_centre"],
  ["leisure", "stadium"],
  ["leisure", "track"],
];

/**
 * 河川敷・公園・砂浜のような、highwayタグを持たない開けた公共空間。
 * 近くに歩道が地図に無くても、この面（ポリゴン）の内側にある候補地点は
 * 歩行可能とみなす。私有地扱い（access/footが制限値）のものは除外する。
 */
function isOnOpenPublicLand(element: OsmElement, point: OsmContextRequestPoint): boolean {
  const tags = element.tags ?? {};
  const isOpenLand = OPEN_PUBLIC_LAND_TAGS.some(([key, value]) => tags[key] === value);
  if (!isOpenLand) return false;
  if (PRIVATE_ACCESS_VALUES.has(tags.access) || PRIVATE_ACCESS_VALUES.has(tags.foot)) {
    return false;
  }
  return polygonContainsPoint(geometryOf(element), point);
}

/**
 * 水面そのものを表す面ポリゴンだけを判定する。
 * 線形の waterway=river/stream は幅を持たず、山間部の細い河川まで
 * 一律0mにしてしまうため対象外。natural=water / water=river /
 * waterway=riverbank の「面」の内側だけを水面として扱う。
 */
function isOnMappedWaterSurface(element: OsmElement, point: OsmContextRequestPoint): boolean {
  const tags = element.tags ?? {};
  const isWaterSurface =
    tags.natural === "water" ||
    tags.water === "river" ||
    tags.water === "canal" ||
    tags.waterway === "riverbank";
  if (!isWaterSurface) return false;
  const geometry = geometryOf(element);
  return geometry.length >= 3 && polygonContainsPoint(geometry, point);
}

function mappedWaterSurfaceKind(
  elements: OsmElement[],
  point: OsmContextRequestPoint
): "none" | "river" | "sea-or-other-water" {
  let genericWater = false;
  for (const element of elements) {
    if (!isOnMappedWaterSurface(element, point)) continue;
    const tags = element.tags ?? {};
    if (
      tags.water === "river" ||
      tags.water === "canal" ||
      tags.waterway === "riverbank"
    ) {
      return "river";
    }
    genericWater = true;
  }
  return genericWater ? "sea-or-other-water" : "none";
}

function isOnMappedWay(element: OsmElement, point: OsmContextRequestPoint): boolean {
  const tags = element.tags ?? {};
  if (!tags.highway) return false;
  const mappedWidth = numericMeters(tags.width);
  const defaultHalfWidth = MOTOR_ROAD_HALF_WIDTH_METERS[tags.highway] ?? (
    tags.highway === "pedestrian" ? 4 :
    tags.highway === "track" ? 2.5 :
    tags.highway === "footway" || tags.highway === "path" ||
      tags.highway === "steps" || tags.highway === "cycleway" ? 2 : 3
  );
  const halfWidth = mappedWidth === null
    ? defaultHalfWidth
    : Math.max(1.5, mappedWidth / 2);
  return distanceToElementMeters(element, point) <= halfWidth;
}

function isOnMotorRoad(element: OsmElement, point: OsmContextRequestPoint): boolean {
  const tags = element.tags ?? {};
  const defaultHalfWidth = tags.highway
    ? MOTOR_ROAD_HALF_WIDTH_METERS[tags.highway]
    : undefined;
  if (defaultHalfWidth === undefined) return false;
  const mappedWidth = numericMeters(tags.width);
  const halfWidth = mappedWidth === null
    ? defaultHalfWidth
    : Math.max(1.5, mappedWidth / 2);
  return distanceToElementMeters(element, point) <= halfWidth;
}

function landmarkType(element: OsmElement): OsmNearbyLandmark["type"] | null {
  const tags = element.tags ?? {};
  if (tags.tourism === "hotel") return "hotel";
  if (tags.man_made === "communications_tower") {
    return "communications-tower";
  }
  if (tags.man_made === "mast") return "communications-mast";
  if (
    tags.man_made === "tower" &&
    (tags["tower:type"] === "communication" || tags.communication)
  ) {
    return "communications-tower";
  }
  if (tags.man_made === "tower" || tags.building === "tower") return "tower";
  if (
    tags["ceremonial_gate"] === "torii" ||
    tags.man_made === "torii"
  ) {
    return "torii";
  }
  if (
    (tags.amenity === "place_of_worship" && tags.religion === "shinto") ||
    tags.building === "shrine" ||
    tags.historic === "wayside_shrine"
  ) {
    return "shrine";
  }
  if (tags.building && tags.historic) return "historic-building";
  if (
    tags.building &&
    (tags.wikidata || tags.wikipedia || tags.tourism === "attraction")
  ) {
    return "landmark-building";
  }
  return null;
}

function displayName(element: OsmElement, type: OsmNearbyLandmark["type"]): string {
  const tags = element.tags ?? {};
  return tags["name:ja"] ?? tags.name ?? (
    type === "torii"
      ? "鳥居"
      : type === "shrine"
        ? "神社"
        : type === "hotel"
          ? "ホテル"
          : type === "communications-tower"
            ? "通信塔"
            : type === "communications-mast"
              ? "通信マスト"
              : type === "tower"
                ? "塔"
        : "名称未登録の建物"
  );
}

function nearbyLandmarks(
  elements: OsmElement[],
  point: OsmContextRequestPoint
): OsmNearbyLandmark[] {
  return elements.flatMap((element) => {
    const type = landmarkType(element);
    if (!type) return [];
    const distanceMeters = distanceToElementMeters(element, point);
    if (!Number.isFinite(distanceMeters) || distanceMeters > 600) return [];
    return [{
      name: displayName(element, type),
      type,
      distanceMeters: Math.round(distanceMeters),
    }];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 8);
}

function nearbyBuildings(
  elements: OsmElement[],
  point: OsmContextRequestPoint
): OsmNamedBuilding[] {
  return elements.flatMap((element) => {
    const tags = element.tags ?? {};
    if (!tags.building || !(tags.name || tags["name:ja"] || tags.wikidata || tags.wikipedia)) {
      return [];
    }
    const distanceMeters = distanceToElementMeters(element, point);
    if (!Number.isFinite(distanceMeters) || distanceMeters > 600) return [];
    const { heightMeters, heightSource } = estimateHeightFromTags(tags);
    return [{
      name: tags["name:ja"] ?? tags.name ?? tags.wikidata ?? "名称未登録の建物",
      distanceMeters: Math.round(distanceMeters),
      heightMeters,
      heightSource,
      wikidata: tags.wikidata ?? null,
    }];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 8);
}

function structureType(element: OsmElement): PrecisionStructureType | null {
  const tags = element.tags ?? {};
  if (tags.tourism === "hotel") return "hotel";
  if (tags.man_made === "communications_tower") return "communications-tower";
  if (tags.man_made === "mast") return "communications-mast";
  if (
    tags.man_made === "tower" &&
    (tags["tower:type"] === "communication" || tags.communication)
  ) {
    return "communications-tower";
  }
  if (tags.man_made === "tower" || tags.building === "tower") return "tower";
  return null;
}

function representativeCoordinate(element: OsmElement): OsmCoordinate | null {
  if (element.center) return element.center;
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
    return { lat: element.lat as number, lon: element.lon as number };
  }
  const geometry = geometryOf(element);
  if (geometry.length === 0) return null;
  return {
    lat: geometry.reduce((sum, coordinate) => sum + coordinate.lat, 0) / geometry.length,
    lon: geometry.reduce((sum, coordinate) => sum + coordinate.lon, 0) / geometry.length,
  };
}

function nearbyStructures(
  elements: OsmElement[],
  point: OsmContextRequestPoint
): OsmNearbyStructure[] {
  const structures = new Map<string, OsmNearbyStructure>();
  for (const element of elements) {
    const type = structureType(element);
    const coordinate = representativeCoordinate(element);
    if (!type || !coordinate) continue;
    const distanceMeters = distanceToElementMeters(element, point);
    if (!Number.isFinite(distanceMeters) || distanceMeters > 1_800) continue;
    const tags = element.tags ?? {};
    const { heightMeters: structureHeightMeters, heightSource } = estimateHeightFromTags(tags);
    structures.set(`${element.type}/${element.id}`, {
      name: displayName(element, type),
      type,
      latitude: coordinate.lat,
      longitude: coordinate.lon,
      distanceMeters: Math.round(distanceMeters),
      groundElevationMeters: null,
      groundElevationSource: null,
      structureHeightMeters,
      heightSource,
      osmType: element.type,
      osmId: element.id,
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      note: null,
    });
  }

  // 美ヶ原は塔の高さタグが未登録でも固有座標とDEM1A地盤高を失わないよう内蔵値を優先する。
  for (const structure of precisionStructuresNear(point)) {
    structures.set(`${structure.osmType}/${structure.osmId}`, {
      name: structure.name,
      type: structure.type,
      latitude: structure.latitude,
      longitude: structure.longitude,
      distanceMeters: structure.distanceMeters,
      groundElevationMeters: structure.groundElevationMeters,
      groundElevationSource: structure.groundElevationSource,
      structureHeightMeters: structure.structureHeightMeters,
      heightSource: null,
      osmType: structure.osmType,
      osmId: structure.osmId,
      sourceUrl: structure.sourceUrl,
      note: structure.note,
    });
  }
  return [...structures.values()]
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 24);
}

function combinedLandmarks(
  elements: OsmElement[],
  point: OsmContextRequestPoint,
  structures: OsmNearbyStructure[]
): OsmNearbyLandmark[] {
  const landmarks = new Map<string, OsmNearbyLandmark>();
  const structureDistanceKeys = new Set(
    structures.map((structure) => `${structure.type}:${structure.distanceMeters}`)
  );
  for (const landmark of nearbyLandmarks(elements, point)) {
    if (structureDistanceKeys.has(`${landmark.type}:${landmark.distanceMeters}`)) {
      continue;
    }
    landmarks.set(`${landmark.type}:${landmark.distanceMeters}`, landmark);
  }
  for (const structure of structures) {
    landmarks.set(`structure:${structure.osmType}/${structure.osmId}`, {
      name: structure.name,
      type: structure.type,
      distanceMeters: structure.distanceMeters,
    });
  }
  return [...landmarks.values()]
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 16);
}

/**
 * 2026-09-05追記（実機報告：「スカイツリー」検索が長時間停止して見えた
 * 問題の根本原因）: この関数は元々、三脚候補探索の「歩行可能か・私有地か・
 * 車道上か・水面上か」判定用に、access系の統計（highway・私有地・水面・
 * 河川敷・公園・駐車場等）を含む大掛かりなOverpassクエリを組み立てていた。
 * ところが被写体の高さ推定（findOsmSubjectHeightHint）は、この判定結果を
 * 一切使わず、塔・建物などの構造物情報（detailStatements側）だけを必要と
 * している。にもかかわらず、これまでaccessStatementsは常に含まれており、
 * 東京スカイツリーのような情報量の多い都心部では、使いもしないaccess系の
 * 問い合わせが無料の公開Overpass APIへの負荷・応答時間を無駄に押し上げて
 * いた（タイムアウトの根本原因はこちら側にもあった）。
 * purpose="height-only"の場合はaccessStatementsを完全に省略する。この時
 * 返るwalkingAccessible等のアクセス関連フィールドは実際には問い合わせて
 * いないため意味を持たない（呼び出し側はこれらを参照しないこと）。
 */
export type SiteContextPurpose = "full" | "height-only";

function queryForPoints(
  points: OsmContextRequestPoint[],
  includeDetails: boolean,
  purpose: SiteContextPurpose = "full"
): string {
  const statements = points.flatMap((point) => {
    const aroundAccess = `(around:120,${point.latitude},${point.longitude})`;
    const aroundLandmark = `(around:600,${point.latitude},${point.longitude})`;
    const accessStatements = purpose === "full" ? [
      `way${aroundAccess}["highway"]`,
      `nwr${aroundAccess}["access"~"^(private|no|customers|permit)$"]`,
      `nwr${aroundAccess}["foot"~"^(private|no)$"]`,
      // 河川敷・公園・砂浜などhighwayタグを持たない開けた公共空間。
      // 近くに歩道が無くても、この中に入っていれば歩行可能とみなす。
      `way${aroundAccess}["landuse"="riverbank"]`,
      // 広い河川・運河等の水面ポリゴン。細い山間河川の線形waterwayは含めない。
      `nwr${aroundAccess}["natural"="water"]`,
      `nwr${aroundAccess}["water"="river"]`,
      `nwr${aroundAccess}["water"="canal"]`,
      `way${aroundAccess}["waterway"="riverbank"]`,
      `way${aroundAccess}["natural"="beach"]`,
      `way${aroundAccess}["leisure"="park"]`,
      // 駐車場・運動場等（landuse=riverbank等と同じく、歩道が無くても
      // 面の内側であれば歩行可能とみなす対象）。
      `way${aroundAccess}["amenity"="parking"]`,
      `way${aroundAccess}["leisure"="pitch"]`,
      `way${aroundAccess}["leisure"="sports_centre"]`,
      `way${aroundAccess}["leisure"="stadium"]`,
      `way${aroundAccess}["leisure"="track"]`,
    ] : [];
    const detailStatements = [
      `nwr${aroundLandmark}["amenity"="place_of_worship"]`,
      `nwr${aroundLandmark}["ceremonial_gate"="torii"]`,
      `nwr${aroundLandmark}["man_made"="torii"]`,
      `nwr${aroundLandmark}["historic"]`,
      `nwr${aroundLandmark}["tourism"="hotel"]`,
      `nwr${aroundLandmark}["man_made"~"^(tower|communications_tower|mast)$"]`,
      `nwr${aroundLandmark}["building"="tower"]`,
      `nwr${aroundLandmark}["building"]["wikidata"]`,
      `nwr${aroundLandmark}["building"]["wikipedia"]`,
      `nwr${aroundLandmark}["building"]["tourism"="attraction"]`,
    ];
    return [
      ...accessStatements,
      ...(includeDetails ? detailStatements : []),
    ].map((statement) => `${statement};`);
  });
  return `[out:json][timeout:25];(${statements.join("")});out tags center geom;`;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchOverpass(
  query: string,
  signal?: AbortSignal
): Promise<OsmElement[]> {
  let lastError: Error | null = null;
  const deadline = Date.now() + OVERPASS_TOTAL_TIMEOUT_MS;
  for (const retryDelay of OVERPASS_RETRY_DELAYS_MS) {
    if (Date.now() >= deadline) break;
    await abortableDelay(retryDelay, signal);
    for (const endpoint of OVERPASS_ENDPOINTS) {
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) break;
      const requestController = new AbortController();
      const forwardAbort = () => requestController.abort(signal?.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const requestTimeout = setTimeout(
        () => requestController.abort(createTimeoutError("Overpass API timeout")),
        Math.min(OVERPASS_REQUEST_TIMEOUT_MS, remainingMilliseconds)
      );
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Accept: "application/json",
            "User-Agent": "AstroSight/0.0.0",
          },
          body: new URLSearchParams({ data: query }),
          signal: requestController.signal,
        });
        if (!response.ok) {
          throw new Error(`Overpass APIエラー：${response.status}`);
        }
        const data = (await response.json()) as OverpassResponse;
        if (!Array.isArray(data.elements)) {
          throw new Error("Overpass APIの応答形式が不正です");
        }
        return data.elements.filter(isOsmElement);
      } catch (error) {
        if (signal?.aborted) {
          throw createAbortError();
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(requestTimeout);
        signal?.removeEventListener("abort", forwardAbort);
      }
    }
  }
  throw lastError ?? new Error(
    "OpenStreetMap地理データの取得が時間内に完了しませんでした"
  );
}

export async function lookupOsmSiteContexts(
  points: OsmContextRequestPoint[],
  signal?: AbortSignal,
  includeDetails = true,
  purpose: SiteContextPurpose = "full"
): Promise<OsmSiteContext[]> {
  if (points.length === 0 || points.length > 8) {
    throw new Error("一度に判定できる候補地点は1〜8点です");
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
      throw new Error("地理条件の判定座標が不正です");
    }
  }
  const elements = await fetchOverpass(queryForPoints(points, includeDetails, purpose), signal);
  return points.map((point) => {
    const structures = nearbyStructures(elements, point);
    const waterSurfaceKind = mappedWaterSurfaceKind(elements, point);
    return {
      walkingAccessible: elements.some((element) => isWalkable(element, point)) ||
        elements.some((element) => isOnOpenPublicLand(element, point)),
      onMappedWay: elements.some((element) => isOnMappedWay(element, point)),
      restrictedAccess: elements.some((element) => isRestricted(element, point)),
      onMotorRoad: elements.some((element) => isOnMotorRoad(element, point)),
      onWaterSurface: waterSurfaceKind !== "none",
      waterSurfaceKind,
      nearbyLandmarks: combinedLandmarks(elements, point, structures),
      nearbyBuildings: nearbyBuildings(elements, point),
      nearbyStructures: structures,
    };
  });
}
