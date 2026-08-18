import {
  Cartesian2,
  Cartesian3,
  Color,
  LabelStyle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from "cesium";

import { pickSceneSurfacePosition } from "./surfacePicking";

const MEASURE_POINT_ENTITY_PREFIX = "measure-point-";
const MEASURE_LINE_ENTITY_ID = "measure-line";
const MEASURE_LABEL_ENTITY_ID = "measure-label";

function distanceLabel(distanceMeters: number): string {
  return distanceMeters >= 1000
    ? `距離 ${(distanceMeters / 1000).toFixed(2)}km`
    : `距離 ${Math.round(distanceMeters)}m`;
}

function clearMeasurementEntities(viewer: Viewer): void {
  for (const id of [
    `${MEASURE_POINT_ENTITY_PREFIX}0`,
    `${MEASURE_POINT_ENTITY_PREFIX}1`,
    MEASURE_LINE_ENTITY_ID,
    MEASURE_LABEL_ENTITY_ID,
  ]) {
    const entity = viewer.entities.getById(id);
    if (entity) viewer.entities.remove(entity);
  }
}

function addMeasurementPointEntity(viewer: Viewer, index: number, position: Cartesian3): void {
  viewer.entities.add({
    id: `${MEASURE_POINT_ENTITY_PREFIX}${index}`,
    position,
    point: {
      pixelSize: 10,
      color: Color.fromCssColorString("#5ab9ff"),
      outlineColor: Color.BLACK,
      outlineWidth: 2,
    },
  });
}

function updateMeasurementLine(
  viewer: Viewer,
  positionA: Cartesian3,
  positionB: Cartesian3
): void {
  const distanceMeters = Cartesian3.distance(positionA, positionB);
  const existingLine = viewer.entities.getById(MEASURE_LINE_ENTITY_ID);
  if (existingLine) viewer.entities.remove(existingLine);
  const existingLabel = viewer.entities.getById(MEASURE_LABEL_ENTITY_ID);
  if (existingLabel) viewer.entities.remove(existingLabel);

  viewer.entities.add({
    id: MEASURE_LINE_ENTITY_ID,
    polyline: {
      positions: [positionA, positionB],
      width: 3,
      material: Color.fromCssColorString("#5ab9ff"),
      clampToGround: false,
    },
  });

  const midpoint = Cartesian3.midpoint(positionA, positionB, new Cartesian3());
  viewer.entities.add({
    id: MEASURE_LABEL_ENTITY_ID,
    position: midpoint,
    label: {
      text: distanceLabel(distanceMeters),
      font: "bold 15px sans-serif",
      style: LabelStyle.FILL_AND_OUTLINE,
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      pixelOffset: new Cartesian2(0, -14),
    },
  });
}

/**
 * 3Dマップの計測モードを有効にする。2回タップした地点の実際の3D表面
 * （地形・建物含む）を拾い、直線距離を表示する。3回目のタップで最初の
 * 点からやり直す。戻り値の関数を呼ぶと計測モードを終了し、表示も消す。
 */
export function enableMapMeasurement(
  viewer: Viewer,
  onUpdate: (distanceMeters: number | null) => void,
  onPickFailed?: () => void
): () => void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  const points: Cartesian3[] = [];

  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const position = pickSceneSurfacePosition(viewer, movement.position);
    if (!position) {
      onPickFailed?.();
      return;
    }
    if (points.length >= 2) {
      points.length = 0;
      clearMeasurementEntities(viewer);
    }
    points.push(position);
    addMeasurementPointEntity(viewer, points.length - 1, position);
    if (points.length === 2) {
      updateMeasurementLine(viewer, points[0], points[1]);
      onUpdate(Cartesian3.distance(points[0], points[1]));
    } else {
      onUpdate(null);
    }
  }, ScreenSpaceEventType.LEFT_CLICK);

  return () => {
    if (!handler.isDestroyed()) handler.destroy();
    if (!viewer.isDestroyed()) clearMeasurementEntities(viewer);
  };
}
