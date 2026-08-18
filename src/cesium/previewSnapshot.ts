import {
  Cartesian3,
  Color,
  Matrix4,
  PerspectiveFrustum,
  Transforms,
  Viewer,
} from "cesium";

import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import type { CelestialScreenPoint } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { createCameraModel } from "./cameraModelFactory";
import { setPreviewFromTripodToSubject } from "./camera";
import { horizontalDirectionToVec3 } from "../projection/projectionService";

const BAKED_CELESTIAL_RAY_METERS = 1_000_000;
const BAKED_CELESTIAL_ENTITY_PREFIX = "astrosight-preview-baked-celestial-";
/** このプレビュー静止画には、視覚的な奥行き合成（建物への隠れ方）だけを目的として
 * 太陽・月を焼き込む。判定・計算には一切使わない（あくまで見た目のみ）。 */
const BAKED_CELESTIAL_IDS: ReadonlyArray<"sun" | "moon"> = ["sun", "moon"];

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
 * 太陽・月を、実際の方位・高度方向へ十分遠方の点として3Dシーンへ一時的に追加する。
 * 深度テストは無効化しない（＝手前に建物があれば自然にその建物へ隠れる）。
 * これは撮影する静止画の「見た目」だけの効果であり、遮蔽の判定・計算には使わない
 * （Google/PLATEAUいずれの3D形状データも読み取らない。通常の描画合成と同じ）。
 */
function addBakedCelestialEntities(
  viewer: Viewer,
  observerEcef: Cartesian3,
  points: CelestialScreenPoint[]
): void {
  for (const id of BAKED_CELESTIAL_IDS) {
    const point = points.find((candidate) => candidate.id === id && candidate.visibleInFrame);
    if (!point) continue;
    const vec = horizontalDirectionToVec3(point.azimuthDegrees, point.altitudeDegrees);
    const localDirection = new Cartesian3(vec.x, vec.y, vec.z);
    const localFrame = Transforms.eastNorthUpToFixedFrame(observerEcef);
    const worldDirection = Cartesian3.normalize(
      Matrix4.multiplyByPointAsVector(localFrame, localDirection, new Cartesian3()),
      new Cartesian3()
    );
    const position = Cartesian3.add(
      observerEcef,
      Cartesian3.multiplyByScalar(worldDirection, BAKED_CELESTIAL_RAY_METERS, new Cartesian3()),
      new Cartesian3()
    );
    viewer.entities.add({
      id: `${BAKED_CELESTIAL_ENTITY_PREFIX}${id}`,
      position,
      point: {
        pixelSize: id === "sun" ? 26 : 20,
        color: id === "sun" ? Color.fromCssColorString("#fff3c4") : Color.fromCssColorString("#e9edf2"),
        // disableDepthTestDistanceを指定しない＝通常の深度テストのまま。
        // 手前に建物（PLATEAU／Googleタイル、いずれも表示のみ）があれば隠れる。
      },
    });
  }
}

function removeBakedCelestialEntities(viewer: Viewer): void {
  for (const id of BAKED_CELESTIAL_IDS) {
    const entity = viewer.entities.getById(`${BAKED_CELESTIAL_ENTITY_PREFIX}${id}`);
    if (entity) viewer.entities.remove(entity);
  }
}

export async function captureTripodPreview(
  viewer: Viewer,
  previewCanvas: HTMLCanvasElement,
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection,
  celestialPoints?: CelestialScreenPoint[]
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
      calculationMode,
      viewCorrection
    );

    if (celestialPoints && celestialPoints.length > 0) {
      const { apparent } = createCameraModel(
        tripod, subject, settings, aspectRatio, calculationMode, viewCorrection
      );
      addBakedCelestialEntities(viewer, apparent.observerEcef, celestialPoints);
    }

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
    removeBakedCelestialEntities(viewer);
    for (const item of entityVisibility) {
      item.entity.show = item.show;
    }

    restoreCamera(viewer, cameraState);
    // 表示中の3Dマップも同じタスク内で元のカメラへ描き戻し、ちらつきを防ぐ。
    viewer.scene.render();
  }
}
