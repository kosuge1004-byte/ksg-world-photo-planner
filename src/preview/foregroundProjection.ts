import { Cartesian3, Ellipsoid } from "cesium";

import { sensorDimensionsMm } from "../cesium/camera";
import type { CameraSettings } from "../types/camera";
import type { ForegroundObject } from "../types/foreground";
import type { GroundPoint } from "../types/points";

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
  aspectRatio: number
): ForegroundScreenBox | null {
  if (!object.enabled || !Number.isFinite(object.groundHeightMeters)) return null;
  const groundHeightMeters = object.groundHeightMeters as number;
  const observer = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    tripod.height + camera.lensCenterHeightMeters
  );
  const subjectPosition = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    subject.height
  );
  const basePosition = Cartesian3.fromDegrees(
    object.longitude,
    object.latitude,
    groundHeightMeters
  );
  const topPosition = Cartesian3.fromDegrees(
    object.longitude,
    object.latitude,
    groundHeightMeters + object.heightCm / 100
  );

  const forward = Cartesian3.normalize(
    Cartesian3.subtract(subjectPosition, observer, new Cartesian3()),
    new Cartesian3()
  );
  const surfaceNormal = Ellipsoid.WGS84.geodeticSurfaceNormal(
    observer,
    new Cartesian3()
  );
  let right = Cartesian3.cross(forward, surfaceNormal, new Cartesian3());
  if (Cartesian3.magnitudeSquared(right) < 1e-12) {
    right = Cartesian3.cross(forward, Cartesian3.UNIT_Z, new Cartesian3());
  }
  Cartesian3.normalize(right, right);
  const up = Cartesian3.normalize(
    Cartesian3.cross(right, forward, new Cartesian3()),
    new Cartesian3()
  );

  const sensor = sensorDimensionsMm(aspectRatio);
  const horizontalScale = sensor.width / (2 * camera.focalLengthMm);
  const verticalScale = sensor.height / (2 * camera.focalLengthMm);
  if (horizontalScale <= 0 || verticalScale <= 0) return null;

  const project = (position: Cartesian3) => {
    const offset = Cartesian3.subtract(position, observer, new Cartesian3());
    const depth = Cartesian3.dot(offset, forward);
    if (!Number.isFinite(depth) || depth <= 0.05) return null;
    return {
      x: Cartesian3.dot(offset, right) / (depth * horizontalScale),
      y: Cartesian3.dot(offset, up) / (depth * verticalScale),
    };
  };
  const base = project(basePosition);
  const top = project(topPosition);
  if (!base || !top) return null;

  const topPercent = 50 - top.y * 50;
  const basePercent = 50 - base.y * 50;
  const heightPercent = basePercent - topPercent;
  const centerXPercent = 50 + ((base.x + top.x) / 2) * 50;
  // CSSのwidth%は表示枠の横幅基準、height%は縦幅基準なのでaspect比で補正する。
  const widthPercent = heightPercent * PERSON_ASPECT_RATIO / aspectRatio;
  if (
    !Number.isFinite(centerXPercent) ||
    !Number.isFinite(topPercent) ||
    !Number.isFinite(heightPercent) ||
    !Number.isFinite(widthPercent) ||
    heightPercent <= 0.02 ||
    widthPercent <= 0
  ) {
    return null;
  }
  return { centerXPercent, topPercent, heightPercent, widthPercent };
}
