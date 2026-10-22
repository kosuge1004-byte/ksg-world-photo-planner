import { Cartesian3, Cartographic, Ellipsoid } from "cesium";

import { ellipsoidalHeightMeters } from "../types/points";
import {
  RISE_SET_BODY_LABELS,
  type RiseSetArcModel,
  type RiseSetArcSample,
  type RiseSetArcTimeline,
  type TripodCandidateRiseSetArc,
  type TripodCandidateRiseSetArcPoint,
} from "./tripodCandidateRiseSetArc";
import {
  buildCelestialBackwardRay,
  rayCartographicAtDistance,
  type CelestialSubjectRay,
} from "./tripodCandidates";

/**
 * 2026-10-08: 標高を加味した三脚候補線。
 *
 * 目安の線（tripodCandidateRiseSetArc.ts の flat）は、1日分の全時刻を「三脚を立てる
 * 地面の高さは同じ」と仮定して並べる。実際の地面は場所ごとに高さが違うため、起伏の
 * ある方向では本当の候補位置から外れる。
 *
 * ここでは、時刻ごとの正確な天体方位に対して取得した地形の断面と、時刻ごとの
 * 視線を突き合わせ、視線がレンズの高さで地面に届く場所を時刻ごとに求める。
 * 確定候補の計算（calculateTripodCandidates）と同じく、交点が複数ある場合は最も遠い
 * 交点を採る。必要な断面の取得は呼び出し側が一括で済ませ、この計算自体は配列参照だけで行う。
 *
 * 方位は小数6桁まで保持する。1度刻みの保存済み断面へ丸めると10km先で最大約87m
 * 別の地形を参照してしまうため、確定候補と同じ正確な方位の断面だけを使う。
 */

/** 1方位ぶんの地形の断面。距離は被写体からの地表に沿った距離（測地線長）。 */
export type TerrainSection = {
  distancesMeters: ArrayLike<number>;
  ellipsoidalHeightsMeters: ArrayLike<number>;
};

export type TerrainSectionLookup = (bearingDegrees: number) => TerrainSection | null;

const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEGREES_TO_RADIANS = Math.PI / 180;
const WGS84_A = 6_378_137;
const WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);

// 隣り合う時刻の頂点を線で結ぶかどうかの判定。「前の頂点と同じ高さの平らな地面」を
// 仮定した場合の距離と、実際の地形から求めた距離を比べる。なだらかな地形なら両者は
// 近い。大きく食い違う場合は、交点が尾根や谷をまたいで別の斜面へ移っているので、
// そこを1本の線で結ぶと実在しない直線が描かれる。
const SEGMENT_BREAK_MIN_METERS = 300;
const SEGMENT_BREAK_RATIO = 0.35;
// 断面が検索上限のこの割合まで届いていれば、「断面の端でも視線が地面より上」を
// 「検索上限より遠くに候補がある」とみなして検索上限の円周へ収める。
const SECTION_COVERS_RANGE_RATIO = 0.99;

/** 天体の方位角から、三脚側（反対側）の正確な断面方位を求める。 */
export function terrainSectionBearing(celestialAzimuthDegrees: number): number {
  const tripodBearing = (((celestialAzimuthDegrees + 180) % 360) + 360) % 360;
  // JSON往復後もMapのキーが安定するように丸める。誤差は10km先で0.1mm未満。
  return Math.round(tripodBearing * 1_000_000) / 1_000_000;
}

function sampleHasRay(sample: RiseSetArcSample): boolean {
  return Number.isFinite(sample.rayAltitudeDegrees) && sample.rayAltitudeDegrees > 0;
}

/** この線を求めるのに必要な断面の方位（重複なし）。 */
export function requiredTerrainBearings(timeline: RiseSetArcTimeline): number[] {
  const bearings = new Set<number>();
  for (const sample of timeline.model.samples) {
    if (sampleHasRay(sample)) bearings.add(terrainSectionBearing(sample.azimuthDegrees));
  }
  return [...bearings].sort((left, right) => left - right);
}

/** 同一天体に複数交点がある場合、赤線と同じ最遠交点だけを表示対象にする。 */
export function farthestTripodCandidatesByBody(
  candidates: readonly import("../types/celestial").TripodCandidate[]
): import("../types/celestial").TripodCandidate[] {
  const farthest = new Map<string, import("../types/celestial").TripodCandidate>();
  for (const candidate of candidates) {
    const current = farthest.get(candidate.id);
    if (!current || candidate.distanceMeters > current.distanceMeters) {
      farthest.set(candidate.id, candidate);
    }
  }
  return [...farthest.values()];
}

/**
 * 選択時刻の精密候補を赤線の最寄り時刻頂点へ反映する。
 * 線は2分刻み、候補点は選択時刻そのものなので、この反映が無いと地形急変部では
 * 同じ計算式でも線分補間と点が離れて見える。3分より遠い頂点は別の出入り回として
 * 扱い、誤って線を移動しない。
 */
