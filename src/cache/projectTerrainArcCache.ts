import type { CalculationMode } from "../types/camera";
import type { GroundPoint } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeather";
import type {
  RiseSetCandidateBodyId,
  TripodCandidateRiseSetArc,
  TripodCandidateRiseSetArcPoint,
} from "../cesium/tripodCandidateRiseSetArc";
import { DEVICE_CACHE_POLICIES } from "./cachePolicies";
import { deleteDeviceCache, getDeviceCache, setDeviceCache } from "./deviceCache";

const SNAPSHOT_VERSION = 1;
const BODY_IDS = new Set<RiseSetCandidateBodyId>(["sun", "moon", "milkyWay"]);

export type ProjectTerrainArcContextInput = {
  subject: GroundPoint;
  dayStart: Date;
  dayEnd: Date;
  lensCenterHeightMeters: number;
  calculationMode: CalculationMode;
  maxDistanceMeters: number;
  refractionWeather?: RefractionWeatherContext;
  revision: string;
  passKey: string;
};

type StoredTerrainArc = {
  id: RiseSetCandidateBodyId;
  riseAtMilliseconds: number;
  setAtMilliseconds: number;
  segments: TripodCandidateRiseSetArcPoint[][];
};

export type ProjectTerrainArcSnapshot = {
  version: typeof SNAPSHOT_VERSION;
  contextKey: string;
  savedAtIso: string;
  arcs: StoredTerrainArc[];
};

/**
 * 確定線の計算条件。完全一致した場合だけ復元する。
 * 被写体は緯度経度だけでなく高さ基準も含める。
 */
export function projectTerrainArcContextKey(input: ProjectTerrainArcContextInput): string {
  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    subject: [
      input.subject.latitude,
      input.subject.longitude,
      input.subject.height,
      input.subject.ellipsoidalHeightMeters ?? null,
      input.subject.orthometricHeightMeters ?? null,
      input.subject.geoidHeightMeters ?? null,
      input.subject.subjectSurfaceTarget ?? null,
      input.subject.structureHeightMeters ?? null,
    ],
    day: [input.dayStart.getTime(), input.dayEnd.getTime()],
    lensCenterHeightMeters: input.lensCenterHeightMeters,
    calculationMode: input.calculationMode,
    maxDistanceMeters: input.maxDistanceMeters,
    refractionWeather: input.refractionWeather ?? null,
    revision: input.revision,
    passKey: input.passKey,
  });
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPoint(value: unknown, id: RiseSetCandidateBodyId): value is TripodCandidateRiseSetArcPoint {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Partial<TripodCandidateRiseSetArcPoint>;
  if (
    point.id !== id ||
    typeof point.label !== "string" ||
    !finite(point.latitude) || point.latitude < -90 || point.latitude > 90 ||
    !finite(point.longitude) || point.longitude < -180 || point.longitude > 180 ||
    !finite(point.height) ||
    !finite(point.distanceMeters) || point.distanceMeters < 0 ||
    !finite(point.timestampMilliseconds)
  ) return false;
  if (point.solutionType !== undefined &&
    point.solutionType !== "aligned" &&
    point.solutionType !== "direction-only" &&
    point.solutionType !== "preliminary") return false;
  if (point.lineOfSightPossiblyObstructed !== undefined &&
    typeof point.lineOfSightPossiblyObstructed !== "boolean") return false;
  if (point.obstructionDistanceMeters !== undefined &&
    (!finite(point.obstructionDistanceMeters) || point.obstructionDistanceMeters < 0)) return false;
  return true;
}

function validSnapshot(value: unknown): value is ProjectTerrainArcSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<ProjectTerrainArcSnapshot>;
  if (
    snapshot.version !== SNAPSHOT_VERSION ||
    typeof snapshot.contextKey !== "string" || snapshot.contextKey.length === 0 ||
    typeof snapshot.savedAtIso !== "string" || Number.isNaN(Date.parse(snapshot.savedAtIso)) ||
    !Array.isArray(snapshot.arcs) || snapshot.arcs.length === 0 || snapshot.arcs.length > 3
  ) return false;
  const seen = new Set<RiseSetCandidateBodyId>();
  for (const valueArc of snapshot.arcs) {
    if (typeof valueArc !== "object" || valueArc === null) return false;
    const arc = valueArc as Partial<StoredTerrainArc>;
    if (!BODY_IDS.has(arc.id as RiseSetCandidateBodyId) || seen.has(arc.id as RiseSetCandidateBodyId)) return false;
    const id = arc.id as RiseSetCandidateBodyId;
    seen.add(id);
    if (!finite(arc.riseAtMilliseconds) || !finite(arc.setAtMilliseconds) ||
      arc.setAtMilliseconds <= arc.riseAtMilliseconds ||
      !Array.isArray(arc.segments) || arc.segments.length === 0 ||
      arc.segments.some((segment) => !Array.isArray(segment) || segment.some((point) => !validPoint(point, id)))) {
      return false;
    }
    if (!arc.segments.some((segment) => segment.length > 0)) return false;
  }
  return true;
}

export function createProjectTerrainArcSnapshot(
  contextKey: string,
  arcs: readonly TripodCandidateRiseSetArc[]
): ProjectTerrainArcSnapshot | null {
  const stored = arcs.flatMap((arc): StoredTerrainArc[] => {
    if (arc.kind !== "terrain" || !BODY_IDS.has(arc.id)) return [];
    const segments = (arc.segments ?? [arc.points]).map((segment) =>
      segment.map((point) => ({ ...point }))
    );
    if (!segments.some((segment) => segment.length > 0)) return [];
    return [{
      id: arc.id,
      riseAtMilliseconds: arc.riseAt.getTime(),
      setAtMilliseconds: arc.setAt.getTime(),
      segments,
    }];
  });
  if (stored.length === 0) return null;
  return {
    version: SNAPSHOT_VERSION,
    contextKey,
    savedAtIso: new Date().toISOString(),
    arcs: stored,
  };
}

export function restoreProjectTerrainArcs(
  snapshot: ProjectTerrainArcSnapshot | null,
  expectedContextKey: string
): TripodCandidateRiseSetArc[] {
  if (!snapshot || !validSnapshot(snapshot) || snapshot.contextKey !== expectedContextKey) return [];
  return snapshot.arcs.map((arc) => {
    const segments = arc.segments.map((segment) => segment.map((point) => ({ ...point })));
    return {
      id: arc.id,
      riseAt: new Date(arc.riseAtMilliseconds),
      setAt: new Date(arc.setAtMilliseconds),
      points: segments.flat(),
      segments,
      kind: "terrain" as const,
    };
  });
}

export async function loadProjectTerrainArcSnapshot(
  projectId: string
): Promise<ProjectTerrainArcSnapshot | null> {
  const value = await getDeviceCache<unknown>(DEVICE_CACHE_POLICIES.projectTerrainArc, projectId);
  return validSnapshot(value) ? value : null;
}

export async function saveProjectTerrainArcSnapshot(
  projectId: string,
  snapshot: ProjectTerrainArcSnapshot
): Promise<void> {
  if (!validSnapshot(snapshot)) return;
  await setDeviceCache(DEVICE_CACHE_POLICIES.projectTerrainArc, projectId, snapshot);
}

export async function deleteProjectTerrainArcSnapshot(projectId: string): Promise<void> {
  await deleteDeviceCache(DEVICE_CACHE_POLICIES.projectTerrainArc, projectId);
}
