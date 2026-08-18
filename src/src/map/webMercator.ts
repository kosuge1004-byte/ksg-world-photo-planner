import type { GroundPoint } from "../types/points";

export type MapSize = { width: number; height: number };
export type MapPixelPoint = { x: number; y: number };

function worldPoint(
  latitude: number,
  longitude: number,
  zoom: number
): MapPixelPoint {
  const scale = 256 * 2 ** zoom;
  const sinLatitude = Math.sin(
    Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180
  );
  return {
    x: ((longitude + 180) / 360) * scale,
    y:
      (0.5 -
        Math.log((1 + sinLatitude) / (1 - sinLatitude)) /
          (4 * Math.PI)) *
      scale,
  };
}

export function projectCoordinatesToMapPixel(
  point: Pick<GroundPoint, "latitude" | "longitude">,
  center: Pick<GroundPoint, "latitude" | "longitude">,
  zoom: number,
  size: MapSize
): MapPixelPoint {
  const projected = worldPoint(point.latitude, point.longitude, zoom);
  const projectedCenter = worldPoint(center.latitude, center.longitude, zoom);
  const worldWidth = 256 * 2 ** zoom;
  let deltaX = projected.x - projectedCenter.x;
  if (deltaX > worldWidth / 2) deltaX -= worldWidth;
  if (deltaX < -worldWidth / 2) deltaX += worldWidth;
  return {
    x: size.width / 2 + deltaX,
    y: size.height / 2 + projected.y - projectedCenter.y,
  };
}

export function coordinatesAtMapPixel(
  x: number,
  y: number,
  center: Pick<GroundPoint, "latitude" | "longitude">,
  zoom: number,
  size: MapSize
): { latitude: number; longitude: number } {
  const projectedCenter = worldPoint(center.latitude, center.longitude, zoom);
  const scale = 256 * 2 ** zoom;
  const worldX = projectedCenter.x + x - size.width / 2;
  const worldY = projectedCenter.y + y - size.height / 2;
  const rawLongitude = (worldX / scale) * 360 - 180;
  const longitude =
    ((rawLongitude + 180) % 360 + 360) % 360 - 180;
  const mercator = Math.PI - (2 * Math.PI * worldY) / scale;
  const latitude = (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
  return { latitude, longitude };
}