export function alignTerrainArcToExactCandidate(
  arc: TripodCandidateRiseSetArc,
  candidate: import("../types/celestial").TripodCandidate | undefined,
  timestampMilliseconds: number,
  maximumTimeDeltaMs = 3 * 60_000
): TripodCandidateRiseSetArc {
  if (arc.kind !== "terrain" || !candidate || candidate.id !== arc.id ||
    !Number.isFinite(timestampMilliseconds)) return arc;
  let nearest: TripodCandidateRiseSetArcPoint | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const point of arc.points) {
    const delta = Math.abs(point.timestampMilliseconds - timestampMilliseconds);
    if (delta < nearestDelta) {
      nearest = point;
      nearestDelta = delta;
    }
  }
  if (!nearest || nearestDelta > maximumTimeDeltaMs) return arc;
  const replacement: TripodCandidateRiseSetArcPoint = {
    ...candidate,
    timestampMilliseconds: nearest.timestampMilliseconds,
  };
  const replace = (point: TripodCandidateRiseSetArcPoint) =>
    point === nearest ? replacement : point;
  const segments = (arc.segments ?? [arc.points]).map((segment) => segment.map(replace));
  return { ...arc, points: segments.flat(), segments };
}

type SampleGeometry = {
  ray: CelestialSubjectRay;
  /** 視線の俯角の正弦（被写体地点の水平面に対して。下向きなので負）。 */
  sinDip: number;
  dipRadians: number;
  /** 視線の方位に沿った地球の曲率半径（m）。 */
  radiusMeters: number;
  /** 曲率中心から被写体までの距離（m）。 */
  originRadiusMeters: number;
};

function sampleGeometry(model: RiseSetArcModel, sample: RiseSetArcSample): SampleGeometry | null {
  if (!sampleHasRay(sample)) return null;
  const ray = buildCelestialBackwardRay(
    model.subject, sample.azimuthDegrees, sample.rayAltitudeDegrees, model.observer
  );
  if (!ray) return null;
  const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(
    Cartographic.fromDegrees(model.subject.longitude, model.subject.latitude, 0),
    new Cartesian3()
  );
  const sinDip = Cartesian3.dot(ray.direction, up);
  if (!Number.isFinite(sinDip) || Math.abs(sinDip) >= 1) return null;
  const latitude = model.subject.latitude * DEGREES_TO_RADIANS;
  const w = 1 - WGS84_E2 * Math.sin(latitude) ** 2;
  const meridional = WGS84_A * (1 - WGS84_E2) / w ** 1.5;
  const primeVertical = WGS84_A / Math.sqrt(w);
  const bearing = (sample.azimuthDegrees + 180) * DEGREES_TO_RADIANS;
  const radiusMeters = 1 / (
    Math.cos(bearing) ** 2 / meridional + Math.sin(bearing) ** 2 / primeVertical
  );
  return {
    ray,
    sinDip,
    dipRadians: Math.asin(sinDip),
    radiusMeters,
    originRadiusMeters: radiusMeters + ellipsoidalHeightMeters(model.subject),
  };
}

/**
 * 地表に沿った距離がgroundDistanceMetersの地点の真上を視線が通るときの、
 * 被写体からの直線距離。視線がそこへ届かない（上向きに離れていく）場合はnull。
 * 視線の方位に沿った曲率半径の球で近似する（100km先でも高さ数cmの誤差）。
 */
function rayDistanceAtGroundDistance(geometry: SampleGeometry, groundDistanceMeters: number): number | null {
  const theta = groundDistanceMeters / geometry.radiusMeters;
  const denominator = Math.cos(geometry.dipRadians + theta);
  if (!(denominator > 1e-9)) return null;
  const distance = geometry.originRadiusMeters * Math.sin(theta) / denominator;
  return Number.isFinite(distance) && distance >= 0 ? distance : null;
}

/** 被写体から直線距離rayDistanceMeters進んだ視線上の点の楕円体高。 */
function rayHeightAtRayDistance(geometry: SampleGeometry, rayDistanceMeters: number): number {
  const origin = geometry.originRadiusMeters;
  return Math.sqrt(
    origin * origin + rayDistanceMeters * rayDistanceMeters +
    2 * origin * rayDistanceMeters * geometry.sinDip
  ) - geometry.radiusMeters;
}

type SampleOutcome =
  /** 視線がレンズの高さで地面に届いた。 */
  | { type: "hit"; rayDistanceMeters: number; groundEllipsoidalHeightMeters: number }
  /** 検索上限まで視線が地面より上（候補は検索上限より遠い）。 */
  | { type: "beyond" }
  /** この時刻に候補は無い、または断面の範囲では判断できない。 */
  | { type: "none" };

