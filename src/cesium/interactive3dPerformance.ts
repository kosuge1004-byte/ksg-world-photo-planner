import { Cesium3DTileset, type PrimitiveCollection, type Viewer } from "cesium";

const INTERACTION_RESOLUTION_SCALE = 0.72;
const INTERACTION_SSE_MULTIPLIER = 1.5;
const MAX_INTERACTION_SSE = 48;
const RESTORE_DELAY_MS = 160;

function collectTilesets(primitives: PrimitiveCollection, output: Cesium3DTileset[]): void {
  for (let index = 0; index < primitives.length; index += 1) {
    const primitive = primitives.get(index);
    if (primitive instanceof Cesium3DTileset) output.push(primitive);
    else if (primitive && typeof primitive === "object" && "length" in primitive) {
      collectTilesets(primitive as PrimitiveCollection, output);
    }
  }
}

export function sceneHasPending3dContent(viewer: Viewer): boolean {
  if (viewer.isDestroyed()) return false;
  if (viewer.scene.globe?.show && !viewer.scene.globe.tilesLoaded) return true;
  const tilesets: Cesium3DTileset[] = [];
  collectTilesets(viewer.scene.primitives, tilesets);
  return tilesets.some((tileset) => tileset.show && !tileset.tilesLoaded);
}

export type Interactive3dPerformanceController = {
  isInteracting(): boolean;
  dispose(): void;
};

/**
 * Reduce only transient rendering work while the user moves the 3D camera.
 * The normal resolution and the exact tileset SSE are restored after the
 * gesture. This never changes coordinates, DEM sampling, interpolation or
 * tripod-candidate calculation.
 */
export function attachInteractive3dPerformance(
  viewer: Viewer
): Interactive3dPerformanceController {
  const normalResolutionScale = viewer.resolutionScale;
  const originalSse = new Map<Cesium3DTileset, number>();
  let interacting = false;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;

  const restore = () => {
    if (viewer.isDestroyed()) return;
    viewer.resolutionScale = normalResolutionScale;
    for (const [tileset, maximumScreenSpaceError] of originalSse) {
      if (!tileset.isDestroyed()) tileset.maximumScreenSpaceError = maximumScreenSpaceError;
    }
    originalSse.clear();
    viewer.scene.requestRender();
  };

  const onMoveStart = () => {
    if (restoreTimer !== undefined) clearTimeout(restoreTimer);
    restoreTimer = undefined;
    interacting = true;
    if (viewer.isDestroyed()) return;
    viewer.resolutionScale = Math.min(normalResolutionScale, INTERACTION_RESOLUTION_SCALE);
    const tilesets: Cesium3DTileset[] = [];
    collectTilesets(viewer.scene.primitives, tilesets);
    for (const tileset of tilesets) {
      if (!originalSse.has(tileset)) originalSse.set(tileset, tileset.maximumScreenSpaceError);
      const baseline = originalSse.get(tileset)!;
      tileset.maximumScreenSpaceError = Math.min(
        MAX_INTERACTION_SSE,
        Math.max(baseline, baseline * INTERACTION_SSE_MULTIPLIER)
      );
    }
    viewer.scene.requestRender();
  };

  const onMoveEnd = () => {
    interacting = false;
    if (restoreTimer !== undefined) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreTimer = undefined;
      restore();
    }, RESTORE_DELAY_MS);
  };

  viewer.camera.moveStart.addEventListener(onMoveStart);
  viewer.camera.moveEnd.addEventListener(onMoveEnd);
  return {
    isInteracting: () => interacting,
    dispose: () => {
      viewer.camera.moveStart.removeEventListener(onMoveStart);
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      if (restoreTimer !== undefined) clearTimeout(restoreTimer);
      restoreTimer = undefined;
      interacting = false;
      restore();
    },
  };
}

