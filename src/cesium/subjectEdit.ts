import { Cartesian2, Cartesian3, Ellipsoid, Viewer } from "cesium";

export function pickCenterPosition(
  viewer: Viewer
): Cartesian3 | null {
  const canvas = viewer.scene.canvas;
  const center = new Cartesian2(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2
  );

  let position: Cartesian3 | undefined;

  if (viewer.scene.pickPositionSupported) {
    position = viewer.scene.pickPosition(center);
  }

  if (!position) {
    position = viewer.camera.pickEllipsoid(
      center,
      // Google 3D Tiles構成ではscene.globeを生成しないためWGS84を直接使う。
      Ellipsoid.WGS84
    );
  }

  return position ?? null;
}
