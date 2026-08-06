import { Cartesian2, Cartesian3, Viewer } from "cesium";
import { pickSceneSurfacePosition } from "./surfacePicking";

export function pickCenterPosition(
  viewer: Viewer
): Cartesian3 | null {
  const canvas = viewer.scene.canvas;
  const center = new Cartesian2(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2
  );

  return pickSceneSurfacePosition(viewer, center);
}
