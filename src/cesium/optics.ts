const FULL_FRAME_SENSOR_WIDTH_MM = 36;
const FULL_FRAME_SENSOR_HEIGHT_MM = 24;

/** 36x24mmフルサイズ内へ指定アスペクト比を内接させる共通撮像領域。 */
export function sensorDimensionsMm(aspectRatio: number): { width: number; height: number } {
  const safeAspect = Math.max(0.2, aspectRatio);
  const height = Math.min(
    FULL_FRAME_SENSOR_HEIGHT_MM,
    FULL_FRAME_SENSOR_WIDTH_MM / safeAspect
  );
  return { width: height * safeAspect, height };
}
