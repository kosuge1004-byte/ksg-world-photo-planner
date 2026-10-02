import type { ArOrientationOffset } from "./orientationOffset";

const FALLBACK_HORIZONTAL_FOV_DEGREES = 60;

type CameraProjectionLike = {
  horizontalFovDeg: number;
  verticalFovDeg: number;
} | null;

function fallbackVerticalFovDegrees(width: number, height: number): number {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const horizontalRadians = FALLBACK_HORIZONTAL_FOV_DEGREES * Math.PI / 180;
  return 2 * Math.atan(
    Math.tan(horizontalRadians / 2) * safeHeight / safeWidth
  ) * 180 / Math.PI;
}

/**
 * Converts an on-screen drag into the persistent heading/pitch correction.
 * Camera2 metadata is preferable, but manual calibration must still work on
 * WebViews that cannot safely identify the active rear-camera ID.
 */
export function orientationOffsetFromSwipe(input: {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  stageWidth: number;
  stageHeight: number;
  startOffset: ArOrientationOffset;
  projection: CameraProjectionLike;
}): ArOrientationOffset {
  const width = Math.max(1, input.stageWidth);
  const height = Math.max(1, input.stageHeight);
  const horizontalFov = input.projection?.horizontalFovDeg ?? FALLBACK_HORIZONTAL_FOV_DEGREES;
  const verticalFov = input.projection?.verticalFovDeg ?? fallbackVerticalFovDegrees(width, height);
  const dxDegrees = ((input.currentX - input.startX) / width) * horizontalFov;
  const dyDegrees = ((input.currentY - input.startY) / height) * verticalFov;
  return {
    headingOffsetDegrees: input.startOffset.headingOffsetDegrees - dxDegrees,
    pitchOffsetDegrees: input.startOffset.pitchOffsetDegrees - dyDegrees,
  };
}
