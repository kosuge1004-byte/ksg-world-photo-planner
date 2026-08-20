export type CameraSettings = {
  focalLengthMm: number;
  /** 地面からレンズ光軸中心までの高さ。 */
  lensCenterHeightMeters: number;
};

/** 現地で確認した構図中心と計算上の被写体中心との差。 */
export type CameraViewCorrection = {
  azimuthDegrees: number;
  altitudeDegrees: number;
};

export const DEFAULT_CAMERA_VIEW_CORRECTION: CameraViewCorrection = {
  azimuthDegrees: 0,
  altitudeDegrees: 0,
};

/**
 * 天体・被写体の屈折計算方式。現行UIでは常にproを使用し、
 * 標準／Googleタイルの差は従量制3Dデータの利用有無だけに限定する。
 */
export type CalculationMode = "standard" | "pro";

export type PreviewFrameMode = "screen" | "landscape-3-2" | "portrait-3-2";

export const FOCAL_LENGTH_MIN = 9;
export const FOCAL_LENGTH_MAX = 1600;

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  focalLengthMm: 24,
  lensCenterHeightMeters: 1.6,
};
