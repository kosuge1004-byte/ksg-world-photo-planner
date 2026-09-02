import { terrestrialRefractionUncertaintyDegrees } from "../geodesy/terrestrialRefraction";

export const TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES = 0.015;
// 2026-09-02変更（明示指示により）: 天体中心1点だけで遮蔽を判定する
// 方式をやめ、視直径のある円盤として扱い、地形稜線より上に出ている
// 面積の割合が5%以上あれば「見える」とする。
export const VISIBLE_FRACTION_THRESHOLD = 0.05;

export type TerrainOcclusionDecision = {
  clearanceDegrees: number;
  visibleFraction: number;
  status: "visible" | "obstructed" | "uncertain";
};

/**
 * 円（半径r）が、中心から符号付き距離d（dが正なら中心は境界線より上）
 * にある直線でどれだけ切り取られるかを、可視部分（境界線より上）の
 * 面積割合として返す。天体を点ではなく視直径のある円盤として扱うための
 * 幾何学的な計算。
 * - d >= r: 全部見える（1）
 * - d <= -r: 全部隠れる（0）
 * - それ以外: 円の弓形（circular segment）の面積公式で計算する。
 */
function circleVisibleFraction(clearanceDegrees: number, radiusDegrees: number): number {
  if (!(radiusDegrees > 0)) {
    // 視直径が無い（北極星など点として扱う天体）場合は、従来通り
    // 中心が境界線より上かどうかの二値に相当する結果を返す。
    return clearanceDegrees >= 0 ? 1 : 0;
  }
  if (clearanceDegrees >= radiusDegrees) return 1;
  if (clearanceDegrees <= -radiusDegrees) return 0;

  const totalArea = Math.PI * radiusDegrees * radiusDegrees;
  // 弓形（境界線から遠い側の小さい方の切片）の面積。
  const segmentArea = (h: number) =>
    radiusDegrees * radiusDegrees * Math.acos(h / radiusDegrees) -
    h * Math.sqrt(Math.max(0, radiusDegrees * radiusDegrees - h * h));

  if (clearanceDegrees >= 0) {
    // 中心は境界線より上＝隠れているのは下側の小さい弓形。
    const hiddenArea = segmentArea(clearanceDegrees);
    return 1 - hiddenArea / totalArea;
  }
  // 中心は境界線より下＝見えているのは上側の小さい弓形。
  const visibleArea = segmentArea(-clearanceDegrees);
  return visibleArea / totalArea;
}

/**
 * DEM稜線と天体中心が僅差のときは、データ解像度や大気差の非対称性だけで
 * 遮蔽確定にしない。既存の0.015度を片側の偽陽性マージンとして使わず、
 * ±0.015度の未確定帯として対称に扱う。この不確実帯は、新しい
 * 「視直径込みの可視割合」判定にもそのまま適用する（clearanceを
 * ±不確実帯だけ振って、判定（見える/隠れる）が変わるなら「未確定」とする）。
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
  distanceMeters?: number,
  angularDiameterDegrees = 0
): TerrainOcclusionDecision {
  if (
    !Number.isFinite(celestialAltitudeDegrees) ||
    !Number.isFinite(terrainElevationDegrees) ||
    !Number.isFinite(uncertaintyDegrees) ||
    uncertaintyDegrees < 0 ||
    !Number.isFinite(angularDiameterDegrees) ||
    angularDiameterDegrees < 0
  ) {
    throw new Error("地形遮蔽の角度条件が不正です");
  }

  const effectiveUncertaintyDegrees =
    distanceMeters !== undefined && Number.isFinite(distanceMeters)
      ? Math.max(uncertaintyDegrees, terrestrialRefractionUncertaintyDegrees(distanceMeters))
      : uncertaintyDegrees;

  const radiusDegrees = angularDiameterDegrees / 2;
  const clearanceDegrees = celestialAltitudeDegrees - terrainElevationDegrees;
  const visibleFraction = circleVisibleFraction(clearanceDegrees, radiusDegrees);

  const pessimisticFraction = circleVisibleFraction(
    clearanceDegrees - effectiveUncertaintyDegrees,
    radiusDegrees
  );
  const optimisticFraction = circleVisibleFraction(
    clearanceDegrees + effectiveUncertaintyDegrees,
    radiusDegrees
  );
  const pessimisticVisible = pessimisticFraction >= VISIBLE_FRACTION_THRESHOLD;
  const optimisticVisible = optimisticFraction >= VISIBLE_FRACTION_THRESHOLD;

  if (!pessimisticVisible && !optimisticVisible) {
    return { clearanceDegrees, visibleFraction, status: "obstructed" };
  }
  if (pessimisticVisible !== optimisticVisible) {
    return { clearanceDegrees, visibleFraction, status: "uncertain" };
  }
  return { clearanceDegrees, visibleFraction, status: "visible" };
}
