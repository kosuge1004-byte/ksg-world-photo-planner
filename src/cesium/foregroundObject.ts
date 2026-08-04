import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ConstantPositionProperty,
  ConstantProperty,
  DistanceDisplayCondition,
  HeightReference,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from "cesium";
import { foregroundHeightCmToMeters, type ForegroundObject } from "../types/foreground";

const NEAR_ENTITY_ID = "ksg-foreground-object-near";
const FAR_ENTITY_ID = "ksg-foreground-object-far";
const PERSON_SWITCH_DISTANCE_METERS = 100;

const PERSON_SILHOUETTE_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="260" viewBox="0 0 100 260">
  <circle cx="50" cy="28" r="22" fill="#111" stroke="#fff" stroke-width="5"/>
  <path d="M29 57Q50 47 71 57L78 132L69 134L74 236H58L50 145L42 236H26L31 134L22 132Z" fill="#111" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
</svg>`)}`;

const PERSON_PIN_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="88" viewBox="0 0 64 88">
  <path d="M32 86C27 73 8 58 8 32C8 18.7 18.7 8 32 8s24 10.7 24 24C56 58 37 73 32 86Z" fill="#111" stroke="#fff" stroke-width="4"/>
  <circle cx="32" cy="27" r="7" fill="#fff"/>
  <path d="M25 38Q32 34 39 38L42 55H37L39 69H34L32 53L30 69H25L27 55H22Z" fill="#fff"/>
</svg>`)}`;

function removeForegroundEntities(viewer: Viewer): void {
  const near = viewer.entities.getById(NEAR_ENTITY_ID);
  const far = viewer.entities.getById(FAR_ENTITY_ID);
  if (near) viewer.entities.remove(near);
  if (far) viewer.entities.remove(far);
}

export function updateForegroundObjectEntity(viewer: Viewer, object: ForegroundObject | null): void {
  if (!object?.enabled || !Number.isFinite(object.groundHeightMeters)) {
    removeForegroundEntities(viewer);
    return;
  }

  const heightMeters = foregroundHeightCmToMeters(object.heightCm);
  const silhouetteWidthMeters = heightMeters * (100 / 260);
  const position = Cartesian3.fromDegrees(
    object.longitude,
    object.latitude,
    (object.groundHeightMeters as number) + 0.03
  );

  const near = viewer.entities.getById(NEAR_ENTITY_ID);
  if (near) {
    near.position = new ConstantPositionProperty(position);
    if (near.billboard) {
      near.billboard.image = new ConstantProperty(PERSON_SILHOUETTE_SVG);
      near.billboard.width = new ConstantProperty(silhouetteWidthMeters);
      near.billboard.height = new ConstantProperty(heightMeters);
      near.billboard.sizeInMeters = new ConstantProperty(true);
      near.billboard.heightReference = new ConstantProperty(HeightReference.NONE);
      near.billboard.disableDepthTestDistance = new ConstantProperty(0);
      near.billboard.distanceDisplayCondition = new ConstantProperty(
        new DistanceDisplayCondition(0, PERSON_SWITCH_DISTANCE_METERS)
      );
    }
  } else {
    viewer.entities.add({
      id: NEAR_ENTITY_ID,
      name: "前景・中景オブジェクト（近距離）",
      position,
      billboard: {
        image: PERSON_SILHOUETTE_SVG,
        width: silhouetteWidthMeters,
        height: heightMeters,
        sizeInMeters: true,
        verticalOrigin: VerticalOrigin.BOTTOM,
        heightReference: HeightReference.NONE,
        color: Color.WHITE,
        disableDepthTestDistance: 0,
        distanceDisplayCondition: new DistanceDisplayCondition(0, PERSON_SWITCH_DISTANCE_METERS),
      },
    });
  }

  const far = viewer.entities.getById(FAR_ENTITY_ID);
  if (far) {
    far.position = new ConstantPositionProperty(position);
    if (far.billboard) {
      far.billboard.image = new ConstantProperty(PERSON_PIN_SVG);
      far.billboard.width = new ConstantProperty(32);
      far.billboard.height = new ConstantProperty(44);
      far.billboard.sizeInMeters = new ConstantProperty(false);
      far.billboard.heightReference = new ConstantProperty(HeightReference.NONE);
      far.billboard.disableDepthTestDistance = new ConstantProperty(Number.POSITIVE_INFINITY);
      far.billboard.scale = new ConstantProperty(1);
      far.billboard.scaleByDistance = undefined;
      far.billboard.distanceDisplayCondition = new ConstantProperty(
        new DistanceDisplayCondition(PERSON_SWITCH_DISTANCE_METERS, Number.POSITIVE_INFINITY)
      );
    }
  } else {
    viewer.entities.add({
      id: FAR_ENTITY_ID,
      name: "前景・中景オブジェクト（遠距離）",
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
        distanceDisplayCondition: new DistanceDisplayCondition(
          PERSON_SWITCH_DISTANCE_METERS,
          Number.POSITIVE_INFINITY
        ),
      },
    });
  }
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
    const pickedId = picked?.id?.id;
    if (pickedId !== NEAR_ENTITY_ID && pickedId !== FAR_ENTITY_ID) return;
    dragging = true;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
  }, ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
    if (!dragging) return;
    const position = pickGround(movement.endPosition);
    if (position) onMoved(position);
  }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(stopDragging, ScreenSpaceEventType.LEFT_UP);

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
