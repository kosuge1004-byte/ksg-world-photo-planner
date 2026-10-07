import { Cartesian3, Ellipsoid } from "cesium";

import type { CalculationMode } from "../types/camera";
import type { CelestialBodyId, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { withLensCenterHeight } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeather";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import { calculateCelestialHorizontalCoordinates, findHorizonCrossing } from "./celestial";
import {
  buildCelestialBackwardRay,
  rayCartographicAtDistance,
  sightlineDistanceToEllipsoidalHeightMeters,
} from "./tripodCandidates";

const CROSSING_SEARCH_MARGIN_MS = 30 * 60 * 60 * 1_000;
const CROSSING_CURSOR_ADVANCE_MS = 60_000;
const DEFAULT_SAMPLE_MINUTES = 10;
const MINIMUM_ALTITUDE_DEGREES = 0.25;
const RADIANS_TO_DEGREES = 180 / Math.PI;

// 確定候補が「現在時刻の視線レイ上にある」とみなす許容差。
// これを超える候補（方位だけ合わせた確認地点、時刻ドラッグ中の再投影など）は
// 線へ頂点として挿入しない。挿入すると線がその1点だけ折れ曲がる。
const ON_RAY_HEIGHT_TOLERANCE_METERS = 30;
const ON_RAY_LATERAL_TOLERANCE_METERS = 25;
const ON_RAY_LATERAL_TOLERANCE_RATIO = 0.02;
const SAME_SAMPLE_WINDOW_MS = 60_000;

export type RiseSetCandidateBodyId = Extract<CelestialBodyId, "sun" | "moon" | "milkyWay">;

const BODY_LABELS: Record<RiseSetCandidateBodyId, string> = {
  sun: "太陽",
  moon: "月",
  milkyWay: "天の川",
};

type RiseSetArcSample = {
  timestampMilliseconds: number;
  azimuthDegrees: number;
  /** レイ方向に使う高度。精密探索と同じく幾何高度を優先する。 */
  rayAltitudeDegrees: number;
};

/** 線の全頂点を同じ高さ基準で並べ直すための再計算用データ。 */
type RiseSetArcModel = {
  subject: GroundPoint;
  observer: GroundPoint;
  lensCenterHeightMeters: number;
  maxDistanceMeters: number;
  calculationMode: CalculationMode;
  refractionWeather?: RefractionWeatherContext;
  samples: RiseSetArcSample[];
};

export type TripodCandidateRiseSetArc = {
  id: RiseSetCandidateBodyId;
  riseAt: Date;
  setAt: Date;
  points: TripodCandidateRiseSetArcPoint[];
  /** buildTripodCandidateRiseSetArc() が作った線だけが持つ。 */
  model?: RiseSetArcModel;
};

export type TripodCandidateRiseSetArcPoint = TripodCandidate & {
  timestampMilliseconds: number;
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
  /**
   * 三脚を立てる地表の楕円体高(m)の目安。確定候補がまだ無い間の線の高さ基準。
   * 優先順に並べた候補を渡す。先頭から試し、実際の交点が2点以上できる最初の高さを使う
   * （例: 被写体直下の地表 → 三脚ピンの地表 → 標高0m）。
   * 山頂のように被写体ピンが地表にある場合、被写体直下の地表では交点ができないので
   * 次の候補へ進む。未指定時はWGS84楕円体面(0m)。
   */
  referenceGroundEllipsoidalHeightMeters?: number | readonly number[];
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

function sampleAt(
  id: RiseSetCandidateBodyId,
  timestampMilliseconds: number,
  model: Pick<RiseSetArcModel, "observer" | "calculationMode" | "refractionWeather">
): RiseSetArcSample | null {
  const horizontal = calculateCelestialHorizontalCoordinates(
    id,
    new Date(timestampMilliseconds),
    model.observer,
    model.calculationMode,
    model.refractionWeather
  );
  if (
    !Number.isFinite(horizontal.altitudeDegrees) ||
    !Number.isFinite(horizontal.azimuthDegrees) ||
    horizontal.altitudeDegrees <= 0
  ) return null;
  const geometric = (horizontal as { geometricAltitudeDegrees?: number }).geometricAltitudeDegrees;
  return {
    timestampMilliseconds,
    azimuthDegrees: horizontal.azimuthDegrees,
    rayAltitudeDegrees:
      horizontal.altitudeDegrees > MINIMUM_ALTITUDE_DEGREES && Number.isFinite(geometric)
        ? (geometric as number)
        : horizontal.altitudeDegrees > MINIMUM_ALTITUDE_DEGREES
          ? horizontal.altitudeDegrees
          : Number.NaN,
  };
}

/**
 * 全サンプルを「レンズ中心がこの楕円体高にある」という1つの高さ基準で並べる。
 * 頂点ごとに高さ基準が混ざらないので、線は時刻順に滑らかに続く。
 */
function layoutArcPoints(
  id: RiseSetCandidateBodyId,
  model: RiseSetArcModel,
  lensSurfaceEllipsoidalHeightMeters: number
): TripodCandidateRiseSetArcPoint[] {
  const label = BODY_LABELS[id];
  const groundHeight = lensSurfaceEllipsoidalHeightMeters - model.lensCenterHeightMeters;
  return model.samples.flatMap((sample): TripodCandidateRiseSetArcPoint[] => {
    const ray = Number.isFinite(sample.rayAltitudeDegrees) && sample.rayAltitudeDegrees > 0
      ? buildCelestialBackwardRay(
          model.subject, sample.azimuthDegrees, sample.rayAltitudeDegrees, model.observer
        )
      : null;
    const distanceMeters = ray
      ? sightlineDistanceToEllipsoidalHeightMeters(ray, lensSurfaceEllipsoidalHeightMeters)
      : null;
    if (ray && distanceMeters !== null && distanceMeters <= model.maxDistanceMeters) {
      const cartographic = rayCartographicAtDistance(ray, distanceMeters);
      if (cartographic) {
        return [{
          id,
          label,
          latitude: cartographic.latitude * RADIANS_TO_DEGREES,
          longitude: cartographic.longitude * RADIANS_TO_DEGREES,
          height: groundHeight,
          distanceMeters,
          solutionType: "preliminary",
          timestampMilliseconds: sample.timestampMilliseconds,
        }];
      }
    }
    // 2026-10-08修正: 視線が基準の高さまで降りてこない（被写体ピンがレンズの高さ以下にある）
    // 場合、その時刻に三脚候補は存在しない。以前はこれも検索上限の円周へ置いていたため、
    // 基準の高さが被写体ピンより高いと全時刻が円周に並び、被写体を囲む大きな円弧が
    // 描かれていた。存在しない候補は線に含めない。
    if (ray && distanceMeters === null) return [];
    // 地平線付近で交点が探索上限を越える部分だけ、検索上限円周へ収める。
    const destination = calculateKarneyDestinationPoint(
      model.subject, (sample.azimuthDegrees + 180) % 360, model.maxDistanceMeters
    );
    return [{
      id,
      label,
      latitude: destination.latitude,
      longitude: destination.longitude,
      height: groundHeight,
      distanceMeters: model.maxDistanceMeters,
      solutionType: "preliminary",
      timestampMilliseconds: sample.timestampMilliseconds,
    }];
  });
}

/** 検索上限の円周へ寄せた点ではない、実際の交点の数。 */
function realPointCount(points: readonly TripodCandidateRiseSetArcPoint[], maxDistanceMeters: number): number {
  return points.filter((point) => point.distanceMeters < maxDistanceMeters).length;
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
  referenceGroundEllipsoidalHeightMeters,
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

  const modelBase = { observer, calculationMode, refractionWeather };
  const samples = sampleTimes.flatMap((time) => {
    const sample = sampleAt(id, time, modelBase);
    return sample ? [sample] : [];
  });
  if (samples.length < 2) return null;

  const model: RiseSetArcModel = {
    ...modelBase,
    subject,
    lensCenterHeightMeters,
    maxDistanceMeters,
    samples,
  };
  const references = (Array.isArray(referenceGroundEllipsoidalHeightMeters)
    ? referenceGroundEllipsoidalHeightMeters
    : [referenceGroundEllipsoidalHeightMeters]
  ).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (references.length === 0) references.push(0);
  let points: TripodCandidateRiseSetArcPoint[] = [];
  for (const referenceGround of references) {
    points = layoutArcPoints(id, model, referenceGround + lensCenterHeightMeters);
    if (realPointCount(points, maxDistanceMeters) >= 2) break;
  }
  // どの高さ基準でも実際の交点ができない場合、案内線は描かない
  // （検索上限の円周だけを線として見せない）。
  if (realPointCount(points, maxDistanceMeters) < 2) return null;
  return { id, riseAt, setAt, points, model };
}

/**
 * 確定候補のレンズ位置が現在時刻の視線レイ上にあるかを調べ、あればその地点での
 * レイの楕円体高（＝線全体に使う高さ基準）を返す。
 */
function lensSurfaceFromConfirmedCandidate(
  arc: TripodCandidateRiseSetArc,
  model: RiseSetArcModel,
  candidate: TripodCandidate,
  timestampMilliseconds: number
): { heightMeters: number; onRay: boolean } {
  const nominal = candidate.height + model.lensCenterHeightMeters;
  const fallback = { heightMeters: nominal, onRay: false };
  if (candidate.solutionType === "direction-only") return fallback;
  const sample = sampleAt(arc.id, timestampMilliseconds, model);
  if (!sample || !Number.isFinite(sample.rayAltitudeDegrees) || sample.rayAltitudeDegrees <= 0) {
    return fallback;
  }
  const ray = buildCelestialBackwardRay(
    model.subject, sample.azimuthDegrees, sample.rayAltitudeDegrees, model.observer
  );
  if (!ray) return fallback;
  const lens = Cartesian3.fromDegrees(
    candidate.longitude, candidate.latitude, nominal, Ellipsoid.WGS84
  );
  const alongRay = Cartesian3.dot(
    Cartesian3.subtract(lens, ray.origin, new Cartesian3()),
    ray.direction
  );
  if (!(alongRay > 0)) return fallback;
  const onRayPosition = Cartesian3.add(
    ray.origin,
    Cartesian3.multiplyByScalar(ray.direction, alongRay, new Cartesian3()),
    new Cartesian3()
  );
  const cartographic = Ellipsoid.WGS84.cartesianToCartographic(onRayPosition);
  if (!cartographic) return fallback;
  const offRay = Cartesian3.distance(onRayPosition, lens);
  const lateralTolerance = Math.max(
    ON_RAY_LATERAL_TOLERANCE_METERS,
    alongRay * ON_RAY_LATERAL_TOLERANCE_RATIO
  );
  if (
    offRay > lateralTolerance ||
    Math.abs(cartographic.height - nominal) > ON_RAY_HEIGHT_TOLERANCE_METERS
  ) return fallback;
  return { heightMeters: cartographic.height, onRay: true };
}

/**
 * 現在時刻の精密DEM候補へ候補線を合わせる。
 *
 * 2026-10-05修正: 以前は、楕円体高0m基準で作った線の「最寄り1頂点だけ」を
 * 実地形基準の確定候補へ差し替えていた。実際の地表は楕円体より高いため確定候補は
 * 常に線より被写体側にあり、その1点だけが手前へ引き込まれて線がV字に折れていた。
 * 現在は確定候補の高さを線全体の高さ基準として全頂点を並べ直し、確定候補は
 * 時刻順の正しい位置へ挿入する。
 */
export function alignRiseSetArcToConfirmedCandidates(
  arc: TripodCandidateRiseSetArc,
  candidates: readonly TripodCandidate[],
  currentDate: Date
): TripodCandidateRiseSetArc {
  // 通常探索と方位プロファイル高速経路はいずれも、同一天体では最遠の
  // 地形交点1件を表示する。古いキャッシュに複数件が残っていても、線へ
  // 同時刻の点を複数挿入して折り返し・長い対角線を作らない。
  const matching = candidates
    .filter((candidate) =>
      candidate.id === arc.id &&
      candidate.solutionType !== "preliminary" &&
      Number.isFinite(candidate.latitude) &&
      Number.isFinite(candidate.longitude) &&
      Number.isFinite(candidate.height)
    )
    .sort((left, right) => right.distanceMeters - left.distanceMeters);
  const timestamp = currentDate.getTime();
  if (
    matching.length === 0 || Number.isNaN(timestamp) || arc.points.length === 0 ||
    timestamp < arc.riseAt.getTime() || timestamp > arc.setAt.getTime()
  ) return arc;

  const aligned: TripodCandidateRiseSetArcPoint = {
    ...matching[0],
    timestampMilliseconds: timestamp,
  };

  const model = arc.model;
  if (!model) {
    // 再計算用データを持たない線（外部で組み立てた線）は最寄り頂点の差し替えのみ。
    let nearestIndex = 0;
    let nearestDelta = Number.POSITIVE_INFINITY;
    arc.points.forEach((point, index) => {
      const delta = Math.abs(point.timestampMilliseconds - timestamp);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearestIndex = index;
      }
    });
    return {
      ...arc,
      points: [
        ...arc.points.slice(0, nearestIndex),
        aligned,
        ...arc.points.slice(nearestIndex + 1),
      ],
    };
  }

  const surface = lensSurfaceFromConfirmedCandidate(arc, model, matching[0], timestamp);
  const points = layoutArcPoints(arc.id, model, surface.heightMeters);
  // 並べ直した結果に実際の交点が残らない場合は、元の線をそのまま使う。
  if (realPointCount(points, model.maxDistanceMeters) < 2) return arc;
  if (!surface.onRay) return { ...arc, points };

  const withoutSameTime = points.filter(
    (point) => Math.abs(point.timestampMilliseconds - timestamp) >= SAME_SAMPLE_WINDOW_MS
  );
  const insertAt = withoutSameTime.findIndex(
    (point) => point.timestampMilliseconds > timestamp
  );
  const index = insertAt < 0 ? withoutSameTime.length : insertAt;
  return {
    ...arc,
    points: [
      ...withoutSameTime.slice(0, index),
      aligned,
      ...withoutSameTime.slice(index),
    ],
  };
}
