/**
 * 2026-10-15: ARカメラの「カメラ焦点距離補正」。
 *
 * 3D表示の画角は、35mm判換算の焦点距離（対角線基準。スマホのカメラの
 * 公表値「26mm相当」などと同じ定義）から求める。
 *
 * 計算の前提（実機の撮像パイプラインはWebからは見えないため、ここで固定する）:
 * - センサーは4:3。35mm判換算では長辺 43.27mm×0.8 = 34.61mm に相当する。
 * - カメラ映像（getUserMedia）は、センサーの長辺いっぱいを使い、短辺側を
 *   映像の縦横比に合わせて切り出したもの（16:9なら短辺の一部、4:3なら全部）。
 * - 画面には object-fit: cover で表示される（はみ出した側は切り落とし）。
 *
 * 前提と実機が違っても、利用者が「カメラ焦点距離補正」で実景に合わせた値を
 * 保存すれば、その端末ではその値が使われる。
 */

const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);
/** 4:3センサーの長辺を35mm判換算した長さ（対角線基準）。 */
export const EQUIVALENT_LONG_SIDE_MM = FULL_FRAME_DIAGONAL_MM * 0.8;

export const AR_FOCAL_LENGTH_STEP_MM = 0.1;
export const AR_FOCAL_LENGTH_MIN_MM = 10;
export const AR_FOCAL_LENGTH_MAX_MM = 100;
/** ネイティブ情報が無い環境（Web版など）の初期値。スマホのメインカメラの一般的な24〜26mm相当の中間。 */
export const AR_DEFAULT_FOCAL_LENGTH_MM = 25;

const STORAGE_KEY = "ksg-ar-camera-focal-length";

export type ArFocalLengthSource = "manual" | "android-camera2" | "default";

export function roundFocalLengthMm(value: number): number {
  const clamped = Math.min(AR_FOCAL_LENGTH_MAX_MM, Math.max(AR_FOCAL_LENGTH_MIN_MM, value));
  return Math.round(clamped * 10) / 10;
}

/**
 * Androidのカメラ情報（実焦点距離・センサー寸法）から35mm判換算の焦点距離を求める。
 * センサー寸法はセンサー本来の向き（横長）で返るため、縦横に依らず長辺を使う。
 */
export function equivalentFocalLengthFromSensor(input: {
  focalLengthMm: number;
  sensorWidthMm: number | null;
  sensorHeightMm: number | null;
}): number | null {
  const { focalLengthMm, sensorWidthMm, sensorHeightMm } = input;
  if (!Number.isFinite(focalLengthMm) || focalLengthMm <= 0) return null;
  if (!sensorWidthMm || !sensorHeightMm || sensorWidthMm <= 0 || sensorHeightMm <= 0) return null;
  const longSide = Math.max(sensorWidthMm, sensorHeightMm);
  const equivalent = focalLengthMm * EQUIVALENT_LONG_SIDE_MM / longSide;
  return Number.isFinite(equivalent) ? equivalent : null;
}

/**
 * 画面に実際に見えている範囲の画角（度）。
 * videoWidth/videoHeight は表示向きの映像の画素数（縦持ちなら縦長）。
 * 不明なときは画面と同じ縦横比の映像とみなす。
 */
export function displayedFieldOfViewDegrees(input: {
  focalLengthMm: number;
  videoWidth: number | null;
  videoHeight: number | null;
  viewWidth: number;
  viewHeight: number;
}): { horizontalFovDeg: number; verticalFovDeg: number } {
  const viewWidth = Math.max(1, input.viewWidth);
  const viewHeight = Math.max(1, input.viewHeight);
  const videoWidth = input.videoWidth && input.videoWidth > 0 ? input.videoWidth : viewWidth;
  const videoHeight = input.videoHeight && input.videoHeight > 0 ? input.videoHeight : viewHeight;
  const focal = roundFocalLengthMm(input.focalLengthMm);

  // 映像の長辺 = センサーの長辺いっぱい。
  const halfTanLong = EQUIVALENT_LONG_SIDE_MM / (2 * focal);
  const videoLong = Math.max(videoWidth, videoHeight);
  const halfTanVideoX = halfTanLong * videoWidth / videoLong;
  const halfTanVideoY = halfTanLong * videoHeight / videoLong;

  // object-fit: cover。拡大率が大きい側で画面を埋め、もう一方ははみ出して切れる。
  const scale = Math.max(viewWidth / videoWidth, viewHeight / videoHeight);
  const halfTanX = halfTanVideoX * viewWidth / (videoWidth * scale);
  const halfTanY = halfTanVideoY * viewHeight / (videoHeight * scale);

  return {
    horizontalFovDeg: 2 * Math.atan(halfTanX) * 180 / Math.PI,
    verticalFovDeg: 2 * Math.atan(halfTanY) * 180 / Math.PI,
  };
}

type StoredFocalLength = { focalLengthMm: number; cameraLabel: string };

/** 保存済みの補正値。保存時と違うカメラ（ラベルが異なる）なら使わない。 */
export function loadArFocalLength(cameraLabel: string): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredFocalLength>;
    const value = Number(parsed.focalLengthMm);
    if (!Number.isFinite(value)) return null;
    if (typeof parsed.cameraLabel === "string" && parsed.cameraLabel !== cameraLabel) return null;
    return roundFocalLengthMm(value);
  } catch {
    return null;
  }
}

export function saveArFocalLength(focalLengthMm: number, cameraLabel: string): boolean {
  try {
    const stored: StoredFocalLength = { focalLengthMm: roundFocalLengthMm(focalLengthMm), cameraLabel };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}
