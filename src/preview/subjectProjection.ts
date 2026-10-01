import { Cartesian3 } from "cesium";

import { createCameraModel } from "../cesium/cameraModelFactory";
import { projectToScreen, type ScreenProjection } from "../projection/projectionService";
import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import { ellipsoidalHeightMeters, type GroundPoint } from "../types/points";

/**
 * 被写体ピンの3D座標を、実際のプレビュー撮影と同じカメラモデルで画面座標へ投影する。
 *
 * 重要:
 * - 画面中央(50%, 50%)を被写体位置として固定しない。
 * - viewCorrectionで構図をパンした場合は、被写体ピンも実際の被写体と同じだけ画面上を移動する。
 * - Cesiumプレビューと同じECEF座標・レンズ中心・FOV・カメラ基底を使う。
 */
export function projectSubjectPinToPreview(
  tripod: GroundPoint,
  subject: GroundPoint,
  camera: CameraSettings,
  aspectRatio: number,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection
): ScreenProjection {
  const { apparent } = createCameraModel(
    tripod,
    subject,
    camera,
    aspectRatio,
    calculationMode,
    viewCorrection
  );

  const subjectEcef = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    ellipsoidalHeightMeters(subject)
  );
  const direction = Cartesian3.subtract(
    subjectEcef,
    apparent.observerEcef,
    new Cartesian3()
  );

  return projectToScreen(direction, {
    right: apparent.ecefRight,
    up: apparent.ecefUp,
    forward: apparent.ecefForward,
    horizontalFovDegrees: apparent.horizontalFovDegrees,
    verticalFovDegrees: apparent.verticalFovDegrees,
  });
}
