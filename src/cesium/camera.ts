import {
  BoundingSphere,
  Cartesian3,
  HeadingPitchRange,
  Math as CesiumMath,
  PerspectiveFrustum,
  Viewer,
} from "cesium";

import type {
  CalculationMode,
  CameraSettings,
  CameraViewCorrection,
} from "../types/camera";
import type { GroundPoint } from "../types/points";
import { createCameraModel } from "./cameraModelFactory";

export { sensorDimensionsMm } from "./optics";
import { sensorDimensionsMm } from "./optics";

export function flyMapToTarget(
  viewer: Viewer,
  latitude: number,
  longitude: number,
  heightMeters = 0
): void {
  // 高山などでは標高0mを中心にすると実際のピンが画面外へずれるため、
  // ピン自身の標高をカメラの注視中心として使用する。
  const targetPosition = Cartesian3.fromDegrees(
    longitude,
    latitude,
    Number.isFinite(heightMeters) ? heightMeters : 0
  );

  viewer.camera.flyToBoundingSphere(
    new BoundingSphere(targetPosition, 1),
    {
      duration: 2.5,
      offset: new HeadingPitchRange(
        CesiumMath.toRadians(0),
        CesiumMath.toRadians(-35),
        1200
      ),
    }
  );
}

export function applyPreviewFocalLength(
  viewer: Viewer,
  settings: CameraSettings,
  aspectRatio: number
): void {
  const frustum = viewer.camera.frustum;

  if (!(frustum instanceof PerspectiveFrustum)) {
    return;
  }

  const safeAspect = Math.max(0.2, aspectRatio);
  const sensor = sensorDimensionsMm(safeAspect);
  frustum.aspectRatio = safeAspect;
  // Cesiumは横長なら水平FOV、縦長なら垂直FOVとしてfovを解釈する。
  const fovDimension = safeAspect >= 1 ? sensor.width : sensor.height;
  frustum.fov =
    2 * Math.atan(fovDimension / (2 * settings.focalLengthMm));
}

export function setPreviewFromTripodToSubject(
  viewer: Viewer,
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  aspectRatio: number,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection
): void {
  // 実カメラの指向はCameraModelFactoryのApparent（見かけ仰角込み）モデルに一致させる。
  const { apparent } = createCameraModel(
    tripod, subject, settings, aspectRatio, calculationMode, viewCorrection
  );

  viewer.camera.setView({
    destination: apparent.observerEcef,
    orientation: {
      heading: apparent.headingRadians,
      pitch: apparent.pitchRadians,
      roll: apparent.rollRadians,
    },
  });

  applyPreviewFocalLength(viewer, settings, aspectRatio);
}
