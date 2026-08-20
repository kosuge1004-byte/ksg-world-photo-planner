import { Capacitor, registerPlugin } from "@capacitor/core";

type AndroidRearCamera = {
  cameraId: string;
  focalLengthsMm: number[];
  sensorWidthMm: number | null;
  sensorHeightMm: number | null;
  activeArrayWidthPx: number | null;
  activeArrayHeightPx: number | null;
};

type AstroSightCameraInfoPlugin = {
  getRearCameras(): Promise<{ cameras: AndroidRearCamera[] }>;
};

const NativeCameraInfo = registerPlugin<AstroSightCameraInfoPlugin>("AstroSightCameraInfo");

export async function getAndroidRearCameraInfo(): Promise<AndroidRearCamera[]> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return [];
  try {
    const result = await NativeCameraInfo.getRearCameras();
    return Array.isArray(result.cameras) ? result.cameras : [];
  } catch {
    return [];
  }
}

export function matchAndroidCameraFromLabel(
  label: string,
  cameras: AndroidRearCamera[]
): AndroidRearCamera | null {
  const normalized = label.toLowerCase();
  const exact = cameras.find((camera) => {
    const id = camera.cameraId.toLowerCase();
    return (
      normalized.includes(`camera2 ${id}`) ||
      normalized.includes(`camera ${id}`) ||
      normalized.includes(`cameraid=${id}`) ||
      normalized.includes(`cameraid ${id}`)
    );
  });
  return exact ?? null;
}

export function computeCameraFovDegrees(camera: AndroidRearCamera): {
  horizontal: number;
  vertical: number;
  focalLengthMm: number;
} | null {
  const focalLengthMm = camera.focalLengthsMm[0];
  if (
    !Number.isFinite(focalLengthMm) || focalLengthMm <= 0 ||
    !camera.sensorWidthMm || !camera.sensorHeightMm ||
    camera.sensorWidthMm <= 0 || camera.sensorHeightMm <= 0
  ) {
    return null;
  }
  return {
    horizontal: 2 * Math.atan(camera.sensorWidthMm / (2 * focalLengthMm)) * 180 / Math.PI,
    vertical: 2 * Math.atan(camera.sensorHeightMm / (2 * focalLengthMm)) * 180 / Math.PI,
    focalLengthMm,
  };
}
