import { useEffect, useMemo, useRef, useState } from "react";

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

type TileDraw = {
  key: string;
  src: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

const TILE_SIZE = 256;
const MAX_TILE_CACHE_ENTRIES = 96;
const TILE_LOAD_TIMEOUT_MS = 8000;

type TileCacheEntry = {
  promise: Promise<HTMLImageElement | null>;
  lastUsed: number;
  settled: boolean;
};

const imageCache = new Map<string, TileCacheEntry>();

function pruneImageCache(): void {
  if (imageCache.size <= MAX_TILE_CACHE_ENTRIES) return;

  const removable = [...imageCache.entries()]
    .filter(([, entry]) => entry.settled)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

  const removeCount = imageCache.size - MAX_TILE_CACHE_ENTRIES;
  for (let index = 0; index < Math.min(removeCount, removable.length); index += 1) {
    imageCache.delete(removable[index][0]);
  }
}

function worldPoint(latitude: number, longitude: number, zoom: number) {
  const scale = TILE_SIZE * 2 ** zoom;
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sinLatitude = Math.sin((clampedLatitude * Math.PI) / 180);
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

function loadTile(src: string): Promise<HTMLImageElement | null> {
  const cached = imageCache.get(src);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.promise;
  }

  const entry: TileCacheEntry = {
    lastUsed: Date.now(),
    settled: false,
    promise: Promise.resolve(null),
  };

  entry.promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    let finished = false;

    const finish = (value: HTMLImageElement | null) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeoutId);
      entry.settled = true;
      entry.lastUsed = Date.now();
      resolve(value);
      pruneImageCache();
    };

    const timeoutId = window.setTimeout(() => finish(null), TILE_LOAD_TIMEOUT_MS);
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = src;
  });

  imageCache.set(src, entry);
  pruneImageCache();
  return entry.promise;
}

export function LightPollutionTileOverlay({ center, zoom, size }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderGenerationRef = useRef(0);
  const [hasVisibleTiles, setHasVisibleTiles] = useState(false);

  const tiles = useMemo<TileDraw[]>(() => {
    if (size.width <= 0 || size.height <= 0) return [];

    const displayZoom = Math.max(0, zoom);
    const tileZoom = Math.max(
      0,
      Math.min(LIGHT_POLLUTION_MAX_ZOOM, Math.floor(displayZoom))
    );
    const displayScale = 2 ** (displayZoom - tileZoom);
    const centerAtTileZoom = worldPoint(center.latitude, center.longitude, tileZoom);
    const worldTileCount = 2 ** tileZoom;

    // IMPORTANT: GIBS Black Marble currently stops at z=8.  Previously each z=8
    // <img> was enlarged to 256 * 2^(mapZoom-8) CSS pixels. At normal street-level
    // zoom this created 100k+ pixel DOM images and could exhaust the browser/GPU.
    // Work in source-tile coordinates instead and draw only the visible crop.
    const sourceViewportWidth = size.width / displayScale;
    const sourceViewportHeight = size.height / displayScale;
    const sourceLeft = centerAtTileZoom.x - sourceViewportWidth / 2;
    const sourceTop = centerAtTileZoom.y - sourceViewportHeight / 2;
    const sourceRight = sourceLeft + sourceViewportWidth;
    const sourceBottom = sourceTop + sourceViewportHeight;

    const minTileX = Math.floor(sourceLeft / TILE_SIZE);
    const maxTileX = Math.floor((sourceRight - Number.EPSILON) / TILE_SIZE);
    const minTileY = Math.max(0, Math.floor(sourceTop / TILE_SIZE));
    const maxTileY = Math.min(
      worldTileCount - 1,
      Math.floor((sourceBottom - Number.EPSILON) / TILE_SIZE)
    );

    const result: TileDraw[] = [];
    for (let rawX = minTileX; rawX <= maxTileX; rawX += 1) {
      const wrappedX = ((rawX % worldTileCount) + worldTileCount) % worldTileCount;
      const tileLeft = rawX * TILE_SIZE;
      const tileRight = tileLeft + TILE_SIZE;

      for (let y = minTileY; y <= maxTileY; y += 1) {
        const tileTop = y * TILE_SIZE;
        const tileBottom = tileTop + TILE_SIZE;

        const intersectionLeft = Math.max(sourceLeft, tileLeft);
        const intersectionTop = Math.max(sourceTop, tileTop);
        const intersectionRight = Math.min(sourceRight, tileRight);
        const intersectionBottom = Math.min(sourceBottom, tileBottom);
        if (
          intersectionRight <= intersectionLeft ||
          intersectionBottom <= intersectionTop
        ) {
          continue;
        }

        const sw = intersectionRight - intersectionLeft;
        const sh = intersectionBottom - intersectionTop;
        result.push({
          key: `${tileZoom}/${rawX}/${y}`,
          src: tileUrl(tileZoom, wrappedX, y),
          sx: intersectionLeft - tileLeft,
          sy: intersectionTop - tileTop,
          sw,
          sh,
          dx: (intersectionLeft - sourceLeft) * displayScale,
          dy: (intersectionTop - sourceTop) * displayScale,
          dw: sw * displayScale,
          dh: sh * displayScale,
        });
      }
    }
    return result;
  }, [center.latitude, center.longitude, size.height, size.width, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;

    const generation = ++renderGenerationRef.current;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const targetWidth = Math.max(1, Math.round(size.width * dpr));
    const targetHeight = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    setHasVisibleTiles(false);

    void Promise.all(
      tiles.map(async (tile) => ({ tile, image: await loadTile(tile.src) }))
    ).then((loaded) => {
      if (renderGenerationRef.current !== generation) return;
      const currentCanvas = canvasRef.current;
      if (!currentCanvas) return;
      const currentContext = currentCanvas.getContext("2d", { alpha: true });
      if (!currentContext) return;

      currentContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      currentContext.clearRect(0, 0, size.width, size.height);
      currentContext.globalAlpha = 0.62;
      currentContext.imageSmoothingEnabled = true;
      currentContext.imageSmoothingQuality = "high";

      let drawn = 0;
      for (const { tile, image } of loaded) {
        if (!image) continue;
        currentContext.drawImage(
          image,
          tile.sx,
          tile.sy,
          tile.sw,
          tile.sh,
          tile.dx,
          tile.dy,
          tile.dw,
          tile.dh
        );
        drawn += 1;
      }
      currentContext.globalAlpha = 1;
      setHasVisibleTiles(drawn > 0);
    });

    return () => {
      // Ignore asynchronous tile loads from an obsolete viewport/zoom.
      renderGenerationRef.current += 1;
    };
  }, [size.height, size.width, tiles]);

  return (
    <div
      className="light-pollution-tile-overlay"
      aria-label="NASA VIIRS Black Marble 光害マップ"
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {hasVisibleTiles && (
        <div className="light-pollution-credit">
          NASA EOSDIS GIBS / VIIRS Black Marble
        </div>
      )}
    </div>
  );
}
