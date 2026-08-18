import {
  Cartesian2,
  Cartesian3,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from "cesium";
import { pickSceneSurfacePosition } from "./surfacePicking";

export function enableMapPlacement(
  viewer: Viewer,
  onPlaced: (position: Cartesian3) => void,
  onPickFailed?: () => void
): () => void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction(
    (movement: { position: Cartesian2 }) => {
      const position = pickSceneSurfacePosition(viewer, movement.position);
      if (!position) {
        onPickFailed?.();
        return;
      }
      onPlaced(position);
    },
    ScreenSpaceEventType.LEFT_CLICK
  );

  return () => {
    if (!handler.isDestroyed()) {
      handler.destroy();
    }
  };
}
