import { terrestrialRefractionUncertaintyDegrees } from "../geodesy/terrestrialRefraction";

export const TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES = 0.015;

export type TerrainOcclusionDecision = {
  clearanceDegrees: number;
  status: "visible" | "obstructed" | "uncertain";
};

/**
 * DEM稜線と天体中心が僅差のときは、データ解像度や大気差の非対称性だけで
 * 遮蔽確定にしない。既存の0.015度を片側の偽陽性マージンとして使わず、
 * ±0.015度の未確定帯として対称に扱う。
 *
 * distanceMeters を渡した場合、地表屈折係数kの実用的な変動幅
 * （0.05〜0.2）に由来する残差不確かさを見積もり、既存の0.015度と
 * 比較して大きい方を未確定帯として採用する。長距離の稜線ほど、
 * DEM解像度よりも大気の状態そのものが判定精度の律速要因になるため。
 */
export function classifyTerrainOcclusion(
  celestialAltitudeDegrees: number,
  terrainElevationDegrees: number,
  uncertaintyDegrees = TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES,
  distanceMeters?: number
): TerrainOcclusionDecision {
  if (
    !Number.isFinite(celestialAltitudeDegrees) ||
    !Number.isFinite(terrainElevationDegrees) ||
    !Number.isFinite(uncertaintyDegrees) ||
    uncertaintyDegrees < 0
  ) {
    throw new Error("地形遮蔽の角度条件が不正です");
  }

  const effectiveUncertaintyDegrees =
    distanceMeters !== undefined && Number.isFinite(distanceMeters)
      ? Math.max(uncertaintyDegrees, terrestrialRefractionUncertaintyDegrees(distanceMeters))
      : uncertaintyDegrees;

  const clearanceDegrees = celestialAltitudeDegrees - terrainElevationDegrees;
  if (clearanceDegrees < -effectiveUncertaintyDegrees) {
    return { clearanceDegrees, status: "obstructed" };
  }
  if (clearanceDegrees <= effectiveUncertaintyDegrees) {
    return { clearanceDegrees, status: "uncertain" };
  }
  return { clearanceDegrees, status: "visible" };
}
