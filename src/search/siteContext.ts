import type {
  SiteContext,
  SiteConstraintFlags,
} from "../types/geospatial";
import type { GroundPoint } from "../types/points";
import { diagnosticFetch } from "../network/networkDiagnostics";
import { shareInFlightRequest } from "../network/sharedRequests";
import { readPersistentSiteContexts, writePersistentSiteContexts } from "../cache/siteContextPersistentCache";
import { withAbortableTimeout } from "../utils/abortableSemaphore";

export type SiteContextPoint = Pick<GroundPoint, "latitude" | "longitude">;

type SiteContextResponse = {
  contexts?: unknown;
  error?: unknown;
};

const SITE_CONTEXT_BATCH_SIZE = 8;
// The Pages function may use its full 15-second Overpass fallback budget.
// Let one server request finish instead of aborting it at diagnosticFetch's
// general 8-second deadline and starting duplicate Overpass work.
const WATER_ONLY_FETCH_ATTEMPT_TIMEOUT_MS = 18_000;

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
  points: SiteContextPoint[],
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
  const request = () => withAbortableTimeout(async (requestSignal) => {
    const response = await diagnosticFetch("osm-site-context", "/api/osm-site-context", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: requestSignal,
    }, purpose === "water-only" ? WATER_ONLY_FETCH_ATTEMPT_TIMEOUT_MS : undefined);
    return {
      ok: response.ok,
      status: response.status,
      data: (await response.json()) as SiteContextResponse,
    };
  }, purpose === "water-only" ? 20_000 : 60_000,
  purpose === "water-only" ? "水面情報の取得がタイムアウトしました" : "周辺情報の取得がタイムアウトしました",
  signal);
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

async function fetchWaterContextBatchResilient(
  points: SiteContextPoint[],
  signal?: AbortSignal
): Promise<SiteContext[]> {
  try {
    const contexts = await fetchSiteContextBatch(points, signal, false, "water-only");
    // Save every successful unit before continuing. If a later sibling fails,
    // the retry can reuse this work instead of restarting the entire spot.
    await writePersistentSiteContexts(points, contexts, "water-only", false);
    return contexts;
  } catch (error) {
    // A user cancellation must stop immediately rather than creating retries.
    if (signal?.aborted) throw error;
    if (points.length <= 1) throw error;
    const middle = Math.ceil(points.length / 2);
    const left = await fetchWaterContextBatchResilient(points.slice(0, middle), signal);
    const right = await fetchWaterContextBatchResilient(points.slice(middle), signal);
    return [...left, ...right];
  }
}

export async function fetchSiteContexts(
  points: SiteContextPoint[],
  signal?: AbortSignal,
  includeDetails = true,
  purpose: SiteContextPurpose = "full"
): Promise<SiteContext[]> {
  if (points.length === 0) return [];
  // 2026-09-08: 端末永続キャッシュを最優先。ダウンロード済み地点や過去に
  // 照合した地点はOverpassへ再問い合わせせず、その場で返す。
  const cached = await readPersistentSiteContexts(points, purpose, includeDetails);
  if (cached.every((value) => value !== null)) return cached as SiteContext[];
  const missingIndexes = cached.map((value, index) => value === null ? index : -1).filter((index) => index >= 0);
  const missingPoints = missingIndexes.map((index) => points[index]);
  let fetched: SiteContext[];
  // water-only はサーバー側で最大500地点を1回の軽量Overpass問い合わせへ
  // 集約できる。河川の最近傍陸地探索（10半径×8方向）を10回直列通信に
  // しないため、ここでは1リクエストで送る。
  if (purpose === "water-only") {
    fetched = [];
    for (let offset = 0; offset < missingPoints.length; offset += 500) {
      fetched.push(...await fetchWaterContextBatchResilient(missingPoints.slice(offset, offset + 500), signal));
    }
  } else {
    fetched = [];
    // 従来用途はOverpass側の1要求上限を守りながら最大8地点ずつ照合する。
    for (let offset = 0; offset < missingPoints.length; offset += SITE_CONTEXT_BATCH_SIZE) {
      fetched.push(...await fetchSiteContextBatch(
        missingPoints.slice(offset, offset + SITE_CONTEXT_BATCH_SIZE), signal, includeDetails, purpose
      ));
    }
  }
  // Water chunks are persisted as soon as each direct or split request succeeds.
  // Other purposes retain their existing one-write behavior.
  if (purpose !== "water-only") {
    await writePersistentSiteContexts(missingPoints, fetched, purpose, includeDetails);
  }
  const result = [...cached] as Array<SiteContext | null>;
  missingIndexes.forEach((originalIndex, fetchedIndex) => { result[originalIndex] = fetched[fetchedIndex]; });
  return result as SiteContext[];
}
