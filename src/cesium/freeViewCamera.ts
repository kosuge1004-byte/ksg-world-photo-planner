/**
 * 自由ビューモード（2026-10-09）のカメラ操作。
 *
 * 視点（緯度・経度・高さ）は固定し、方位角・仰角・焦点距離だけを変える。
 * 被写体・端末センサー（ジャイロ・GPS・DeviceOrientation）は一切使わない。
 * 方向基底と画角は cameraModelFactory.createFreeViewCameraModel が唯一の生成元で、
 * Cesiumの実カメラ（ここ）と天体の投影（celestial.ts）が同じモデルを参照する。
 */
import { Cartesian3, PerspectiveFrustum, type Viewer } from "cesium";

import type { CameraSettings } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { applyPreviewFocalLength } from "./camera";
import { createFreeViewCameraModel, type GeometryCameraModel } from "./cameraModelFactory";

export const FREE_VIEW_MIN_FOCAL_LENGTH_MM = 9;
export const FREE_VIEW_MAX_FOCAL_LENGTH_MM = 1600;
/** 真上・真下では方位が定まらなくなるため、手前で止める。 */
export const FREE_VIEW_MAX_PITCH_DEGREES = 89;
export const FREE_VIEW_MIN_PITCH_DEGREES = -89;

export type FreeViewPose = {
  headingDegrees: number;
  pitchDegrees: number;
};

export function normalizeFreeViewHeadingDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = ((value % 360) + 360) % 360;
  // 359.99999…が丸めで360になる場合を0へそろえる（0 <= heading < 360）。
  return normalized >= 360 ? 0 : normalized;
}

export function clampFreeViewPitchDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(FREE_VIEW_MIN_PITCH_DEGREES, Math.min(FREE_VIEW_MAX_PITCH_DEGREES, value));
}

export function clampFreeViewFocalLengthMm(value: number): number {
  if (!Number.isFinite(value)) return 24;
  return Math.max(FREE_VIEW_MIN_FOCAL_LENGTH_MM, Math.min(FREE_VIEW_MAX_FOCAL_LENGTH_MM, value));
}

/**
 * 1本指ドラッグ後の向き。
 * 景色が指に付いてくる向き（Google Earthと同じ）: 指を左へ動かすと景色が左へ流れ、
 * 視線は右（方位が増える側）へ回る。指を下へ動かすと視線は上を向く。
 * 回転量は「画面の幅＝水平画角」「画面の高さ＝垂直画角」の比で決めるので、
 * 望遠（画角が狭い）ほど同じ指の移動でも回転は小さくなり、景色と指がずれない。
 */
export function freeViewPoseAfterDrag(
  start: FreeViewPose,
  deltaXPixels: number,
  deltaYPixels: number,
  viewport: { widthPixels: number; heightPixels: number },
  fov: { horizontalFovDegrees: number; verticalFovDegrees: number }
): FreeViewPose {
  const width = Math.max(1, viewport.widthPixels);
  const height = Math.max(1, viewport.heightPixels);
  return {
    headingDegrees: normalizeFreeViewHeadingDegrees(
      start.headingDegrees - (deltaXPixels / width) * fov.horizontalFovDegrees
    ),
    pitchDegrees: clampFreeViewPitchDegrees(
      start.pitchDegrees + (deltaYPixels / height) * fov.verticalFovDegrees
    ),
  };
}

/** 2本指ピンチ後の焦点距離。指の間隔が2倍なら焦点距離も2倍（位置は動かさない）。 */
export function freeViewFocalLengthAfterPinch(
  startFocalLengthMm: number,
  startDistancePixels: number,
  currentDistancePixels: number
): number {
  if (!(startDistancePixels > 0) || !(currentDistancePixels > 0)) {
    return clampFreeViewFocalLengthMm(startFocalLengthMm);
  }
  return clampFreeViewFocalLengthMm(startFocalLengthMm * currentDistancePixels / startDistancePixels);
}

