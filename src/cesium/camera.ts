import {
  BoundingSphere,
  Cartesian3,
  Ellipsoid,
  HeadingPitchRange,
  Math as CesiumMath,
  PerspectiveFrustum,
  Viewer,
} from "cesium";

import type {
  CameraSettings,
  CameraViewCorrection,
} from "../types/camera";
import { calculateLineMetrics } from "./geometry";
import type { GroundPoint } from "../types/points";

const FULL_FRAME_SENSOR_WIDTH_MM = 36;

export function sensorDimensionsMm(
  aspectRatio: number
): { width: number; height: number } {
  const longEdge = FULL_FRAME_SENSOR_WIDTH_MM;
  const safeAspect = Math.max(0.2, aspectRatio);
  // 36×24mmの長辺を基準にし、縦構図では36mmが縦方向になるようセンサーを回転する。
  return safeAspect >= 1
    ? { width: longEdge, height: longEdge / safeAspect }
    : { width: longEdge * safeAspect, height: longEdge };
}

export function flyMapToTarget(
  viewer: Viewer,
  latitude: number,
  longitude: number
): void {
  const targetPosition = Cartesian3.fromDegrees(
    longitude,
    latitude,
    0
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
  viewCorrection?: CameraViewCorrection
): void {
  const cameraPosition = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    tripod.height + settings.lensCenterHeightMeters
  );

  const targetPosition = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    subject.height
  );

  const direction = Cartesian3.normalize(
    Cartesian3.subtract(
      targetPosition,
      cameraPosition,
      new Cartesian3()
    ),
    new Cartesian3()
  );

  const surfaceNormal = Ellipsoid.WGS84.geodeticSurfaceNormal(
    cameraPosition,
    new Cartesian3()
  );

  let right = Cartesian3.cross(
    direction,
    surfaceNormal,
    new Cartesian3()
  );

  if (Cartesian3.magnitudeSquared(right) < 1e-12) {
    right = Cartesian3.cross(
      direction,
      Cartesian3.UNIT_Z,
      new Cartesian3()
    );
  }

  Cartesian3.normalize(right, right);

  const up = Cartesian3.normalize(
    Cartesian3.cross(right, direction, new Cartesian3()),
    new Cartesian3()
  );

  if (viewCorrection) {
    const line = calculateLineMetrics(tripod, subject);
    const cameraAltitude = Math.asin(Math.max(
      -1,
      Math.min(1, Cartesian3.dot(direction, surfaceNormal))
    ));
    viewer.camera.setView({
      destination: cameraPosition,
      orientation: {
        heading: CesiumMath.toRadians(
          line.bearingDegrees + viewCorrection.azimuthDegrees
        ),
        pitch: cameraAltitude + CesiumMath.toRadians(
          viewCorrection.altitudeDegrees
        ),
        roll: 0,
      },
    });
  } else {
    viewer.camera.setView({
      destination: cameraPosition,
      orientation: {
        direction,
        up,
      },
    });
  }

  applyPreviewFocalLength(viewer, settings, aspectRatio);
}