/**
 * 1時刻ぶん: 断面と視線の交点（最も遠いもの）を求める。
 * 断面の各点で「視線の高さ − レンズ高 − 地面の高さ」を求め、符号が変わる区間を
 * 線形補間する。
 */
export function terrainIntersectionForSample(
  model: RiseSetArcModel,
  sample: RiseSetArcSample,
  section: TerrainSection
): SampleOutcome {
  const geometry = sampleGeometry(model, sample);
  if (!geometry) return { type: "none" };
  const count = Math.min(section.distancesMeters.length, section.ellipsoidalHeightsMeters.length);
  let previousError = Number.NaN;
  let previousRayDistance = Number.NaN;
  let previousGround = Number.NaN;
  let lastError = Number.NaN;
  let lastGroundDistance = Number.NaN;
  let hit: { rayDistanceMeters: number; groundEllipsoidalHeightMeters: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const groundDistance = section.distancesMeters[index];
    const ground = section.ellipsoidalHeightsMeters[index];
    if (!Number.isFinite(groundDistance) || !Number.isFinite(ground)) {
      previousError = Number.NaN;
      continue;
    }
    const rayDistance = rayDistanceAtGroundDistance(geometry, groundDistance);
    if (rayDistance === null) break;
    if (rayDistance > model.maxDistanceMeters) break;
    const error = rayHeightAtRayDistance(geometry, rayDistance) - model.lensCenterHeightMeters - ground;
    if (Number.isFinite(previousError) && (previousError === 0 || error === 0 || previousError * error < 0)) {
      const total = Math.abs(previousError) + Math.abs(error);
      const ratio = total > 0 ? Math.abs(previousError) / total : 0.5;
      // 後から見つかった交点で上書きする（＝最も遠い交点が残る）。
      hit = {
        rayDistanceMeters: previousRayDistance + (rayDistance - previousRayDistance) * ratio,
        groundEllipsoidalHeightMeters: previousGround + (ground - previousGround) * ratio,
      };
    }
    previousError = error;
    previousRayDistance = rayDistance;
    previousGround = ground;
    lastError = error;
    lastGroundDistance = groundDistance;
  }
  if (hit) return { type: "hit", ...hit };
  if (!Number.isFinite(lastError) || !(lastError > 0)) return { type: "none" };
  // 交点なし・最後まで視線が地面より上。断面が検索上限まで届いていれば「上限より遠い」。
  const reachedRayDistance = rayDistanceAtGroundDistance(geometry, lastGroundDistance);
  const lastSectionDistance = count > 0 ? section.distancesMeters[count - 1] : Number.NaN;
  const sectionEndRayDistance = Number.isFinite(lastSectionDistance)
    ? rayDistanceAtGroundDistance(geometry, lastSectionDistance)
    : null;
  const coversRange =
    (sectionEndRayDistance !== null && sectionEndRayDistance >= model.maxDistanceMeters * SECTION_COVERS_RANGE_RATIO) ||
    (reachedRayDistance !== null && reachedRayDistance >= model.maxDistanceMeters * SECTION_COVERS_RANGE_RATIO);
  return coversRange ? { type: "beyond" } : { type: "none" };
}

type PlacedPoint = {
  point: TripodCandidateRiseSetArcPoint;
  outcome: Exclude<SampleOutcome, { type: "none" }>;
  geometry: SampleGeometry;
};

/** 「地面の高さがgroundの平らな土地」だった場合に、この時刻の視線が届く直線距離。 */
function flatGroundRayDistance(
  geometry: SampleGeometry,
  groundEllipsoidalHeightMeters: number,
  model: RiseSetArcModel
): number {
  // (R+h0)^2 + t^2 + 2(R+h0)t·sinDip = (R+target)^2 を t について解く。
  const origin = geometry.originRadiusMeters;
  const target = geometry.radiusMeters + groundEllipsoidalHeightMeters + model.lensCenterHeightMeters;
  const b = 2 * origin * geometry.sinDip;
  const c = origin * origin - target * target;
  const discriminant = b * b - 4 * c;
  if (!(c > 0) || discriminant < 0) return model.maxDistanceMeters;
  const distance = (-b - Math.sqrt(discriminant)) / 2;
  return Number.isFinite(distance) && distance > 0
    ? Math.min(distance, model.maxDistanceMeters)
    : model.maxDistanceMeters;
}