export type FreeViewCameraInput = FreeViewPose & {
  observer: GroundPoint;
  lensCenterHeightMeters: number;
  focalLengthMm: number;
  aspectRatio: number;
};

export function freeViewCameraModel(input: FreeViewCameraInput): GeometryCameraModel {
  return createFreeViewCameraModel(
    input.observer,
    normalizeFreeViewHeadingDegrees(input.headingDegrees),
    clampFreeViewPitchDegrees(input.pitchDegrees),
    input.lensCenterHeightMeters,
    clampFreeViewFocalLengthMm(input.focalLengthMm),
    Math.max(0.2, input.aspectRatio)
  );
}

/**
 * モデルをCesiumの実カメラへ反映する。位置（destination）は常にモデルの視点ECEFで、
 * 向きの変更で位置が動くことはない。画角は撮影プレビューと同じ
 * applyPreviewFocalLength（36x24mm内接）で設定する。
 */
export function applyFreeViewCamera(
  viewer: Viewer,
  model: GeometryCameraModel,
  focalLengthMm: number,
  aspectRatio: number
): void {
  viewer.camera.setView({
    destination: model.observerEcef,
    orientation: {
      heading: model.headingRadians,
      pitch: model.pitchRadians,
      roll: model.rollRadians,
    },
  });
  applyPreviewFocalLength(
    viewer,
    { focalLengthMm: clampFreeViewFocalLengthMm(focalLengthMm) } as CameraSettings,
    aspectRatio
  );
}

export type FreeViewViewerSnapshot = {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  frustumFov: number | null;
  frustumAspectRatio: number | null;
  controller: {
    enableInputs: boolean;
    enableRotate: boolean;
    enableTranslate: boolean;
    enableZoom: boolean;
    enableTilt: boolean;
    enableLook: boolean;
  };
};

/** 自由ビューに入る直前のカメラと操作状態。閉じる時に restoreFreeViewViewer で戻す。 */
export function captureFreeViewViewerSnapshot(viewer: Viewer): FreeViewViewerSnapshot {
  const frustum = viewer.camera.frustum;
  const controller = viewer.scene.screenSpaceCameraController;
  return {
    position: Cartesian3.clone(viewer.camera.positionWC),
    direction: Cartesian3.clone(viewer.camera.directionWC),
    up: Cartesian3.clone(viewer.camera.upWC),
    frustumFov: frustum instanceof PerspectiveFrustum ? frustum.fov ?? null : null,
    frustumAspectRatio: frustum instanceof PerspectiveFrustum ? frustum.aspectRatio ?? null : null,
    controller: {
      enableInputs: controller.enableInputs,
      enableRotate: controller.enableRotate,
      enableTranslate: controller.enableTranslate,
      enableZoom: controller.enableZoom,
      enableTilt: controller.enableTilt,
      enableLook: controller.enableLook,
    },
  };
}

/** 自由ビュー中はCesium標準の移動・回転・ズーム操作をすべて止める。 */
export function lockFreeViewViewerInputs(viewer: Viewer): void {
  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableInputs = false;
}

export function restoreFreeViewViewer(viewer: Viewer, snapshot: FreeViewViewerSnapshot): void {
  viewer.camera.setView({
    destination: snapshot.position,
    orientation: { direction: snapshot.direction, up: snapshot.up },
  });
  const frustum = viewer.camera.frustum;
  if (frustum instanceof PerspectiveFrustum) {
    if (snapshot.frustumFov !== null) frustum.fov = snapshot.frustumFov;
    if (snapshot.frustumAspectRatio !== null) frustum.aspectRatio = snapshot.frustumAspectRatio;
  }
  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableInputs = snapshot.controller.enableInputs;
  controller.enableRotate = snapshot.controller.enableRotate;
  controller.enableTranslate = snapshot.controller.enableTranslate;
  controller.enableZoom = snapshot.controller.enableZoom;
  controller.enableTilt = snapshot.controller.enableTilt;
  controller.enableLook = snapshot.controller.enableLook;
}
