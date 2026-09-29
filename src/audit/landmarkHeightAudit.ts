import type { GroundPoint } from "../types/points";
import { ellipsoidalHeightMeters } from "../types/points";

/**
 * 高さ未確認の登録スポットを、アプリ本体と同じ計算モデルで実測する（2026-09-29）。
 *
 * カタログの heightMeters は「登録座標のDEM地表（楕円体高）から頂上までの高さ」。
 * アプリは被写体を「登録座標のDEM地表 + heightMeters」に置くので、
 *   heightMeters = PLATEAU頂上の楕円体高 − 登録座標のDEM地表の楕円体高
 * と同じ地表で測れば、天守台（石垣）がDEMに含まれていても含まれていなくても
 * 二重計上・過小計上は構造的に起きない。ジオイド（JPGEO2024）は地表・頂上の
 * 両方に同じ手順で入るため差に影響しない。
 *
 * PLATEAUの頂上探索は登録座標から最大約56m離れた別建物を拾い得るため、
 * 頂上位置の水平距離と、周囲DEMに対する台の高さを記録し、採否は
 * acceptLandmarkHeightAuditResult() で機械的に判定する。
 */

export type LandmarkHeightAuditTarget = {
  name: string;
  latitude: number;
  longitude: number;
};

export type LandmarkHeightAuditResult = {
  name: string;
  latitude: number;
  longitude: number;
  status: "measured" | "no-plateau-roof" | "ground-failed" | "error";
  /** 登録座標のDEM地表（楕円体高, m）。 */
  groundEllipsoidalMeters: number | null;
  /** PLATEAU頂上（楕円体高, m）。 */
  topEllipsoidalMeters: number | null;
  /** 登録座標から頂上点までの水平距離（m）。 */
  topOffsetMeters: number | null;
  /** heightMeters候補（頂上 − 登録座標の地表）。 */
  heightMeters: number | null;
  /** 登録座標の地表が周囲DEM（半径40/80mの下位20%）より高い量（m）。参考値。 */
  platformMeters: number | null;
  message?: string;
};

export type LandmarkHeightAuditDependencies = {
  resolveGround: (target: LandmarkHeightAuditTarget) => Promise<GroundPoint>;
  resolvePlateauTop: (target: LandmarkHeightAuditTarget) => Promise<GroundPoint | null>;
  /** 周囲点の地表楕円体高。取得できない点は null。 */
  sampleRing: (points: Array<{ latitude: number; longitude: number }>) => Promise<Array<number | null>>;
};

const RING_RADII_METERS = [40, 80];
const RING_BEARINGS_DEGREES = Array.from({ length: 12 }, (_, index) => index * 30);

function offsetPoint(latitude: number, longitude: number, bearingDegrees: number, distanceMeters: number) {
  const radians = (bearingDegrees * Math.PI) / 180;
  return {
    latitude: latitude + (Math.cos(radians) * distanceMeters) / 111_320,
    longitude: longitude + (Math.sin(radians) * distanceMeters) / (111_320 * Math.cos((latitude * Math.PI) / 180)),
  };
}

export function horizontalDistanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const north = (b.latitude - a.latitude) * 111_320;
  const east = (b.longitude - a.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(north, east);
}

function lowerQuintile(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(0.2 * (sorted.length - 1))];
}

export async function auditLandmarkHeight(
  target: LandmarkHeightAuditTarget,
  dependencies: LandmarkHeightAuditDependencies
): Promise<LandmarkHeightAuditResult> {
  const base: LandmarkHeightAuditResult = {
    name: target.name,
    latitude: target.latitude,
    longitude: target.longitude,
    status: "error",
    groundEllipsoidalMeters: null,
    topEllipsoidalMeters: null,
    topOffsetMeters: null,
    heightMeters: null,
    platformMeters: null,
  };
  let ground: GroundPoint;
  try {
    ground = await dependencies.resolveGround(target);
  } catch (error) {
    return { ...base, status: "ground-failed", message: error instanceof Error ? error.message : String(error) };
  }
  const groundEllipsoidal = ellipsoidalHeightMeters(ground);
  const result: LandmarkHeightAuditResult = { ...base, groundEllipsoidalMeters: groundEllipsoidal };

  try {
    const ring = RING_RADII_METERS.flatMap((radius) =>
      RING_BEARINGS_DEGREES.map((bearing) => offsetPoint(target.latitude, target.longitude, bearing, radius))
    );
    const ringHeights = (await dependencies.sampleRing(ring))
      .filter((height): height is number => typeof height === "number" && Number.isFinite(height));
    const low = lowerQuintile(ringHeights);
    result.platformMeters = low === null ? null : groundEllipsoidal - low;
  } catch {
    result.platformMeters = null;
  }

  let top: GroundPoint | null;
  try {
    top = await dependencies.resolvePlateauTop(target);
  } catch (error) {
    return { ...result, status: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (!top) return { ...result, status: "no-plateau-roof" };
  const topEllipsoidal = ellipsoidalHeightMeters(top);
  return {
    ...result,
    status: "measured",
    topEllipsoidalMeters: topEllipsoidal,
    topOffsetMeters: horizontalDistanceMeters(target, top),
    heightMeters: topEllipsoidal - groundEllipsoidal,
  };
}

export async function auditLandmarkHeights(
  targets: LandmarkHeightAuditTarget[],
  dependencies: LandmarkHeightAuditDependencies,
  onProgress?: (completed: number, total: number, latest: LandmarkHeightAuditResult) => void,
  signal?: AbortSignal
): Promise<LandmarkHeightAuditResult[]> {
  const results: LandmarkHeightAuditResult[] = [];
  for (const target of targets) {
    if (signal?.aborted) break;
    const result = await auditLandmarkHeight(target, dependencies);
    results.push(result);
    onProgress?.(results.length, targets.length, result);
  }
  return results;
}

/** 実測値をカタログへ自動採用してよいかの機械判定。 */
export const LANDMARK_AUDIT_ACCEPTANCE = Object.freeze({
  /** 天守・櫓の平面は概ね一辺10〜30m。これより遠い頂上は隣の別建物とみなす。 */
  maxTopOffsetMeters: 30,
  minHeightMeters: 3,
  maxHeightMeters: 120,
});

export function acceptLandmarkHeightAuditResult(
  result: LandmarkHeightAuditResult
): { accepted: true; heightMeters: number } | { accepted: false; reason: string } {
  if (result.status !== "measured" || result.heightMeters === null || result.topOffsetMeters === null) {
    return { accepted: false, reason: `実測できず（${result.status}${result.message ? `: ${result.message}` : ""}）` };
  }
  if (result.topOffsetMeters > LANDMARK_AUDIT_ACCEPTANCE.maxTopOffsetMeters) {
    return { accepted: false, reason: `頂上が登録座標から${result.topOffsetMeters.toFixed(1)}m離れており別建物の可能性` };
  }
  if (result.heightMeters < LANDMARK_AUDIT_ACCEPTANCE.minHeightMeters ||
    result.heightMeters > LANDMARK_AUDIT_ACCEPTANCE.maxHeightMeters) {
    return { accepted: false, reason: `高さ${result.heightMeters.toFixed(1)}mが想定範囲外` };
  }
  return { accepted: true, heightMeters: Math.round(result.heightMeters * 10) / 10 };
}
