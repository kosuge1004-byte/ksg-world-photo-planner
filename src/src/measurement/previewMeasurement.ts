import { Cartesian3 } from "cesium";

import { createCameraModel } from "../cesium/cameraModelFactory";
import {
  positionOnPlaneAtDistance,
  screenToDirection,
  type ProjectionBasis,
} from "../projection/projectionService";
import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import type { GroundPoint } from "../types/points";

export type PreviewMeasurementPoint = { xPercent: number; yPercent: number };

export type PreviewMeasurementResult = {
  distanceMeters: number;
  /** 距離算出に使った奥行き（カメラから被写体までの距離）。参考表示用。 */
  planeDistanceMeters: number;
};

/**
 * プレビュー画面上の2点（画面%座標）から実距離を求める。
 *
 * プレビューは静止画像で、任意の点（特に空中・空）に対応する実際の3D表面が
 * 常にあるとは限らない。そのため、両点とも被写体と同じカメラ前方距離
 * （被写体の奥行き平面）にあると仮定して換算する。地上の構造物同士など、
 * 実際に被写体と同程度の奥行きにある2点であれば、この換算はほぼ正確になる。
 * 被写体より大きく手前・奥にある2点では、あくまで目安の値になる。
 */
export function measurePreviewDistanceMeters(
  tripod: GroundPoint,
  subject: GroundPoint,
  camera: CameraSettings,
  aspectRatio: number,
  calculationMode: CalculationMode,
  viewCorrection: CameraViewCorrection,
  pointA: PreviewMeasurementPoint,
  pointB: PreviewMeasurementPoint
): PreviewMeasurementResult {
  const { apparent } = createCameraModel(
    tripod, subject, camera, aspectRatio, calculationMode, viewCorrection
  );
  const basis: ProjectionBasis = {
    right: apparent.ecefRight,
    up: apparent.ecefUp,
    forward: apparent.ecefForward,
    horizontalFovDegrees: apparent.horizontalFovDegrees,
    verticalFovDegrees: apparent.verticalFovDegrees,
  };
  const subjectPosition = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    subject.height
  );
  const planeDistanceMeters = Cartesian3.distance(apparent.observerEcef, subjectPosition);

  const directionA = screenToDirection(pointA.xPercent, pointA.yPercent, basis);
  const directionB = screenToDirection(pointB.xPercent, pointB.yPercent, basis);
  const positionA = positionOnPlaneAtDistance(apparent.observerEcef, directionA, planeDistanceMeters);
  const positionB = positionOnPlaneAtDistance(apparent.observerEcef, directionB, planeDistanceMeters);

  const distanceMeters = Math.hypot(
    positionA.x - positionB.x,
    positionA.y - positionB.y,
    positionA.z - positionB.z
  );
  return { distanceMeters, planeDistanceMeters };
}
