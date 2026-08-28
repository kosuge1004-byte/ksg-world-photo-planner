import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { getDeviceCacheMany, setDeviceCacheMany, type DeviceCachePolicy } from "../cache/deviceCache";

/**
 * Persistent *hint* cache only. These values are never accepted as final answers.
 * A miss or stale/wrong hint simply falls back to the existing full DEM search.
 */
const POLICY: DeviceCachePolicy = {
  namespace: "tripod-candidate-seed-v1",
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 512,
  memoryEntries: 128,
};
const SEED_VERSION = "tripod-seed-20260829-v1";

export type PersistentTripodSeed = {
  distanceMeters: number;
  latitude: number;
  longitude: number;
  height: number;
  savedAt: number;
};

function bucket(value: number, step: number): string {
  return String(Math.round(value / step));
}

function keyFor(subject: GroundPoint, point: CelestialScreenPoint): string {
  // Subject ~11 m, azimuth 0.5°, altitude 0.5°. This is deliberately only a
  // relevance bucket; the seed is never trusted as a result and the solver's
  // full-scan fallback remains authoritative.
  return [
    SEED_VERSION,
    bucket(subject.latitude, 0.0001),
    bucket(subject.longitude, 0.0001),
    point.id,
    bucket(point.azimuthDegrees, 0.5),
    bucket(point.geometricAltitudeDegrees ?? point.altitudeDegrees, 0.5),
  ].join("|");
}

export async function loadPersistentTripodSeeds(
  subject: GroundPoint,
  points: CelestialScreenPoint[]
): Promise<Partial<Record<CelestialScreenPoint["id"], PersistentTripodSeed>>> {
  const keys = points.map((point) => keyFor(subject, point));
  const seeds = await getDeviceCacheMany<PersistentTripodSeed>(POLICY, keys);
  const entries = points.map((point, index) => {
    const seed = seeds[index];
    if (!seed || !Number.isFinite(seed.distanceMeters) || seed.distanceMeters <= 0) return null;
    return [point.id, seed] as const;
  });
  return Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}

export async function savePersistentTripodSeeds(
  subject: GroundPoint,
  points: CelestialScreenPoint[],
  candidates: TripodCandidate[]
): Promise<void> {
  const byId = new Map<CelestialScreenPoint["id"], TripodCandidate>();
  for (const candidate of candidates) {
    if (candidate.solutionType !== "aligned") continue;
    const current = byId.get(candidate.id);
    if (!current || candidate.distanceMeters > current.distanceMeters) byId.set(candidate.id, candidate);
  }
  const savedAt = Date.now();
  const entries = points.flatMap((point) => {
    const candidate = byId.get(point.id);
    if (!candidate) return [];
    return [{
      key: keyFor(subject, point),
      value: {
        distanceMeters: candidate.distanceMeters,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        height: candidate.height,
        savedAt,
      } satisfies PersistentTripodSeed,
    }];
  });
  await setDeviceCacheMany<PersistentTripodSeed>(POLICY, entries);
}
