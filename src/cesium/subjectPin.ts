import {
  Cartesian3,
  Cartographic,
  NearFarScalar,
  VerticalOrigin,
  Viewer,
} from "cesium";

import type { GroundPoint, ResolvedGroundPoint } from "../types/points";
import { publishUserNotice } from "../errors/userFeedback";
import { resolveGroundPoint, resolveGroundPointFrom3dSurface } from "../height/heightResolver";

const SUBJECT_PIN_ID = "ksg-subject-pin";
const SUBJECT_CLAMP_TIMEOUT_MS = 2_500;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("3D表面の高さ取得がタイムアウトしました")),
          timeoutMilliseconds
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const SUBJECT_PIN_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
    <path d="M14 39C11 32 2 24 2 14A12 12 0 0 1 26 14c0 10-9 18-12 25Z" fill="#e53935" stroke="#fff" stroke-width="2"/>
    <circle cx="14" cy="14" r="4.5" fill="#fff"/>
  </svg>
`)}`;

/** 呼び出し元が既に確定させている標高基準（ジオイド高等）。
 * ピン設置時に位置（緯度経度・楕円体高）だけを流用し、この確定済みの
 * メタデータを保つことで、標高の再計算・楕円体高との取り違えを防ぐ。
 * GroundPoint/SubjectRecord等、フィールドが省略されうる型もそのまま
 * 渡せるよう任意項目にしている（揃っていない場合は何も適用しない）。 */
export type HeightMetadata = {
  orthometricHeightMeters?: number;
  geoidHeightMeters?: number;
  heightSource?: GroundPoint["heightSource"];
};

function withHeightMetadata(point: GroundPoint, metadata?: HeightMetadata): GroundPoint {
  if (
    !metadata ||
    !Number.isFinite(metadata.orthometricHeightMeters) ||
    !Number.isFinite(metadata.geoidHeightMeters) ||
    !metadata.heightSource ||
    metadata.heightSource === "legacy"
  ) {
    return point;
  }
  return {
    ...point,
    ellipsoidalHeightMeters: point.height,
    orthometricHeightMeters: metadata.orthometricHeightMeters,
    geoidHeightMeters: metadata.geoidHeightMeters,
    heightSource: metadata.heightSource,
  };
}

function addVisibleSubjectPin(
  viewer: Viewer,
  groundPosition: Cartesian3,
  label: string
): GroundPoint {
  const previous = viewer.entities.getById(SUBJECT_PIN_ID);

  if (previous) {
    viewer.entities.remove(previous);
  }

  // Cesiumのピック結果は描画処理の一時値になり得るため、地理座標を固定して保持する。
  const fixedPosition = Cartesian3.clone(groundPosition);
  const cartographic = Cartographic.fromCartesian(fixedPosition);

  viewer.entities.add({
    id: SUBJECT_PIN_ID,
    name: label,
    position: fixedPosition,
    billboard: {
      image: SUBJECT_PIN_IMAGE,
      // 被写体位置と周辺地形を同時に読めるよう、地図上だけ半分へ縮小する。
      width: 14,
      height: 20,
      verticalOrigin: VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new NearFarScalar(100, 1, 100000, 0.75),
    },
  });

  return {
    latitude: (cartographic.latitude * 180) / Math.PI,
    longitude: (cartographic.longitude * 180) / Math.PI,
    height: cartographic.height,
    label,
  };
}

export async function setSubjectPinFromCoordinates(
  viewer: Viewer,
  latitude: number,
  longitude: number,
  label: string,
  preferExplicit3dSurface = false
): Promise<GroundPoint> {
  if (preferExplicit3dSurface) {
    const originalPosition = Cartesian3.fromDegrees(longitude, latitude, 0);
    try {
      const positions = await withTimeout(
        viewer.scene.clampToHeightMostDetailed([originalPosition]),
        SUBJECT_CLAMP_TIMEOUT_MS
      );
      const clampedPosition = positions[0];
      if (!clampedPosition) throw new Error("3D表面の高さを取得できませんでした");
      const resolved = await resolveGroundPointFrom3dSurface(clampedPosition, label);
      addVisibleSubjectPin(
        viewer,
        Cartesian3.fromDegrees(resolved.longitude, resolved.latitude, resolved.ellipsoidalHeightMeters),
        label
      );
      return resolved;
    } catch (error) {
      console.warn("明示的に選択した3D表面高を取得できないためDEMへフォールバックします", error);
      publishUserNotice({
        key: "subject-pin-3d-fallback",
        tone: "warning",
        message: "選択した3D表面の高さを取得できないため、地形データの高さで被写体ピンを配置します。",
      });
    }
  }

  try {
    const groundPoint = await resolveGroundPoint(latitude, longitude, label);
    return withHeightMetadata(
      addVisibleSubjectPin(
        viewer,
        Cartesian3.fromDegrees(groundPoint.longitude, groundPoint.latitude, groundPoint.height),
        label
      ),
      groundPoint
    );
  } catch (terrainError) {
    console.warn("被写体ピンの高度を確定できないため配置を中止します", terrainError);
    publishUserNotice({
      key: "subject-pin-height-required",
      tone: "error",
      message: "地形高度を取得できないため被写体ピンを配置できません。通信状態を確認して再試行してください。",
    });
    throw terrainError;
  }
}

/**
 * 3D明示選択（scene.pickPosition等が返した実表面）専用。HeightResolverの
 * resolveGroundPointFrom3dSurface()だけを経由し、DEMへのフォールバックは
 * 行わない（失敗時は再クリックを要求する）。
 */
export async function setSubjectPinFromExplicit3dPick(
  viewer: Viewer,
  position: Cartesian3,
  label = "3D指定地点"
): Promise<ResolvedGroundPoint> {
  const resolved = await resolveGroundPointFrom3dSurface(position, label);
  addVisibleSubjectPin(
    viewer,
    Cartesian3.fromDegrees(resolved.longitude, resolved.latitude, resolved.ellipsoidalHeightMeters),
    label
  );
  return resolved;
}

export function setSubjectPinFromPosition(
  viewer: Viewer,
  position: Cartesian3,
  label = "3D指定地点",
  heightMetadata?: HeightMetadata
): GroundPoint {
  return withHeightMetadata(addVisibleSubjectPin(viewer, position, label), heightMetadata);
}

export function getSubjectPinPoint(viewer: Viewer): GroundPoint | null {
  const entity = viewer.entities.getById(SUBJECT_PIN_ID);
  const value = entity?.position?.getValue(viewer.clock.currentTime);
  if (!value) return null;
  const cartographic = Cartographic.fromCartesian(value);
  return {
    latitude: (cartographic.latitude * 180) / Math.PI,
    longitude: (cartographic.longitude * 180) / Math.PI,
    height: cartographic.height,
    label: entity?.name ?? "現在の被写体ピン",
  };
}
