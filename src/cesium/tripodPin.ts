import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  HorizontalOrigin,
  LabelGraphics,
  LabelStyle,
  NearFarScalar,
  VerticalOrigin,
  Viewer,
} from "cesium";

import type { GroundPoint } from "../types/points";
import { groundPointFromCoordinates } from "./worldTerrain";

const TRIPOD_PIN_ID = "ksg-tripod-pin";
const TRIPOD_PIN_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
    <path d="M14 39C11 32 2 24 2 14A12 12 0 0 1 26 14c0 10-9 18-12 25Z" fill="#1976d2" stroke="#fff" stroke-width="2"/>
    <circle cx="14" cy="14" r="4.5" fill="#fff"/>
  </svg>
`)}`;

export function setTripodPin(
  viewer: Viewer,
  position: Cartesian3
): GroundPoint {
  const previous = viewer.entities.getById(TRIPOD_PIN_ID);

  if (previous) {
    viewer.entities.remove(previous);
  }

  // pickPositionが返す一時Cartesianをカメラ操作後も参照しないよう固定値へ複製する。
  const fixedPosition = Cartesian3.clone(position);
  const cartographic = Cartographic.fromCartesian(fixedPosition);

  viewer.entities.add({
    id: TRIPOD_PIN_ID,
    name: "三脚ピン",
    position: fixedPosition,
    billboard: {
      image: TRIPOD_PIN_IMAGE,
      // 地図を隠さないよう、Googleマップ相当だった従来表示から半分へ縮小する。
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
    label: "三脚ピン",
  };
}

export async function setTripodPinFromCoordinates(
  viewer: Viewer,
  latitude: number,
  longitude: number,
  preferPhotorealisticSurface = false
): Promise<GroundPoint> {
  try {
    // 自動候補はDEM地面高を使うが、2D手動指定では橋面などDEMにない実在表面を選べるようにする。
    const point = await groundPointFromCoordinates(
      latitude,
      longitude,
      "三脚ピン"
    );
    if (preferPhotorealisticSurface) {
      try {
        const clamped = (
          await viewer.scene.clampToHeightMostDetailed([
            Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
          ], [...viewer.entities.values], 0.15)
        )[0];
        if (clamped) return setTripodPin(viewer, clamped);
      } catch (error) {
        console.warn("橋面を含む3D表面高を取得できないためDEM高を使用します", error);
      }
    }
    return setTripodPin(
      viewer,
      Cartesian3.fromDegrees(point.longitude, point.latitude, point.height)
    );
  } catch (error) {
    console.warn("三脚ピンの地形標高を取得できなかったため楕円体表面を使用します", error);
    return setTripodPin(viewer, Cartesian3.fromDegrees(longitude, latitude, 0));
  }
}

function distanceLabel(distanceMeters: number): string {
  return distanceMeters >= 1_000
    ? `距離 ${(distanceMeters / 1_000).toFixed(1)}km`
    : `距離 ${Math.round(distanceMeters)}m`;
}

export function updateTripodDistanceLabel(
  viewer: Viewer,
  distanceMeters: number | null
): void {
  const entity = viewer.entities.getById(TRIPOD_PIN_ID);
  if (!entity) return;
  entity.label = distanceMeters === null
    ? undefined
    : new LabelGraphics({
        text: distanceLabel(distanceMeters),
        font: "9px sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.TOP,
        pixelOffset: new Cartesian2(0, 4),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: Color.fromCssColorString("rgba(0,0,0,.58)"),
      });
}
