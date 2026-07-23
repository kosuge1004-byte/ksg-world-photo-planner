import type {
  SiteContext,
  SiteConstraintFlags,
} from "../types/geospatial";
import type { GroundPoint } from "../types/points";

type SiteContextResponse = {
  contexts?: unknown;
  error?: unknown;
};

const SITE_CONTEXT_BATCH_SIZE = 8;

function isSiteContext(value: unknown): value is SiteContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "walkingAccessible" in value &&
    typeof value.walkingAccessible === "boolean" &&
    "onMappedWay" in value &&
    typeof value.onMappedWay === "boolean" &&
    "restrictedAccess" in value &&
    typeof value.restrictedAccess === "boolean" &&
    "onMotorRoad" in value &&
    typeof value.onMotorRoad === "boolean" &&
    "nearbyLandmarks" in value &&
    Array.isArray(value.nearbyLandmarks) &&
    "nearbyBuildings" in value &&
    Array.isArray(value.nearbyBuildings) &&
    "nearbyStructures" in value &&
    Array.isArray(value.nearbyStructures)
  );
}

export function hasMappedSiteConstraints(flags: SiteConstraintFlags): boolean {
  return flags.walkingOnly || flags.roadsAndPathsOnly ||
    flags.excludePrivateAccess || flags.excludeRoads;
}

export function passesMappedSiteConstraints(
  context: SiteContext,
  flags: SiteConstraintFlags
): boolean {
  if (flags.walkingOnly && !context.walkingAccessible) return false;
  if (flags.roadsAndPathsOnly && !context.onMappedWay) return false;
  if (flags.excludePrivateAccess && context.restrictedAccess) return false;
  if (flags.excludeRoads && context.onMotorRoad) return false;
  return true;
}

async function fetchSiteContextBatch(
  points: GroundPoint[],
  signal?: AbortSignal,
  includeDetails = true
): Promise<SiteContext[]> {
  const response = await fetch("/api/osm-site-context", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      points: points.map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
      })),
      includeDetails,
    }),
    signal,
  });
  const data = (await response.json()) as SiteContextResponse;
  if (!response.ok || !Array.isArray(data.contexts)) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `地理条件APIエラー：${response.status}`
    );
  }
  if (data.contexts.length !== points.length || !data.contexts.every(isSiteContext)) {
    throw new Error("地理条件APIの応答地点が一致しません");
  }
  return data.contexts;
}

export async function fetchSiteContexts(
  points: GroundPoint[],
  signal?: AbortSignal,
  includeDetails = true
): Promise<SiteContext[]> {
  if (points.length === 0) return [];
  const contexts: SiteContext[] = [];
  // Overpass側の1要求上限を守りながら、結果確定後に最大8地点ずつまとめて照合する。
  for (let offset = 0; offset < points.length; offset += SITE_CONTEXT_BATCH_SIZE) {
    contexts.push(...await fetchSiteContextBatch(
      points.slice(offset, offset + SITE_CONTEXT_BATCH_SIZE),
      signal,
      includeDetails
    ));
  }
  return contexts;
}
