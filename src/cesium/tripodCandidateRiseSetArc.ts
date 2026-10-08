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

export type RiseSetCandidateBodyId = Extract<CelestialBodyId, "sun" | "moon" | "milkyWay">;

export const RISE_SET_BODY_LABELS: Record<RiseSetCandidateBodyId, string> = {
  sun: "太陽",
  moon: "月",
  milkyWay: "天の川",
};

export type RiseSetArcSample = {
  timestampMilliseconds: number;
  azimuthDegrees: number;
  /** レイ方向に使う高度。精密探索と同じく幾何高度を優先する。 */
  rayAltitudeDegrees: number;
};

/** 線の頂点を求めるための元データ（被写体・観測点・時刻ごとの天体方向）。 */
export type RiseSetArcModel = {
  subject: GroundPoint;
  observer: GroundPoint;
  lensCenterHeightMeters: number;
  maxDistanceMeters: number;
  calculationMode: CalculationMode;
  refractionWeather?: RefractionWeatherContext;
  samples: RiseSetArcSample[];
};

/**
 * flat   : 三脚を立てる地面の高さを1つに仮定した目安の線（地形データが無い地点）。
 * terrain: 方位ごとの地形の断面と視線の交点を時刻ごとに求めた線（標高を加味）。
 */
export type TripodCandidateRiseSetArcKind = "flat" | "terrain";

export type TripodCandidateRiseSetArc = {
  id: RiseSetCandidateBodyId;
  riseAt: Date;
  setAt: Date;
  /** 時刻順の全頂点。 */
  points: TripodCandidateRiseSetArcPoint[];
  /** 未指定は flat。 */
  kind?: TripodCandidateRiseSetArcKind;
  /**
   * 連続して描く区間ごとの頂点。尾根を越えて交点が別の斜面へ移る箇所などで線を
   * 切るために使う。未指定の場合は points 全体を1本の線として描く。
   */
  segments?: TripodCandidateRiseSetArcPoint[][];
  /** buildTripodCandidateRiseSetArc() が作った線だけが持つ。 */
  model?: RiseSetArcModel;
};

/** 描画用: 2点以上ある区間だけを返す。 */
export function riseSetArcSegments(
  arc: TripodCandidateRiseSetArc
): TripodCandidateRiseSetArcPoint[][] {
  return (arc.segments ?? [arc.points]).filter((segment) => segment.length >= 2);
}

/** 出から入りまでの時刻と、線の頂点を求めるための元データ。 */
export type RiseSetArcTimeline = {
  id: RiseSetCandidateBodyId;
  riseAt: Date;
  setAt: Date;
  model: RiseSetArcModel;
};

export type TripodCandidateRiseSetArcPoint = TripodCandidate & {
  timestampMilliseconds: number;
};

export type BuildTripodCandidateRiseSetArcInput = {
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
  const label = RISE_SET_BODY_LABELS[id];
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
 *
 * この関数が作るのは「三脚を立てる地面の高さを1つに仮定した」目安の線（kind: "flat"）。
 * 2026-10-08: 以前は、表示中の時刻の確定候補が届くたびに、その候補の標高で線全体を
 * 並べ直していた（alignRiseSetArcToConfirmedCandidates）。候補には計算時刻の情報が
 * 無く、時刻変更直後の「前の時刻の候補」やドラッグ中の合成候補も同じ扱いで渡されて
 * いたため、線に誤った頂点が入り、候補が入れ替わるたびに線全体が動いていた。
 * 線は確定候補を一切参照しない。標高を加味した線は tripodCandidateTerrainArc.ts が
 * 地形の断面から求める。
 */
export function buildTripodCandidateRiseSetArc(
  input: BuildTripodCandidateRiseSetArcInput
): TripodCandidateRiseSetArc | null {
  const timeline = buildRiseSetArcTimeline(input);
  if (!timeline) return null;
  const { id, riseAt, setAt, model } = timeline;
  const { lensCenterHeightMeters, maxDistanceMeters } = model;
  const referenceGroundEllipsoidalHeightMeters = input.referenceGroundEllipsoidalHeightMeters;
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
  return { id, riseAt, setAt, points, kind: "flat", model };
}

/**
 * 選択日の出から入りまでの時刻と、各時刻の天体方向を求める。地面の高さには依存しない。
 * 目安の線（buildTripodCandidateRiseSetArc）と、地形の断面から求める線
 * （buildTerrainRiseSetArc）の両方がこれを元にする。
 */
export function buildRiseSetArcTimeline({
  id,
  subject,
  dayStart,
  dayEnd,
  lensCenterHeightMeters,
  calculationMode,
  maxDistanceMeters,
  refractionWeather,
  sampleMinutes = DEFAULT_SAMPLE_MINUTES,
}: Omit<BuildTripodCandidateRiseSetArcInput, "referenceGroundEllipsoidalHeightMeters">): RiseSetArcTimeline | null {
  if (
    Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime()) ||
    dayEnd <= dayStart || !Number.isFinite(maxDistanceMeters) || maxDistanceMeters <= 0
  ) return null;

  const label = RISE_SET_BODY_LABELS[id];
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
  return { id, riseAt, setAt, model };
}
