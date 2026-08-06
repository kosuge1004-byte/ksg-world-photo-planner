import { Cartesian2, Cartesian3, Viewer } from "cesium";

/**
 * Returns only a depth-tested 3D scene surface position.
 *
 * Precision policy:
 * - Never fall back to the WGS84 ellipsoid.
 * - A failed depth pick is an explicit failure, because replacing a roof,
 *   floor, bridge deck, or terrain point with the ellipsoid would silently
 *   corrupt the selected height.
 */
export function pickSceneSurfacePosition(
  viewer: Viewer,
  screenPosition: Cartesian2
): Cartesian3 | null {
  if (viewer.isDestroyed() || !viewer.scene.pickPositionSupported) {
    return null;
  }

  const position = viewer.scene.pickPosition(screenPosition);
  if (!position) return null;

  return Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z)
    ? position
    : null;
}
