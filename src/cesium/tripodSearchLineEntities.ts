import {
  Cartesian3,
  Color,
  Entity,
  PolylineDashMaterialProperty,
  Viewer,
} from "cesium";

import type { CelestialBodyId } from "../types/celestial";
import type { TripodSearchBaseLine } from "./tripodSearchLine";

const ENTITY_ID_PREFIX = "ksg-tripod-search-base-line";

// 2Dマップ側（App.css .map-candidate-{id}）と同じ色を使う。
const LINE_COLOR_BY_ID: Record<CelestialBodyId, string> = {
  sun: "#ffc928",
  moon: "#52d0ff",
  milkyWay: "#da9aff",
  polaris: "#c0a1ff",
};

function lineColor(id: CelestialBodyId): Color {
  return Color.fromCssColorString(LINE_COLOR_BY_ID[id] ?? "#ffc928");
}

// 2Dマップ側（Map2DOverlay.tsx / App.css .map-tripod-candidate-line）と
// 見た目を揃える：破線・同系色。dashLengthはCesium仕様上ワールド距離(m)
// ではなく画面ピクセル基準（PolylineDashMaterialPropertyの仕様）。
const DASH_LENGTH_PIXELS = 12;
const DASH_PATTERN = 255; // 0b0000000011111111 相当（Cesium既定と同じ半分点灯）

function entityId(id: string): string {
  return `${ENTITY_ID_PREFIX}:${id}`;
}

/**
 * 被写体から天体方位へ地表沿いに伸びる破線を3Dマップへ描画する。
 * 2026-09-10追記: この線は元々2Dマップ（Map2DOverlay.tsx）にしか実装が
 * 無く、3D表示中は最初から描画対象外だった。地表にクランプした
 * ポリラインとして3D側にも追加する。
 */
export function updateTripodSearchLineEntities(
  viewer: Viewer,
  lines: TripodSearchBaseLine[]
): void {
  if (viewer.isDestroyed()) return;

  const keepIds = new Set(lines.map((line) => entityId(line.id)));
  for (const entity of [...viewer.entities.values]) {
    if (
      typeof entity.id === "string" &&
      entity.id.startsWith(`${ENTITY_ID_PREFIX}:`) &&
      !keepIds.has(entity.id)
    ) {
      viewer.entities.remove(entity);
    }
  }

  for (const line of lines) {
    const id = entityId(line.id);
    const existing = viewer.entities.getById(id);
    if (existing) viewer.entities.remove(existing);

    viewer.entities.add(
      new Entity({
        id,
        name: `${line.label}方位の探索基礎ライン`,
        polyline: {
          positions: Cartesian3.fromDegreesArray([
            line.start.longitude,
            line.start.latitude,
            line.end.longitude,
            line.end.latitude,
          ]),
          // GSI DEM等の地形に沿わせる。地表を突き抜けたり浮いたりしないよう、
          // 2D版と同じ「常に見える地表上の線」という見え方に揃える。
          clampToGround: true,
          width: 2.5,
          material: new PolylineDashMaterialProperty({
            color: lineColor(line.id),
            dashLength: DASH_LENGTH_PIXELS,
            dashPattern: DASH_PATTERN,
          }),
        },
      })
    );
  }
}

export function clearTripodSearchLineEntities(viewer: Viewer): void {
  if (viewer.isDestroyed()) return;
  for (const entity of [...viewer.entities.values]) {
    if (typeof entity.id === "string" && entity.id.startsWith(`${ENTITY_ID_PREFIX}:`)) {
      viewer.entities.remove(entity);
    }
  }
}
