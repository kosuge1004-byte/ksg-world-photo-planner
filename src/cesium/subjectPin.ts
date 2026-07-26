import {
  Cartesian3,
  Cartographic,
  NearFarScalar,
  VerticalOrigin,
  Viewer,
} from "cesium";

import type { GroundPoint } from "../types/points";
import { groundPointFromCoordinates } from "./worldTerrain";

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
  label: string
): Promise<GroundPoint> {
  const originalPosition = Cartesian3.fromDegrees(
    longitude,
    latitude,
    0
  );

  try {
    const positions = await withTimeout(
      viewer.scene.clampToHeightMostDetailed([originalPosition]),
      SUBJECT_CLAMP_TIMEOUT_MS
    );

    const clampedPosition = positions[0];

    if (!clampedPosition) {
      throw new Error("3D表面の高さを取得できませんでした");
    }

    return addVisibleSubjectPin(viewer, clampedPosition, label);
  } catch (error) {
    console.warn(
      "3D表面への被写体ピン配置に失敗。地形標高へフォールバックします。",
      error
    );

    // clampToHeightMostDetailed() はPhotorealistic 3D Tilesが未読込・対象外の場合に
    // undefinedを返すことがある。従来は高さ0mへ落としていたため、被写体が実際の
    // 地表より数十～数百m下に入り、三脚候補計算が全件不成立になっていた。
    // DEMで地表高を取得し、被写体ピンの基準高度を維持する。
    try {
      const groundPoint = await groundPointFromCoordinates(
        latitude,
        longitude,
        label
      );
      return addVisibleSubjectPin(
        viewer,
        Cartesian3.fromDegrees(
          groundPoint.longitude,
          groundPoint.latitude,
          groundPoint.height
        ),
        label
      );
    } catch (terrainError) {
      console.warn(
        "地形標高も取得できないため楕円体高0mを使用します。",
        terrainError
      );
      return addVisibleSubjectPin(
        viewer,
        Cartesian3.fromDegrees(longitude, latitude, 0),
        label
      );
    }
  }
}

export function setSubjectPinFromPosition(
  viewer: Viewer,
  position: Cartesian3,
  label = "3D指定地点"
): GroundPoint {
  return addVisibleSubjectPin(viewer, position, label);
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
