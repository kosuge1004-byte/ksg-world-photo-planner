export const TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES = 0.015;

export type TerrainOcclusionDecision = {
  clearanceDegrees: number;
  status: "visible" | "obstructed" | "uncertain";
};

/**
 * DEM稜線と天体中心が僅差のときは、データ解像度や大気差の非対称性だけで
 * 遮蔽確定にしない。既存の0.015度を片側の偽陽性マージンとして使わず、
 * ±0.015度の未確定帯として対称に扱う。
 */
export function classifyTerrainOcclusion(
  celestialAltitudeDegrees: number,
  terrainElevationDegrees: number,
  uncertaintyDegrees = TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES
): TerrainOcclusionDecision {
  if (
    !Number.isFinite(celestialAltitudeDegrees) ||
    !Number.isFinite(terrainElevationDegrees) ||
    !Number.isFinite(uncertaintyDegrees) ||
    uncertaintyDegrees < 0
  ) {
    throw new Error("地形遮蔽の角度条件が不正です");
  }

  const clearanceDegrees = celestialAltitudeDegrees - terrainElevationDegrees;
  if (clearanceDegrees < -uncertaintyDegrees) {
    return { clearanceDegrees, status: "obstructed" };
  }
  if (clearanceDegrees <= uncertaintyDegrees) {
    return { clearanceDegrees, status: "uncertain" };
  }
  return { clearanceDegrees, status: "visible" };
}
