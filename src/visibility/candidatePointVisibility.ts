import type {
  RiseSetCandidateBodyId,
  TripodCandidateRiseSetArc,
  TripodCandidateRiseSetArcPoint,
} from "../cesium/tripodCandidateRiseSetArc";
import { orthometricHeightMeters, type GroundPoint } from "../types/points";
import {
  CANDIDATE_POINT_VISIBILITY_MAX_POINTS,
  isCandidatePointVisibilityResponse,
  type CandidatePointVisibilityRequest,
  type CandidatePointVisibilityRequestPoint,
} from "../types/candidatePointVisibility";
import { diagnosticFetch } from "../network/networkDiagnostics";

export type CandidatePointVisibilityPoint = TripodCandidateRiseSetArcPoint & {
  visibilityKey: string;
};

export type CandidatePointVisibilityProgress = {
  completed: number;
  total: number;
};

export type CandidatePointVisibilityResult = {
  points: CandidatePointVisibilityPoint[];
  terrainBlockedCount: number;
  buildingBlockedCount: number;
  buildingUnverifiedCount: number;
  exactTerrainAvailable: boolean;
};

function visibilityKey(
  id: RiseSetCandidateBodyId,
  timestampMilliseconds: number
): string {
  return `${id}:${timestampMilliseconds}`;
}

function chunks<T>(values: readonly T[], maximum: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += maximum) {
    result.push(values.slice(index, index + maximum));
  }
  return result;
}

async function requestBuildingVisibility(
  request: CandidatePointVisibilityRequest,
  signal?: AbortSignal
) {
  // Capacitor版では相対 /api が https://localhost を指すため、必ず共通入口を
  // 通して公開Pages APIへ解決する。PLATEAUの初回ファイル読込みを考慮し、
  // 通常APIより長い上限を使うが、無限待ちにはしない。
  const response = await diagnosticFetch("candidate-point-visibility", "/api/candidate-point-visibility", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    signal,
  }, 45_000, 2);
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const value: unknown = await response.json();
  const expectedKeys = new Set(request.points.map((point) => point.key));
  return isCandidatePointVisibilityResponse(value, expectedKeys) ? value : null;
}

/**
 * 赤い三脚候補線の「正確な地形交点」だけを入力にし、同一視線上のDEM遮蔽と
 * PLATEAU建物遮蔽を統合する。平坦地仮定の代替線は結果へ混ぜない。
 */
export async function searchCandidatePointVisibility(input: {
  subject: GroundPoint;
  lensCenterHeightMeters: number;
  arcs: readonly TripodCandidateRiseSetArc[];
  signal?: AbortSignal;
  onProgress?: (progress: CandidatePointVisibilityProgress) => void;
}): Promise<CandidatePointVisibilityResult> {
  const terrainArcs = input.arcs.filter((arc) => arc.kind === "terrain");
  const pointsByKey = new Map<string, TripodCandidateRiseSetArcPoint>();
  let terrainBlockedCount = 0;
  for (const arc of terrainArcs) for (const point of arc.points) {
    const key = visibilityKey(arc.id, point.timestampMilliseconds);
    if (point.lineOfSightPossiblyObstructed === true) {
      terrainBlockedCount += 1;
      continue;
    }
    // 地形遮蔽の明示判定を持つ頂点だけを採用する。undefinedは平坦地仮定・
    // 旧キャッシュなど判定不能な点なので「見通せる点」として表示しない。
    if (point.lineOfSightPossiblyObstructed !== false) continue;
    pointsByKey.set(key, point);
  }

  const candidates = [...pointsByKey.entries()].map(([key, point]) => ({ key, point }));
  input.onProgress?.({ completed: 0, total: candidates.length });
  if (candidates.length === 0) {
    return {
      points: [],
      terrainBlockedCount,
      buildingBlockedCount: 0,
      buildingUnverifiedCount: 0,
      exactTerrainAvailable: terrainArcs.length > 0,
    };
  }

  const responseByKey = new Map<string, "clear" | "blocked" | "unverified">();
  let completed = 0;
  for (const batch of chunks(candidates, CANDIDATE_POINT_VISIBILITY_MAX_POINTS)) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const requestPoints: CandidatePointVisibilityRequestPoint[] = batch.map(({ key, point }) => ({
      key,
      celestialId: point.id as RiseSetCandidateBodyId,
      timestampMilliseconds: point.timestampMilliseconds,
      latitude: point.latitude,
      longitude: point.longitude,
    }));
    const response = await requestBuildingVisibility({
      subject: {
        latitude: input.subject.latitude,
        longitude: input.subject.longitude,
        orthometricHeightMeters: orthometricHeightMeters(input.subject),
        ...(input.subject.plateauBuildingRef
          ? { plateauBuildingRef: input.subject.plateauBuildingRef }
          : {}),
      },
      lensCenterHeightMeters: input.lensCenterHeightMeters,
      points: requestPoints,
    }, input.signal).catch((error: unknown) => {
      if (input.signal?.aborted) throw error;
      return null;
    });
    for (const point of requestPoints) responseByKey.set(point.key, "unverified");
    for (const result of response?.results ?? []) responseByKey.set(result.key, result.status);
    completed += batch.length;
    input.onProgress?.({ completed, total: candidates.length });
  }

  let buildingBlockedCount = 0;
  let buildingUnverifiedCount = 0;
  const points: CandidatePointVisibilityPoint[] = [];
  for (const { key, point } of candidates) {
    const status = responseByKey.get(key) ?? "unverified";
    if (status === "blocked") {
      buildingBlockedCount += 1;
      continue;
    }
    // PLATEAU未確認を「見通せる」とは扱わない。黄色の暫定点は表示せず、
    // 地形・建物の両方でclearになった点だけを緑の確定点として返す。
    if (status === "unverified") {
      buildingUnverifiedCount += 1;
      continue;
    }
    points.push({
      ...point,
      visibilityKey: key,
    });
  }
  return {
    points,
    terrainBlockedCount,
    buildingBlockedCount,
    buildingUnverifiedCount,
    exactTerrainAvailable: true,
  };
}
