import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ConstantPositionProperty,
  ConstantProperty,
  HeightReference,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from "cesium";
import type { ForegroundObject } from "../types/foreground";

const ENTITY_ID = "ksg-foreground-object";

const PERSON_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="80" height="200" viewBox="0 0 80 200">
<circle cx="40" cy="18" r="18" fill="#111" stroke="#fff" stroke-width="3"/>
<path d="M26 40 Q40 34 54 40 L62 112 53 112 58 200 43 200 40 126 37 200 22 200 27 112 18 112Z" fill="#111" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>
</svg>`)} `;

export function updateForegroundObjectEntity(viewer: Viewer, object: ForegroundObject | null): void {
  const existing = viewer.entities.getById(ENTITY_ID);
  if (!object?.enabled || !Number.isFinite(object.groundHeightMeters)) {
    if (existing) viewer.entities.remove(existing);
    return;
  }
  const position = Cartesian3.fromDegrees(
    object.longitude,
    object.latitude,
    object.groundHeightMeters as number
  );
  const heightMeters = Math.max(0.5, Math.min(3, object.heightCm / 100));
  const widthMeters = heightMeters * 0.4;
  if (existing) {
    existing.position = new ConstantPositionProperty(position);
    if (existing.billboard) {
      existing.billboard.height = new ConstantProperty(heightMeters);
      existing.billboard.width = new ConstantProperty(widthMeters);
      existing.billboard.sizeInMeters = new ConstantProperty(true);
      existing.billboard.heightReference = new ConstantProperty(HeightReference.NONE);
      existing.billboard.disableDepthTestDistance = new ConstantProperty(0);
    }
    return;
  }
  viewer.entities.add({
    id: ENTITY_ID,
    name: "前景・中景オブジェクト",
    position,
    billboard: {
      image: PERSON_SVG,
      width: widthMeters,
      height: heightMeters,
      sizeInMeters: true,
      verticalOrigin: VerticalOrigin.BOTTOM,
      heightReference: HeightReference.NONE,
      color: Color.WHITE,
      disableDepthTestDistance: 0,
    },
  });
}

export function enableForegroundObjectDrag(
  viewer: Viewer,
  onMoved: (position: Cartesian3) => void
): () => void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  let dragging = false;
  const stopDragging = (): void => {
    if (!dragging) return;
    dragging = false;
    if (!viewer.isDestroyed()) {
      viewer.scene.screenSpaceCameraController.enableInputs = true;
    }
  };
  const pickGround = (screen: Cartesian2): Cartesian3 | undefined => {
    if (viewer.scene.pickPositionSupported) {
      const picked = viewer.scene.pickPosition(screen);
      if (picked) return picked;
    }
    return viewer.camera.pickEllipsoid(screen);
  };
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const picked = viewer.scene.pick(movement.position) as { id?: Entity } | undefined;
    if (picked?.id?.id !== ENTITY_ID) return;
    dragging = true;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
  }, ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
    if (!dragging) return;
    const position = pickGround(movement.endPosition);
    if (position) onMoved(position);
  }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(stopDragging, ScreenSpaceEventType.LEFT_UP);

  // ポインターがキャンバス外で離された場合、CesiumのLEFT_UPは発火しない。
  // window側でも終了を監視し、カメラ操作が無効のまま固まる状態を防ぐ。
  window.addEventListener("pointerup", stopDragging, true);
  window.addEventListener("pointercancel", stopDragging, true);
  window.addEventListener("mouseup", stopDragging, true);
  window.addEventListener("touchend", stopDragging, true);
  window.addEventListener("blur", stopDragging);

  return () => {
    stopDragging();
    window.removeEventListener("pointerup", stopDragging, true);
    window.removeEventListener("pointercancel", stopDragging, true);
    window.removeEventListener("mouseup", stopDragging, true);
    window.removeEventListener("touchend", stopDragging, true);
    window.removeEventListener("blur", stopDragging);
    if (!handler.isDestroyed()) handler.destroy();
  };
}

export function cartesianToForegroundCoordinates(position: Cartesian3) {
  const c = Cartographic.fromCartesian(position);
  return { latitude: c.latitude * 180 / Math.PI, longitude: c.longitude * 180 / Math.PI };
}
