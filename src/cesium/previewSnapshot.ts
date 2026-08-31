import {
  Cartesian2,
  Cartesian3,
  PerspectiveFrustum,
  Viewer,
} from "cesium";

import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { setPreviewFromTripodToSubject } from "./camera";
import { pickSceneSurfacePosition } from "./surfacePicking";

type CameraState = {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  fov?: number;
  aspectRatio?: number;
};


const PREVIEW_TILE_WAIT_TIMEOUT_MS = 8_000;
const PREVIEW_TILE_RENDER_INTERVAL_MS = 80;

type LoadAwarePrimitive = {
  show?: boolean;
  tilesLoaded?: boolean;
  isDestroyed?: () => boolean;
};

function visiblePreviewTilesLoaded(viewer: Viewer): boolean {
  const scene = viewer.scene;
  const globe = scene.globe;
  const globeLoaded = !globe.show || globe.tilesLoaded;

  let loadAwarePrimitiveCount = 0;
  let loadAwarePrimitivesLoaded = true;
  for (let index = 0; index < scene.primitives.length; index += 1) {
    const primitive = scene.primitives.get(index) as LoadAwarePrimitive | undefined;
    if (!primitive || primitive.show === false) continue;
    if (typeof primitive.isDestroyed === "function" && primitive.isDestroyed()) continue;
    if (typeof primitive.tilesLoaded !== "boolean") continue;
    loadAwarePrimitiveCount += 1;
    if (!primitive.tilesLoaded) loadAwarePrimitivesLoaded = false;
  }

  return globeLoaded &&
    (loadAwarePrimitiveCount === 0 || loadAwarePrimitivesLoaded);
}

function copyViewerFrameToPreview(
  viewer: Viewer,
  previewCanvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D
): void {
  context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
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
}

async function waitForPreviewTiles(
  viewer: Viewer,
  previewCanvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D
): Promise<void> {
  const startedAt = performance.now();

  // Cesiumの自動描画ループはAstroSight側で停止している。したがって
  // プレビュー視点へカメラを移しただけでは、その視点に必要な3D Tiles/地形の
  // リクエストとLOD更新が継続しない。現在のプレビュー視点を維持して明示的に
  // renderを回し、各フレームを上側Canvasへ逐次転写する。これにより、タイルが
  // 1つでも到着した時点で自動的に画面へ現れ、焦点距離の+/-操作を再描画
  // トリガーとして使う必要がなくなる。
  while (!viewer.isDestroyed()) {
    viewer.scene.requestRender();
    viewer.scene.render();
    copyViewerFrameToPreview(viewer, previewCanvas, context);

    if (visiblePreviewTilesLoaded(viewer)) return;
    if (performance.now() - startedAt >= PREVIEW_TILE_WAIT_TIMEOUT_MS) return;

    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, PREVIEW_TILE_RENDER_INTERVAL_MS)
    );
  }
}

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

    // Cesiumはこのアプリでは自動描画ループを停止しているため、プレビュー視点へ
    // 移動した直後の1フレームだけでは3D Tiles/地形がまだ未取得のことがある。
    // 現在のプレビュー視点を維持したまま必要タイルの読込を明示的に進めてから
    // Canvasへ転写する。これにより初回の黒画面を自動的に解消する。
    await waitForPreviewTiles(viewer, previewCanvas, context);
  } finally {
    defaultDataSource.show = defaultDataSourceWasVisible;

    restoreCamera(viewer, cameraState);
    // 3Dマップが実際に表示されている時だけ復元フレームを即描画する。
    // 2D表示中はCesium自体を休止しているため、不可視の1フレームを描く必要はない。
    if (restoreVisibleScene) viewer.scene.render();
  }
}

/**
 * 上側の三脚視点プレビューでタップした画素から、描画に使ったものと同じ
 * Cesiumカメラ・フラスタムを再現して3D表面座標を取得する。
 *
 * 2D地図の緯度経度や楕円体への代替は行わない。depth pickに失敗した場合は
 * nullを返し、呼び出し側で再指定を求める。これにより建物先端・屋根・山頂を
 * 地表へ丸めず、既存の明示的3D pick経路へそのまま渡せる。
 */
export function pickTripodPreviewSurface(
  viewer: Viewer,
  previewCanvas: HTMLCanvasElement,
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  calculationMode: CalculationMode,
  viewCorrection: CameraViewCorrection | undefined,
  xPercent: number,
  yPercent: number
): Cartesian3 | null {
  if (viewer.isDestroyed()) return null;

  const cssWidth = Math.max(1, previewCanvas.clientWidth);
  const cssHeight = Math.max(1, previewCanvas.clientHeight);
  const cameraState = saveCamera(viewer);
  const defaultDataSource = viewer.dataSourceDisplay.defaultDataSource;
  const defaultDataSourceWasVisible = defaultDataSource.show;

  try {
    defaultDataSource.show = false;
    setPreviewFromTripodToSubject(
      viewer,
      tripod,
      subject,
      settings,
      cssWidth / cssHeight,
      calculationMode,
      viewCorrection
    );
    viewer.scene.render();

    const viewerWidth = Math.max(1, viewer.canvas.clientWidth);
    const viewerHeight = Math.max(1, viewer.canvas.clientHeight);
    const screenPosition = new Cartesian2(
      Math.min(100, Math.max(0, xPercent)) / 100 * viewerWidth,
      Math.min(100, Math.max(0, yPercent)) / 100 * viewerHeight
    );
    const picked = pickSceneSurfacePosition(viewer, screenPosition);
    return picked ? Cartesian3.clone(picked) : null;
  } finally {
    defaultDataSource.show = defaultDataSourceWasVisible;
    restoreCamera(viewer, cameraState);
  }
}
