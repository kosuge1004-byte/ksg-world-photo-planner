import {
  Cartesian3,
  PerspectiveFrustum,
  Viewer,
} from "cesium";

import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { setPreviewFromTripodToSubject } from "./camera";

type CameraState = {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  fov?: number;
  aspectRatio?: number;
};

function saveCamera(viewer: Viewer): CameraState {
  const frustum = viewer.camera.frustum;

  return {
    position: Cartesian3.clone(viewer.camera.positionWC),
    direction: Cartesian3.clone(viewer.camera.directionWC),
    up: Cartesian3.clone(viewer.camera.upWC),
    fov:
      frustum instanceof PerspectiveFrustum
        ? frustum.fov
        : undefined,
    aspectRatio:
      frustum instanceof PerspectiveFrustum
        ? frustum.aspectRatio
        : undefined,
  };
}

function restoreCamera(
  viewer: Viewer,
  state: CameraState
): void {
  viewer.camera.setView({
    destination: state.position,
    orientation: {
      direction: state.direction,
      up: state.up,
    },
  });

  const frustum = viewer.camera.frustum;

  if (frustum instanceof PerspectiveFrustum) {
    if (state.fov !== undefined) {
      frustum.fov = state.fov;
    }

    if (state.aspectRatio !== undefined) {
      frustum.aspectRatio = state.aspectRatio;
    }
  }
}

/**
 * 太陽・月の3D合成焼き込みは、平面オーバーレイの透明度スライダーと二重表示に
 * なり、常時オンだと見た目が複雑になりすぎるため撤去した。天体は
 * CelestialOverlay（平面オーバーレイ）のみで表示する。
 */

export async function captureTripodPreview(
  viewer: Viewer,
  previewCanvas: HTMLCanvasElement,
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection,
  restoreVisibleScene = true
): Promise<void> {
  if (viewer.isDestroyed()) {
    return;
  }

  const cssWidth = Math.max(1, previewCanvas.clientWidth);
  const cssHeight = Math.max(1, previewCanvas.clientHeight);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  previewCanvas.width = Math.round(cssWidth * pixelRatio);
  previewCanvas.height = Math.round(cssHeight * pixelRatio);

  const context = previewCanvas.getContext("2d");

  if (!context) {
    throw new Error("プレビューCanvasを初期化できませんでした");
  }

  const cameraState = saveCamera(viewer);
  const aspectRatio = cssWidth / cssHeight;

  // プレビュー撮影時に全Entityのshowを1件ずつ切り替えると、Entityごとの
  // definitionChanged通知が大量に発生し、メイン3Dマップの描画とタイル更新を
  // 不要に刺激する。DefaultDataSource全体を1回だけ非表示にすれば、見た目は
  // 従来と同じままイベント量を大幅に減らせる。
  const defaultDataSource = viewer.dataSourceDisplay.defaultDataSource;
  const defaultDataSourceWasVisible = defaultDataSource.show;

  try {
    defaultDataSource.show = false;

    setPreviewFromTripodToSubject(
      viewer,
      tripod,
      subject,
      settings,
      aspectRatio,
      calculationMode,
      viewCorrection
    );

    // メイン3Dカメラをフレーム間で占有すると、ユーザー操作後に古い姿勢へ
    // 復元されてピンが動いたように見える。撮影と復元を同一タスク内で完了する。
    viewer.scene.render();

    context.clearRect(
      0,
      0,
      previewCanvas.width,
      previewCanvas.height
    );

    context.drawImage(
      viewer.canvas,
      0,
      0,
      viewer.canvas.width,
      viewer.canvas.height,
      0,
      0,
      previewCanvas.width,
      previewCanvas.height
    );
  } finally {
    defaultDataSource.show = defaultDataSourceWasVisible;

    restoreCamera(viewer, cameraState);
    // 3Dマップが実際に表示されている時だけ復元フレームを即描画する。
    // 2D表示中はCesium自体を休止しているため、不可視の1フレームを描く必要はない。
    if (restoreVisibleScene) viewer.scene.render();
  }
}
