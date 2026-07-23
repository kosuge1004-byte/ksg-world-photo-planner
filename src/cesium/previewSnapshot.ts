import {
  Cartesian3,
  PerspectiveFrustum,
  Viewer,
} from "cesium";

import type { CameraSettings, CameraViewCorrection } from "../types/camera";
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

export async function captureTripodPreview(
  viewer: Viewer,
  previewCanvas: HTMLCanvasElement,
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  viewCorrection?: CameraViewCorrection
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
  const entityVisibility = viewer.entities.values.map((entity) => ({
    entity,
    show: entity.show,
  }));

  try {
    for (const item of entityVisibility) {
      item.entity.show = false;
    }

    setPreviewFromTripodToSubject(
      viewer,
      tripod,
      subject,
      settings,
      aspectRatio,
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
    for (const item of entityVisibility) {
      item.entity.show = item.show;
    }

    restoreCamera(viewer, cameraState);
    // 表示中の3Dマップも同じタスク内で元のカメラへ描き戻し、ちらつきを防ぐ。
    viewer.scene.render();
  }
}
