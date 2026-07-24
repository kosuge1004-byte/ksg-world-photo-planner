import { sensorDimensionsMm } from "../cesium/camera";
import { calculateElevationAngleDegrees } from "../cesium/geometry";
import { calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import type { CameraSettings } from "../types/camera";
import type { ForegroundObject } from "../types/foreground";
import type { GroundPoint } from "../types/points";

type Props = {
  object: ForegroundObject | null;
  tripod: GroundPoint | null;
  subject: GroundPoint | null;
  camera: CameraSettings;
  aspectRatio: number;
};

export function ForegroundPreviewOverlay({ object, tripod, subject, camera, aspectRatio }: Props) {
  if (!object?.enabled || !tripod || !subject) return null;
  const objectGroundHeight = object.groundHeightMeters;
  if (typeof objectGroundHeight !== "number" || !Number.isFinite(objectGroundHeight)) return null;
  const toSubject = calculateKarneyLineMetrics(tripod, subject);
  const objectBase: GroundPoint = {
    latitude: object.latitude,
    longitude: object.longitude,
    height: objectGroundHeight,
    label: "foreground-base",
  };
  const objectTop: GroundPoint = {
    ...objectBase,
    height: objectGroundHeight + object.heightCm / 100,
    label: "foreground-top",
  };
  const toObject = calculateKarneyLineMetrics(tripod, objectBase);
  if (toObject.distanceMeters < 0.2) return null;
  const sensor=sensorDimensionsMm(aspectRatio);
  const hFov=2*Math.atan(sensor.width/(2*camera.focalLengthMm));
  const vFov=2*Math.atan(sensor.height/(2*camera.focalLengthMm));
  const cameraHeight=tripod.height+camera.lensCenterHeightMeters;
  const observer: GroundPoint = {
    ...tripod,
    height: cameraHeight,
    label: "lens-center",
  };
  const subjectAlt = calculateElevationAngleDegrees(observer, subject) * Math.PI / 180;
  const baseAlt = calculateElevationAngleDegrees(observer, objectBase) * Math.PI / 180;
  const topAlt = calculateElevationAngleDegrees(observer, objectTop) * Math.PI / 180;
  const normalizeAngle = (value: number): number => {
    let normalized = value;
    while (normalized > Math.PI) normalized -= Math.PI * 2;
    while (normalized < -Math.PI) normalized += Math.PI * 2;
    return normalized;
  };
  const x = 50 + normalizeAngle(
    (toObject.bearingDegrees - toSubject.bearingDegrees) * Math.PI / 180
  ) / hFov * 100;
  const yTop=50-(topAlt-subjectAlt)/vFov*100;
  const yBase=50-(baseAlt-subjectAlt)/vFov*100;
  const height=yBase-yTop;
  if(!Number.isFinite(height)||height<=0.02||x< -20||x>120||yBase< -20||yTop>120) return null;
  return <div className="foreground-preview-object" style={{left:`${x}%`,top:`${yTop}%`,height:`${height}%`,width:`${height*.4}%`}} aria-label={`人物 ${object.heightCm}cm`}>
    <svg viewBox="0 0 80 200" preserveAspectRatio="xMidYMax meet"><circle cx="40" cy="22" r="18"/><path d="M26 45 Q40 37 54 45 L62 112 53 112 58 194 43 194 40 126 37 194 22 194 27 112 18 112Z"/></svg>
  </div>;
}
