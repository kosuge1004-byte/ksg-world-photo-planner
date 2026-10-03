import {
  ArcType,
  Cartesian3,
  Color,
  Entity,
  PolylineDashMaterialProperty,
  Viewer,
} from "cesium";

import type { GroundPoint } from "../types/points";
import { ellipsoidalHeightMeters } from "../types/points";

const ENTITY_ID = "ksg-tripod-subject-camera-sight-line";

export function updateTripodSubjectSightLineEntity(
  viewer: Viewer,
  subject: GroundPoint | null,
  tripod: GroundPoint | null,
  lensCenterHeightMeters: number
): void {
  if (viewer.isDestroyed()) return;
  clearTripodSubjectSightLineEntity(viewer);
  if (
    !subject ||
    !tripod ||
    !Number.isFinite(lensCenterHeightMeters) ||
    lensCenterHeightMeters < 0
  ) return;

  const material = new PolylineDashMaterialProperty({
    color: Color.WHITE.withAlpha(0.96),
    dashLength: 12,
    dashPattern: 255,
  });
  viewer.entities.add(new Entity({
    id: ENTITY_ID,
    name: "被写体と三脚カメラ高を結ぶ視線",
    polyline: {
      positions: Cartesian3.fromDegreesArrayHeights([
        subject.longitude,
        subject.latitude,
        ellipsoidalHeightMeters(subject),
        tripod.longitude,
        tripod.latitude,
        ellipsoidalHeightMeters(tripod) + lensCenterHeightMeters,
      ]),
      // 地表へ曲げず、被写体とレンズ中心をECEF空間の直線で結ぶ。
      arcType: ArcType.NONE,
      clampToGround: false,
      width: 2.5,
      material,
      depthFailMaterial: material,
    },
  }));
  viewer.scene.requestRender();
}

export function clearTripodSubjectSightLineEntity(viewer: Viewer): void {
  if (viewer.isDestroyed()) return;
  const entity = viewer.entities.getById(ENTITY_ID);
  if (entity) viewer.entities.remove(entity);
  viewer.scene.requestRender();
}
