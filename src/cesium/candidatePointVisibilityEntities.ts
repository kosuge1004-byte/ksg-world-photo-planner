import { Cartesian3, Color, Entity, NearFarScalar, Viewer } from "cesium";
import type { CandidatePointVisibilityPoint } from "../visibility/candidatePointVisibility";

const ENTITY_PREFIX = "ksg-candidate-visibility-point";

export function updateCandidatePointVisibilityEntities(
  viewer: Viewer,
  points: readonly CandidatePointVisibilityPoint[]
): void {
  if (viewer.isDestroyed()) return;
  clearCandidatePointVisibilityEntities(viewer);
  for (const point of points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
      !Number.isFinite(point.height)) continue;
    viewer.entities.add(new Entity({
      id: `${ENTITY_PREFIX}:${point.visibilityKey}`,
      name: `${point.label} 見通し確認済み候補`,
      position: Cartesian3.fromDegrees(point.longitude, point.latitude, point.height + 0.8),
      point: {
        pixelSize: 10,
        color: Color.LIME,
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(100, 1, 100_000, 0.7),
      },
    }));
  }
  viewer.scene.requestRender();
}

export function clearCandidatePointVisibilityEntities(viewer: Viewer): void {
  if (viewer.isDestroyed()) return;
  for (const entity of [...viewer.entities.values]) {
    if (typeof entity.id === "string" && entity.id.startsWith(`${ENTITY_PREFIX}:`)) {
      viewer.entities.remove(entity);
    }
  }
  viewer.scene.requestRender();
}
