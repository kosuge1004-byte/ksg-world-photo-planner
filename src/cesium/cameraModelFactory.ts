import { Cartesian3, Ellipsoid, Math as CesiumMath } from "cesium";

import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { ellipsoidalHeightMeters, withLensCenterHeight } from "../types/points";
import { calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import { computeApparentElevation } from "../apparent/apparentElevation";
import { sensorDimensionsMm } from "./optics";
import { horizontalDirectionToVec3 } from "../projection/projectionService";
import {
  assertBearingDegrees,
  assertEcefPosition,
  assertFovDegrees,
  assertPitchDegrees,
} from "../validation/validationService";

export type LocalCameraVector = { east: number; north: number; up: number };

/**
 * カメラの向き（方位・仰角・heading/pitch/roll・forward/right/up）を
 * 表す共通の形。GeometryCameraModelとApparentCameraModelは、この形に
 * それぞれ幾何仰角／見かけ仰角を入れて生成される。
 */
export type CameraOrientation = {
  azimuthDegrees: number;
  altitudeDegrees: number;
  headingRadians: number;
  pitchRadians: number;
  rollRadians: number;
  localForward: LocalCameraVector;
  localRight: LocalCameraVector;
  localUp: LocalCameraVector;
  ecefForward: Cartesian3;
  ecefRight: Cartesian3;
  ecefUp: Cartesian3;
};

export type GeometryCameraModel = CameraOrientation & {
  observerPoint: GroundPoint;
  observerEcef: Cartesian3;
  horizontalFovDegrees: number;
  verticalFovDegrees: number;
};

/** Apparent＝見かけ仰角（地表屈折込み）で組み立てたカメラモデル。実カメラの指向・天体/人物投影が使う。 */
export type ApparentCameraModel = GeometryCameraModel;

export type CameraModelPair = {
  /** 屈折を含まない純粋な幾何仰角で組み立てたカメラモデル。 */
  geometry: GeometryCameraModel;
  /** 地表屈折込みの見かけ仰角で組み立てたカメラモデル。実際のレンズ指向・投影はこちらを使う。 */
  apparent: ApparentCameraModel;
};

/** viewCorrectionの加算で0〜360度を外れた方位角を正規化する。 */
function normalizeBearingDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function horizontalDirection(azimuthDegrees: number, altitudeDegrees: number): LocalCameraVector {
  const vec = horizontalDirectionToVec3(azimuthDegrees, altitudeDegrees);
  return { east: vec.x, north: vec.y, up: vec.z };
}

function localBasis(observerEcef: Cartesian3): { east: Cartesian3; north: Cartesian3; surfaceUp: Cartesian3 } {
  const surfaceUp = Ellipsoid.WGS84.geodeticSurfaceNormal(observerEcef, new Cartesian3());
  let east = Cartesian3.cross(Cartesian3.UNIT_Z, surfaceUp, new Cartesian3());
  if (Cartesian3.magnitudeSquared(east) < 1e-12) east = Cartesian3.clone(Cartesian3.UNIT_X);
  Cartesian3.normalize(east, east);
  const north = Cartesian3.normalize(Cartesian3.cross(surfaceUp, east, new Cartesian3()), new Cartesian3());
  return { east, north, surfaceUp };
}

function localToEcef(
  vector: LocalCameraVector,
  basis: { east: Cartesian3; north: Cartesian3; surfaceUp: Cartesian3 }
): Cartesian3 {
  const result = new Cartesian3();
  Cartesian3.add(
    Cartesian3.multiplyByScalar(basis.east, vector.east, new Cartesian3()),
    Cartesian3.multiplyByScalar(basis.north, vector.north, new Cartesian3()),
    result
  );
  Cartesian3.add(result, Cartesian3.multiplyByScalar(basis.surfaceUp, vector.up, new Cartesian3()), result);
  return Cartesian3.normalize(result, result);
}

function buildOrientation(
  azimuthDegrees: number,
  altitudeDegrees: number,
  basis: { east: Cartesian3; north: Cartesian3; surfaceUp: Cartesian3 }
): CameraOrientation {
  const localForward = horizontalDirection(azimuthDegrees, altitudeDegrees);
  const azimuth = azimuthDegrees * Math.PI / 180;
  const altitude = altitudeDegrees * Math.PI / 180;
  const localRight = { east: Math.cos(azimuth), north: -Math.sin(azimuth), up: 0 };
  const localUp = {
    east: -Math.sin(azimuth) * Math.sin(altitude),
    north: -Math.cos(azimuth) * Math.sin(altitude),
    up: Math.cos(altitude),
  };
  return {
    azimuthDegrees,
    altitudeDegrees,
    headingRadians: CesiumMath.toRadians(azimuthDegrees),
    pitchRadians: CesiumMath.toRadians(altitudeDegrees),
    rollRadians: 0,
    localForward,
    localRight,
    localUp,
    ecefForward: localToEcef(localForward, basis),
    ecefRight: localToEcef(localRight, basis),
    ecefUp: localToEcef(localUp, basis),
  };
}

/**
 * CameraModelFactory: heading/pitch/roll/forward/right/up/FOVを生成する唯一の場所。
 * 検索・Cesium実カメラ・天体・人物の全投影はここで作られたモデルだけを参照する。
 *
 * 方位はWGS84上のKarney逆解、FOVは36x24mm内接方式で、GeometryとApparentで共通。
 * 仰角のみGeometry（純粋な幾何仰角）とApparent（地表屈折込みの見かけ仰角）で
 * 分岐する。viewCorrection（手動補正）は屈折とは別の物理的な指向補正のため、
 * 両モデルへ均等に加える。
 */
export function createCameraModel(
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  aspectRatio: number,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection
): CameraModelPair {
  const observerPoint = withLensCenterHeight(tripod, settings.lensCenterHeightMeters);
  const observerEcef = Cartesian3.fromDegrees(
    observerPoint.longitude,
    observerPoint.latitude,
    ellipsoidalHeightMeters(observerPoint)
  );
  const line = calculateKarneyLineMetrics(tripod, subject);
  const azimuthDegrees = normalizeBearingDegrees(
    line.bearingDegrees + (viewCorrection?.azimuthDegrees ?? 0)
  );
  const elevation = computeApparentElevation(observerPoint, subject, calculationMode);
  const viewCorrectionAltitude = viewCorrection?.altitudeDegrees ?? 0;
  const geometryAltitudeDegrees = elevation.geometricAltitudeDegrees + viewCorrectionAltitude;
  const apparentAltitudeDegrees = elevation.apparentAltitudeDegrees + viewCorrectionAltitude;

  // ValidationServiceで方位・仰角・画角・ECEF基準点を検証してから
  // カメラ基底を組む。NaN/範囲外はここで停止する。
  assertEcefPosition(observerEcef, "カメラ観測点のECEF座標");
  assertBearingDegrees(azimuthDegrees, "カメラ方位角");
  assertPitchDegrees(geometryAltitudeDegrees, "カメラ幾何仰角");
  assertPitchDegrees(apparentAltitudeDegrees, "カメラ見かけ仰角");

  const sensor = sensorDimensionsMm(aspectRatio);
  const horizontalFovDegrees = 2 * Math.atan(sensor.width / (2 * settings.focalLengthMm)) * 180 / Math.PI;
  const verticalFovDegrees = 2 * Math.atan(sensor.height / (2 * settings.focalLengthMm)) * 180 / Math.PI;
  assertFovDegrees(horizontalFovDegrees, "水平画角");
  assertFovDegrees(verticalFovDegrees, "垂直画角");

  const basis = localBasis(observerEcef);
  const geometry: GeometryCameraModel = {
    observerPoint,
    observerEcef,
    horizontalFovDegrees,
    verticalFovDegrees,
    ...buildOrientation(azimuthDegrees, geometryAltitudeDegrees, basis),
  };
  const apparent: ApparentCameraModel = {
    observerPoint,
    observerEcef,
    horizontalFovDegrees,
    verticalFovDegrees,
    ...buildOrientation(azimuthDegrees, apparentAltitudeDegrees, basis),
  };
  return { geometry, apparent };
}
