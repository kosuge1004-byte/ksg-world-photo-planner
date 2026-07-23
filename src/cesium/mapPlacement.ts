import {
  Cartesian2,
  Cartesian3,
  Ellipsoid,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from "cesium";

export function enableMapPlacement(
  viewer: Viewer,
  onPlaced: (position: Cartesian3) => void
): () => void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction(
    (movement: { position: Cartesian2 }) => {
      let position: Cartesian3 | undefined;

      if (viewer.scene.pickPositionSupported) {
        position = viewer.scene.pickPosition(movement.position);
      }

      if (!position) {
        position = viewer.camera.pickEllipsoid(
          movement.position,
          // Google 3D Tiles構成ではscene.globeを生成しないためWGS84を直接使う。
          Ellipsoid.WGS84
        );
      }

      if (position) {
        onPlaced(position);
      }
    },
    ScreenSpaceEventType.LEFT_CLICK
  );

  return () => {
    if (!handler.isDestroyed()) {
      handler.destroy();
    }
  };
}
