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
  // 2026-08-29追記（V11〜V20の精度関連変更を網羅的に検査した結果判明）:
  // 永続seedキャッシュ・現セッション確定候補由来の「距離ヒント」
  // （calculateTripodCandidates()のsearchProfile.preferredDistanceMeters
  // へ渡る値）は、実際に最終確定候補の選択へ影響する（同じ被写体・同じ
  // 日時・同じカメラ設定でも、ヒント値が異なれば異なる交点が確定
  // しうることを本レポートの一連の調査で確認済み）。以前はこの値が
  // 完全一致キャッシュ・重複探索抑止のキーに含まれておらず、ヒント値
  // だけが異なる2回の呼び出しを「同一」と誤認し、古い（別ヒント下での）
  // 結果を誤って再利用しうる欠落があったため、キーへ追加する。
  preferredDistancesById?: Partial<Record<string, number>>;
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
    preferredDistances: input.preferredDistancesById
      ? Object.entries(input.preferredDistancesById)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, distance]) => [id, n(distance)])
      : null,
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
