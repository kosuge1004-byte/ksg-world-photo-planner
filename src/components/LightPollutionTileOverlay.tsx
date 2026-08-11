import { useMemo } from "react";

import {
  LIGHT_POLLUTION_MAX_ZOOM,
  LIGHT_POLLUTION_TILE_URL,
} from "../cesium/lightPollutionLayer";
import type { GroundPoint } from "../types/points";
import type { MapSize } from "../map/webMercator";

type Props = {
  center: Pick<GroundPoint, "latitude" | "longitude">;
  zoom: number;
  size: MapSize;
};

type Tile = {
  key: string;
  src: string;
  left: number;
  top: number;
  size: number;
};

function worldPoint(latitude: number, longitude: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sinLatitude = Math.sin(clampedLatitude * Math.PI / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y:
      (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) *
      scale,
  };
}

function tileUrl(z: number, x: number, y: number): string {
  return LIGHT_POLLUTION_TILE_URL
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

export function LightPollutionTileOverlay({ center, zoom, size }: Props) {
  const tiles = useMemo<Tile[]>(() => {
    if (size.width <= 0 || size.height <= 0) return [];

    const displayZoom = Math.max(0, zoom);
    const tileZoom = Math.max(0, Math.min(LIGHT_POLLUTION_MAX_ZOOM, Math.floor(displayZoom)));
    const displayScale = 2 ** (displayZoom - tileZoom);
    const displayTileSize = 256 * displayScale;
    const centerAtTileZoom = worldPoint(center.latitude, center.longitude, tileZoom);
    const worldTileCount = 2 ** tileZoom;

    const centerXAtDisplay = centerAtTileZoom.x * displayScale;
    const centerYAtDisplay = centerAtTileZoom.y * displayScale;
    const viewportLeft = centerXAtDisplay - size.width / 2;
    const viewportTop = centerYAtDisplay - size.height / 2;

    const minTileX = Math.floor(viewportLeft / displayTileSize) - 1;
    const maxTileX = Math.floor((viewportLeft + size.width) / displayTileSize) + 1;
    const minTileY = Math.max(0, Math.floor(viewportTop / displayTileSize) - 1);
    const maxTileY = Math.min(
      worldTileCount - 1,
      Math.floor((viewportTop + size.height) / displayTileSize) + 1
    );

    const result: Tile[] = [];
    for (let rawX = minTileX; rawX <= maxTileX; rawX += 1) {
      const wrappedX = ((rawX % worldTileCount) + worldTileCount) % worldTileCount;
      for (let y = minTileY; y <= maxTileY; y += 1) {
        result.push({
          key: `${tileZoom}/${rawX}/${y}`,
          src: tileUrl(tileZoom, wrappedX, y),
          left: rawX * displayTileSize - viewportLeft,
          top: y * displayTileSize - viewportTop,
          size: displayTileSize,
        });
      }
    }
    return result;
  }, [center.latitude, center.longitude, size.height, size.width, zoom]);

  return (
    <div className="light-pollution-tile-overlay" aria-label="NASA VIIRS Black Marble 光害マップ">
      {tiles.map((tile) => (
        <img
          key={tile.key}
          src={tile.src}
          alt=""
          draggable={false}
          style={{
            left: tile.left,
            top: tile.top,
            width: tile.size,
            height: tile.size,
          }}
        />
      ))}
      <div className="light-pollution-credit">NASA EOSDIS GIBS / VIIRS Black Marble</div>
    </div>
  );
}
