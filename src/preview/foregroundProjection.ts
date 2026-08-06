import { Cartesian3 } from "cesium";

import { createCameraModel } from "../cesium/cameraModelFactory";
import { projectDirectionToPlane, type ProjectionBasis } from "../projection/projectionService";
import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import { foregroundHeightCmToMeters, type ForegroundObject } from "../types/foreground";
import type { GroundPoint } from "../types/points";

const DEG = Math.PI / 180;

export type ForegroundScreenBox = {
  centerXPercent: number;
  topPercent: number;
  heightPercent: number;
  widthPercent: number;
};

const PERSON_ASPECT_RATIO = 80 / 200;

/**
 * プレビューカメラと同じECEF座標系・透視投影で人物の画面位置と実寸高を求める。
 * 角度差の線形換算ではなく焦点距離/sensor寸法によるピンホール投影を使う。
 */
export function projectForegroundObjectToPreview(
  object: ForegroundObject,
  tripod: GroundPoint,
  subject: GroundPoint,
  camera: CameraSettings,
  aspectRatio: number,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection
): ForegroundScreenBox | null {
  if (!object.enabled || !Number.isFinite(object.groundHeightMeters)) return null;
  const groundHeightMeters = object.groundHeightMeters as number;
  // 人物投影はCameraModelFactoryのApparent（見かけ仰角込み）モデルを使う。
  const { apparent: model } = createCameraModel(
    tripod, subject, camera, aspectRatio, calculationMode, viewCorrection
  );
  const observer = model.observerEcef;

  const basePosition = Cartesian3.fromDegrees(
    object.longitude,
    object.latitude,
    groundHeightMeters
  );
  const topPosition = Cartesian3.fromDegrees(
    object.longitude,
    object.latitude,
    groundHeightMeters + foregroundHeightCmToMeters(object.heightCm)
  );

  const basis: ProjectionBasis = {
    right: model.ecefRight,
    up: model.ecefUp,
    forward: model.ecefForward,
    horizontalFovDegrees: model.horizontalFovDegrees,
    verticalFovDegrees: model.verticalFovDegrees,
  };
  const horizontalScale = Math.tan(basis.horizontalFovDegrees * DEG / 2);
  const verticalScale = Math.tan(basis.verticalFovDegrees * DEG / 2);
  if (horizontalScale <= 0 || verticalScale <= 0) return null;

  // ProjectionServiceのprojectDirectionToPlane()と同じ中心投影を使う。
  // 人物・被写体・天体・画角・軌跡・最終判定はすべて同じ投影経路を経由する。
  const project = (position: Cartesian3) => {
    const offset = Cartesian3.subtract(position, observer, new Cartesian3());
    const depth = Cartesian3.dot(offset, model.ecefForward);
    if (!Number.isFinite(depth) || depth <= 0.05) return null;
    const plane = projectDirectionToPlane(offset, basis);
    if (!plane.inFront) return null;
    return { x: plane.x / horizontalScale, y: plane.y / verticalScale };
  };
  const base = project(basePosition);
  const top = project(topPosition);
  if (!base || !top) return null;

  const topPercent = 50 + top.y * 50;
  const basePercent = 50 + base.y * 50;
  const heightPercent = basePercent - topPercent;
  const centerXPercent = 50 + ((base.x + top.x) / 2) * 50;
  // CSSのwidth%は表示枠の横幅基準、height%は縦幅基準なのでaspect比で補正する。
  const widthPercent = heightPercent * PERSON_ASPECT_RATIO / aspectRatio;
  if (
    !Number.isFinite(centerXPercent) ||
    !Number.isFinite(topPercent) ||
    !Number.isFinite(heightPercent) ||
    !Number.isFinite(widthPercent) ||
    heightPercent <= 0 ||
    widthPercent <= 0
  ) {
    return null;
  }
  return { centerXPercent, topPercent, heightPercent, widthPercent };
}
