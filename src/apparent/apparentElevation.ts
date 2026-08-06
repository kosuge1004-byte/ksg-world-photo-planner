import type { CalculationMode } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { calculateGeometricElevation } from "../cesium/geometry";
import { terrestrialRefractionCorrectionDegrees } from "../geodesy/terrestrialRefraction";

/**
 * Apparent層: 地上対象（三脚候補・被写体・人物・最終構図判定など）の見かけ仰角。
 *
 * Geometry層（`calculateGeometricElevation`）が返す純粋な幾何仰角に対して、
 * standardでは何も加えず、proでは見通し距離に応じた地表屈折補正（k=0.13固定）
 * のみをここで加える。屈折の適用箇所はこの関数に一本化し、Geometry層へは
 * 一切屈折を持ち込まない。
 */
export type ApparentElevationResult = {
  geometricAltitudeDegrees: number;
  apparentAltitudeDegrees: number;
};

export function computeApparentElevation(
  observer: GroundPoint,
  target: GroundPoint,
  calculationMode: CalculationMode
): ApparentElevationResult {
  const { geometricAltitudeDegrees, slantDistanceMeters } = calculateGeometricElevation(
    observer,
    target
  );
  const apparentAltitudeDegrees = calculationMode === "pro"
    ? geometricAltitudeDegrees + terrestrialRefractionCorrectionDegrees(slantDistanceMeters)
    : geometricAltitudeDegrees;
  return { geometricAltitudeDegrees, apparentAltitudeDegrees };
}
