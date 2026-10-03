import type { CalculationMode } from "../types/camera";
import type { CelestialBodyId, CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { ellipsoidalHeightMeters, withLensCenterHeight } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeather";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import { calculateCelestialHorizontalCoordinates, findHorizonCrossing } from "./celestial";
import { buildPreliminaryTripodCandidates } from "./tripodCandidates";

const CROSSING_SEARCH_MARGIN_MS = 30 * 60 * 60 * 1_000;
const CROSSING_CURSOR_ADVANCE_MS = 60_000;
const DEFAULT_SAMPLE_MINUTES = 10;

export type RiseSetCandidateBodyId = Extract<CelestialBodyId, "sun" | "moon" | "milkyWay">;

const BODY_LABELS: Record<RiseSetCandidateBodyId, string> = {
  sun: "太陽",
  moon: "月",
  milkyWay: "天の川",
};

export type TripodCandidateRiseSetArc = {
  id: RiseSetCandidateBodyId;
  riseAt: Date;
  setAt: Date;
  points: TripodCandidate[];
};

type BuildTripodCandidateRiseSetArcInput = {
  id: RiseSetCandidateBodyId;
  subject: GroundPoint;
  dayStart: Date;
  dayEnd: Date;
  lensCenterHeightMeters: number;
  calculationMode: CalculationMode;
  maxDistanceMeters: number;
  refractionWeather?: RefractionWeatherContext;
  sampleMinutes?: number;
};

function findLastCrossing(
  id: RiseSetCandidateBodyId,
  direction: 1 | -1,
  observer: GroundPoint,
  start: Date,
  end: Date,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): Date | null {
  let lastCrossing: Date | null = null;
  let cursor = new Date(start);
  while (cursor < end) {
    const crossing = findHorizonCrossing(
      id, direction, observer, cursor, end, calculationMode, refractionWeather
    );
    if (!crossing) break;
    lastCrossing = crossing;
    cursor = new Date(crossing.getTime() + CROSSING_CURSOR_ADVANCE_MS);
  }
  return lastCrossing;
}

function celestialPoint(
  id: RiseSetCandidateBodyId,
  date: Date,
  observer: GroundPoint,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): CelestialScreenPoint {
  return {
    id,
    label: BODY_LABELS[id],
    ...calculateCelestialHorizontalCoordinates(id, date, observer, calculationMode, refractionWeather),
    xPercent: 50,
    yPercent: 50,
    inFront: true,
    visibleInFrame: false,
  };
}

/**
 * 選択日の出から入りまでの三脚候補軌跡を、太陽・月・天の川中心について作る。
 * 表示専用の案内線であり、三脚候補の確定や選択には使わない。
 * 地平線付近で理論交点が探索上限を越える部分は検索上限円周へ収める。
 */
export function buildTripodCandidateRiseSetArc({
  id,
  subject,
  dayStart,
  dayEnd,
  lensCenterHeightMeters,
  calculationMode,
  maxDistanceMeters,
  refractionWeather,
  sampleMinutes = DEFAULT_SAMPLE_MINUTES,
}: BuildTripodCandidateRiseSetArcInput): TripodCandidateRiseSetArc | null {
  if (
    Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime()) ||
    dayEnd <= dayStart || !Number.isFinite(maxDistanceMeters) || maxDistanceMeters <= 0
  ) return null;

  const label = BODY_LABELS[id];
  const observer = withLensCenterHeight(subject, lensCenterHeightMeters, `${label}三脚候補線の初期観測点`);
  const riseAt = findHorizonCrossing(
    id, 1, observer, dayStart, dayEnd, calculationMode, refractionWeather
  ) ?? findLastCrossing(
    id,
    1,
    observer,
    new Date(dayStart.getTime() - CROSSING_SEARCH_MARGIN_MS),
    dayStart,
    calculationMode,
    refractionWeather
  );
  if (!riseAt) return null;
  const setAt = findHorizonCrossing(
    id,
    -1,
    observer,
    new Date(riseAt.getTime() + CROSSING_CURSOR_ADVANCE_MS),
    new Date(riseAt.getTime() + CROSSING_SEARCH_MARGIN_MS),
    calculationMode,
    refractionWeather
  );
  if (!setAt) return null;

  const stepMs = Math.max(1, sampleMinutes) * 60_000;
  const firstSampleMs = Math.min(setAt.getTime(), riseAt.getTime() + CROSSING_CURSOR_ADVANCE_MS);
  const lastSampleMs = Math.max(firstSampleMs, setAt.getTime() - CROSSING_CURSOR_ADVANCE_MS);
  const sampleTimes: number[] = [];
  for (let time = firstSampleMs; time <= lastSampleMs; time += stepMs) sampleTimes.push(time);
  if (sampleTimes.at(-1) !== lastSampleMs) sampleTimes.push(lastSampleMs);

  const points = sampleTimes.flatMap((time): TripodCandidate[] => {
    const point = celestialPoint(id, new Date(time), observer, calculationMode, refractionWeather);
    if (point.altitudeDegrees <= 0) return [];
    const [preliminary] = buildPreliminaryTripodCandidates(
      subject, [point], lensCenterHeightMeters, observer
    );
    if (preliminary && preliminary.distanceMeters <= maxDistanceMeters) return [preliminary];

    const destination = calculateKarneyDestinationPoint(
      subject, (point.azimuthDegrees + 180) % 360, maxDistanceMeters
    );
    return [{
      id,
      label,
      latitude: destination.latitude,
      longitude: destination.longitude,
      height: ellipsoidalHeightMeters(subject),
      distanceMeters: maxDistanceMeters,
      solutionType: "preliminary",
    }];
  });

  return points.length >= 2 ? { id, riseAt, setAt, points } : null;
}
