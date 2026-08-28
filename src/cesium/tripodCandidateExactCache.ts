import type { CameraSettings, CalculationMode } from "../types/camera";
import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";

/**
 * Phase 1 exact-result cache: memory/session only.
 * Persistent reuse is intentionally NOT enabled yet because the current DEM/
 * weather APIs do not expose immutable source-version fingerprints. Keeping the
 * cache process-local prevents an old result surviving an app restart/data update.
 */
const CACHE_VERSION = "tripod-exact-session-20260829-v1";
const MAX_ENTRIES = 64;
const memory = new Map<string, TripodCandidate[]>();

function n(value: number | undefined): string {
  return value === undefined ? "u" : Number(value).toPrecision(17);
}

function weatherKey(context: RefractionWeatherContext | undefined): unknown {
  if (!context) return null;
  return {
    requestedMode: context.requestedMode,
    effectiveMode: context.effectiveMode,
    source: context.source,
    samples: context.samples.map((sample) => [
      sample.time,
      n(sample.temperatureCelsius),
      n(sample.relativeHumidityPercent),
      n(sample.surfacePressureHpa),
    ]),
    climatologyByMonthHour: context.climatologyByMonthHour ?? null,
  };
}

export type ExactTripodCacheInputs = {
  subject: GroundPoint;
  points: CelestialScreenPoint[];
  cameraSettings: CameraSettings;
  date: Date;
  calculationMode: CalculationMode;
  previewAspectRatio: number;
  refractionWeather?: RefractionWeatherContext;
  doubleCheckEnabled: boolean;
  initialDirectionObserver?: GroundPoint;
  accuracyMode: string;
  refractionMode: string;
};

export function exactTripodCacheKey(input: ExactTripodCacheInputs): string {
  return JSON.stringify({
    v: CACHE_VERSION,
    subject: [n(input.subject.latitude), n(input.subject.longitude), n(input.subject.height)],
    points: [...input.points]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((point) => [point.id, n(point.azimuthDegrees), n(point.altitudeDegrees), n(point.geometricAltitudeDegrees)]),
    camera: [n(input.cameraSettings.focalLengthMm), n(input.cameraSettings.lensCenterHeightMeters)],
    dateMs: input.date.getTime(),
    calculationMode: input.calculationMode,
    aspect: n(input.previewAspectRatio),
    weather: weatherKey(input.refractionWeather),
    doubleCheckEnabled: input.doubleCheckEnabled,
    observer: input.initialDirectionObserver
      ? [n(input.initialDirectionObserver.latitude), n(input.initialDirectionObserver.longitude), n(input.initialDirectionObserver.height)]
      : null,
    accuracyMode: input.accuracyMode,
    refractionMode: input.refractionMode,
  });
}

export function getExactTripodCandidates(key: string): TripodCandidate[] | null {
  const cached = memory.get(key);
  if (!cached) return null;
  memory.delete(key);
  memory.set(key, cached);
  return cached.map((candidate) => ({ ...candidate }));
}

export function setExactTripodCandidates(key: string, candidates: TripodCandidate[]): void {
  // Only validated final aligned results are cached. Empty/no-solution and
  // preliminary/direction-only states are never cached.
  if (candidates.length === 0 || candidates.some((candidate) => candidate.solutionType !== "aligned")) return;
  memory.delete(key);
  memory.set(key, candidates.map((candidate) => ({ ...candidate })));
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) break;
    memory.delete(oldest);
  }
}