function shouldBreakBetween(previous: PlacedPoint, current: PlacedPoint, model: RiseSetArcModel): boolean {
  // 「reference の地面の高さの平らな土地」だった場合に other の視線が届く距離と、
  // 実際に求めた other の距離の食い違い（許容量を超えた分）。
  const excess = (reference: PlacedPoint, other: PlacedPoint): number => {
    if (reference.outcome.type !== "hit") return 0;
    const predicted = flatGroundRayDistance(
      other.geometry, reference.outcome.groundEllipsoidalHeightMeters, model
    );
    const actual = other.point.distanceMeters;
    return Math.abs(actual - predicted) - Math.max(SEGMENT_BREAK_MIN_METERS, predicted * SEGMENT_BREAK_RATIO);
  };
  // 検索上限の円周どうしはそのままつなぐ。それ以外は、どちらかの頂点を基準にして
  // 食い違えば切る（崖の途中に当たった頂点は地面の高さが中途半端になるため、
  // 片側だけでは不連続を見落とす）。
  return Math.max(excess(previous, current), excess(current, previous)) > 0;
}

function placePoint(
  timeline: RiseSetArcTimeline,
  sample: RiseSetArcSample,
  outcome: Exclude<SampleOutcome, { type: "none" }>,
  geometry: SampleGeometry
): PlacedPoint | null {
  const { id, model } = timeline;
  const distanceMeters = outcome.type === "hit" ? outcome.rayDistanceMeters : model.maxDistanceMeters;
  const cartographic = rayCartographicAtDistance(geometry.ray, distanceMeters);
  if (!cartographic) return null;
  return {
    outcome,
    geometry,
    point: {
      id,
      label: RISE_SET_BODY_LABELS[id],
      latitude: cartographic.latitude * RADIANS_TO_DEGREES,
      longitude: cartographic.longitude * RADIANS_TO_DEGREES,
      height: outcome.type === "hit"
        ? outcome.groundEllipsoidalHeightMeters
        : cartographic.height - model.lensCenterHeightMeters,
      distanceMeters,
      solutionType: "preliminary",
      timestampMilliseconds: sample.timestampMilliseconds,
    },
  };
}

export type BuildTerrainRiseSetArcOptions = {
  signal?: AbortSignal;
  /** この件数の時刻を処理するごとに描画へ処理を譲る。0以下なら譲らない。 */
  yieldEverySamples?: number;
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 出から入りまでの全時刻について地形との交点を求め、標高を加味した線を作る。
 * 必要な方位の断面が1つでも無い場合、または線にできる区間が無い場合はnull。
 */
export async function buildTerrainRiseSetArc(
  timeline: RiseSetArcTimeline,
  lookup: TerrainSectionLookup,
  options: BuildTerrainRiseSetArcOptions = {}
): Promise<TripodCandidateRiseSetArc | null> {
  const { model } = timeline;
  const yieldEvery = options.yieldEverySamples ?? 24;
  const segments: TripodCandidateRiseSetArcPoint[][] = [];
  let current: TripodCandidateRiseSetArcPoint[] = [];
  let previous: PlacedPoint | null = null;
  const closeSegment = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
    previous = null;
  };
  let processed = 0;
  for (const sample of model.samples) {
    if (options.signal?.aborted) return null;
    if (yieldEvery > 0 && processed > 0 && processed % yieldEvery === 0) {
      await yieldToEventLoop();
      if (options.signal?.aborted) return null;
    }
    processed += 1;
    if (!sampleHasRay(sample)) {
      // 地平線すれすれ（高度0.25度以下）は視線を作らない。目安の線と同じく
      // 検索上限の円周へ収めるため、下のbeyondと同じ扱いにする。
      const horizonGeometry = sampleGeometry(model, { ...sample, rayAltitudeDegrees: 0.25 });
      const placed = horizonGeometry
        ? placePoint(timeline, sample, { type: "beyond" }, horizonGeometry)
        : null;
      if (!placed) { closeSegment(); continue; }
      if (previous && shouldBreakBetween(previous, placed, model)) closeSegment();
      current.push(placed.point);
      previous = placed;
      continue;
    }
    const section = lookup(terrainSectionBearing(sample.azimuthDegrees));
    if (!section) return null;
    const geometry = sampleGeometry(model, sample);
    const outcome = terrainIntersectionForSample(model, sample, section);
    if (!geometry || outcome.type === "none") { closeSegment(); continue; }
    const placed = placePoint(timeline, sample, outcome, geometry);
    if (!placed) { closeSegment(); continue; }
    if (previous && shouldBreakBetween(previous, placed, model)) closeSegment();
    current.push(placed.point);
    previous = placed;
  }
  closeSegment();

  const drawable = segments.filter((segment) => segment.length >= 2);
  const hasRealIntersection = drawable.some((segment) =>
    segment.some((point) => point.distanceMeters < model.maxDistanceMeters)
  );
  // 検索上限の円周だけが残る場合は線として見せない（目安の線と同じ方針）。
  if (!hasRealIntersection) return null;
  return {
    id: timeline.id,
    riseAt: timeline.riseAt,
    setAt: timeline.setAt,
    points: segments.flat(),
    segments,
    kind: "terrain",
    model,
  };
}
