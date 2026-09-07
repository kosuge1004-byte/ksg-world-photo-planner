import type {
  SiteContext,
  SiteConstraintFlags,
} from "../types/geospatial";
import type { GroundPoint } from "../types/points";
import { diagnosticFetch } from "../network/networkDiagnostics";
import { shareInFlightRequest } from "../network/sharedRequests";

type SiteContextResponse = {
  contexts?: unknown;
  error?: unknown;
};

const SITE_CONTEXT_BATCH_SIZE = 8;

export type SiteContextPurpose = "full" | "height-only" | "water-only";

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
    "onWaterSurface" in value &&
    typeof value.onWaterSurface === "boolean" &&
    "waterSurfaceKind" in value &&
    (value.waterSurfaceKind === "none" ||
      value.waterSurfaceKind === "river" ||
      value.waterSurfaceKind === "sea-or-other-water") &&
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
  includeDetails = true,
  purpose: SiteContextPurpose = "full"
): Promise<SiteContext[]> {
  const requestBody = {
    points: points.map((point) => ({
      latitude: point.latitude,
      longitude: point.longitude,
    })),
    includeDetails,
    purpose,
  };
  const cacheKeyPoints = points.map((point) => ({
    latitude: Number(point.latitude.toFixed(5)),
    longitude: Number(point.longitude.toFixed(5)),
  }));
  const requestKey = `osm-site-context:${includeDetails ? "details" : "flags"}:${purpose}:${JSON.stringify(cacheKeyPoints)}`;
  const request = async () => {
    const response = await diagnosticFetch("osm-site-context", "/api/osm-site-context", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      data: (await response.json()) as SiteContextResponse,
    };
  };
  // water-only は三脚探索の時間制限付き補助判定で使う。共有要求にすると、
  // 呼出側のAbortSignalは「待機」だけを中止し基礎fetchが裏で残るため、
  // タイムアウト後も通信が競合する。water-onlyだけは共有せず、abortを
  // 実fetchへ直接伝播させる。full/height-onlyの既存共有挙動は維持する。
  const result = purpose === "water-only"
    ? await request()
    : await shareInFlightRequest({
        key: requestKey,
        category: "osm-site-context",
        signal,
        factory: request,
      });
  const { data } = result;
  const response = { ok: result.ok, status: result.status };
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
  includeDetails = true,
  purpose: SiteContextPurpose = "full"
): Promise<SiteContext[]> {
  if (points.length === 0) return [];
  // water-only はサーバー側で最大80地点を1回の軽量Overpass問い合わせへ
  // 集約できる。河川の最近傍陸地探索（10半径×8方向）を10回直列通信に
  // しないため、ここでは1リクエストで送る。
  if (purpose === "water-only") {
    return fetchSiteContextBatch(points, signal, false, purpose);
  }
  const contexts: SiteContext[] = [];
  // 従来用途はOverpass側の1要求上限を守りながら最大8地点ずつ照合する。
  for (let offset = 0; offset < points.length; offset += SITE_CONTEXT_BATCH_SIZE) {
    contexts.push(...await fetchSiteContextBatch(
      points.slice(offset, offset + SITE_CONTEXT_BATCH_SIZE),
      signal,
      includeDetails,
      purpose
    ));
  }
  return contexts;
}
