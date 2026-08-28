/**
 * ARカメラの方位・上下角センサーは、磁気干渉や端末個体差により、実際の
 * 方角とズレることがある。画面を指でスワイプして、カメラ映像に映る実際の
 * 天体・建物と、3D表示の位置を合わせることで補正できるようにする
 * （src/components/ArCesiumOverlay.tsxのheadingOffsetDegrees/
 * pitchOffsetDegreesに反映される）。補正値は端末内に保存し、次回起動時も
 * 引き継ぐ。
 */

const STORAGE_KEY = "ksg-ar-orientation-offset";

export type ArOrientationOffset = {
  headingOffsetDegrees: number;
  pitchOffsetDegrees: number;
};

const DEFAULT_OFFSET: ArOrientationOffset = {
  headingOffsetDegrees: 0,
  pitchOffsetDegrees: 0,
};

export function loadArOrientationOffset(): ArOrientationOffset {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_OFFSET;
    const parsed = JSON.parse(raw) as Partial<ArOrientationOffset>;
    const heading = Number(parsed.headingOffsetDegrees);
    const pitch = Number(parsed.pitchOffsetDegrees);
    return {
      headingOffsetDegrees: Number.isFinite(heading) ? heading : 0,
      pitchOffsetDegrees: Number.isFinite(pitch) ? pitch : 0,
    };
  } catch {
    return DEFAULT_OFFSET;
  }
}

export function saveArOrientationOffset(offset: ArOrientationOffset): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // 保存に失敗しても、その場での補正自体は有効なままなので致命的ではない。
  }
}
