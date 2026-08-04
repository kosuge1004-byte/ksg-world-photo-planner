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

const PERSON_PIN_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="88" viewBox="0 0 64 88">
  <path d="M32 86C27 73 8 58 8 32C8 18.7 18.7 8 32 8s24 10.7 24 24C56 58 37 73 32 86Z" fill="#111" stroke="#fff" stroke-width="4"/>
  <circle cx="32" cy="27" r="7" fill="#fff"/>
  <path d="M25 38Q32 34 39 38L42 55H37L39 69H34L32 53L30 69H25L27 55H22Z" fill="#fff"/>
</svg>`)}`;

export function updateForegroundObjectEntity(viewer: Viewer, object: ForegroundObject | null): void {
  const existing = viewer.entities.getById(ENTITY_ID);
  if (!object?.enabled || !Number.isFinite(object.groundHeightMeters)) {
    if (existing) viewer.entities.remove(existing);
    return;
  }

  const position = Cartesian3.fromDegrees(
    object.longitude,
    object.latitude,
    (object.groundHeightMeters as number) + 0.08
  );

  // The map is for locating/editing the person, not for judging physical scale.
  // Therefore both near and far map views use a fixed pixel-size pin.
  if (existing) {
    existing.position = new ConstantPositionProperty(position);
    if (existing.billboard) {
      existing.billboard.image = new ConstantProperty(PERSON_PIN_SVG);
      existing.billboard.width = new ConstantProperty(32);
      existing.billboard.height = new ConstantProperty(44);
      existing.billboard.sizeInMeters = new ConstantProperty(false);
      existing.billboard.heightReference = new ConstantProperty(HeightReference.NONE);
      existing.billboard.disableDepthTestDistance = new ConstantProperty(Number.POSITIVE_INFINITY);
      existing.billboard.scale = new ConstantProperty(1);
      existing.billboard.scaleByDistance = undefined;
    }
    return;
  }

  viewer.entities.add({
    id: ENTITY_ID,
    name: "前景・中景オブジェクト",
    position,
    billboard: {
      image: PERSON_PIN_SVG,
      width: 32,
      height: 44,
      sizeInMeters: false,
      verticalOrigin: VerticalOrigin.BOTTOM,
      heightReference: HeightReference.NONE,
      color: Color.WHITE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
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
  return {
    latitude: c.latitude * 180 / Math.PI,
    longitude: c.longitude * 180 / Math.PI,
    groundHeightMeters: Number.isFinite(c.height) ? c.height : undefined,
  };
}
