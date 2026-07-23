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

/**
 * standard は幾何学的な天体位置、pro は標準大気モデルによる大気差補正を使う。
 * 実測の気温・気圧が未入力のため、Proでも現地気象に固有の補正ではない。
 */
export type CalculationMode = "standard" | "pro";

export type PreviewFrameMode = "screen" | "landscape-3-2" | "portrait-3-2";

export const FOCAL_LENGTH_MIN = 9;
export const FOCAL_LENGTH_MAX = 1600;

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  focalLengthMm: 24,
  lensCenterHeightMeters: 1.6,
};
