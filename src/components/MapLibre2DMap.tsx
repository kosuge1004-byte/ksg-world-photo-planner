import { useEffect, useRef } from "react";

import type { GroundPoint } from "../types/points";

const MAPLIBRE_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/maplibre-gl@6.6.0/dist/maplibre-gl.mjs";
const MAPLIBRE_CSS_URL =
  "https://cdn.jsdelivr.net/npm/maplibre-gl@6.6.0/dist/maplibre-gl.css";
const OPENFREEMAP_BRIGHT_STYLE_URL =
  "https://tiles.openfreemap.org/styles/bright";
const GSI_SEAMLESSPHOTO_TILE_URL =
  "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";

// AstroSightの既存2D座標系はGoogle/XYZ互換の256pxタイルを基準に
// worldSize = 256 * 2^zoom としている。一方MapLibre GLの画面zoomは
// 512px基準なので、同じ画面縮尺にするにはMapLibre側を1段下げる。
// 既存のMap2DOverlay / webMercator.ts / 保存済みプロジェクトのzoom値を
// 変更せず、この表示アダプタだけで吸収する。
export const MAPLIBRE_ZOOM_OFFSET = -1;

export function toMapLibreZoom(appZoom: number): number {
  return appZoom + MAPLIBRE_ZOOM_OFFSET;
}

export function fromMapLibreZoom(mapLibreZoom: number): number {
  return mapLibreZoom - MAPLIBRE_ZOOM_OFFSET;
}

type MapType = "roadmap" | "satellite";

type Props = {
  center: Pick<GroundPoint, "latitude" | "longitude">;
  zoom: number;
  mapType: MapType;
  onViewChange: (view: {
    center: { latitude: number; longitude: number };
    zoom: number;
  }) => void;
  onTap?: (coordinates: { latitude: number; longitude: number }) => void;
  onError?: (message: string) => void;
};

type MapLibreLngLat = { lat: number; lng: number };
type MapLibreMapLike = {
  remove: () => void;
  resize: () => void;
  getCenter: () => MapLibreLngLat;
  getZoom: () => number;
  jumpTo: (options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }) => void;
  on: (event: string, listener: (event?: any) => void) => void;
  off: (event: string, listener: (event?: any) => void) => void;
  isStyleLoaded: () => boolean;
  getSource: (id: string) => unknown;
  addSource: (id: string, source: Record<string, unknown>) => void;
  removeSource: (id: string) => void;
  getLayer: (id: string) => unknown;
  addLayer: (layer: Record<string, unknown>) => void;
  removeLayer: (id: string) => void;
  touchZoomRotate?: { disableRotation?: () => void };
};

type MapLibreModuleLike = {
  Map: new (options: Record<string, unknown>) => MapLibreMapLike;
};

let mapLibreModulePromise: Promise<MapLibreModuleLike> | null = null;

function ensureMapLibreCss(): void {
  if (document.querySelector(`link[data-astrosight-maplibre-css="true"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = MAPLIBRE_CSS_URL;
  link.dataset.astrosightMaplibreCss = "true";
  document.head.appendChild(link);
}

function loadMapLibreModule(): Promise<MapLibreModuleLike> {
  if (!mapLibreModulePromise) {
    ensureMapLibreCss();
    const moduleUrl = MAPLIBRE_MODULE_URL;
    mapLibreModulePromise = import(/* @vite-ignore */ moduleUrl) as Promise<MapLibreModuleLike>;
  }
  return mapLibreModulePromise;
}

const GSI_SOURCE_ID = "astrosight-gsi-seamlessphoto";
const GSI_LAYER_ID = "astrosight-gsi-seamlessphoto-layer";

function syncSatelliteLayer(map: MapLibreMapLike, mapType: MapType): void {
  if (!map.isStyleLoaded()) return;

  if (mapType === "satellite") {
    if (!map.getSource(GSI_SOURCE_ID)) {
      map.addSource(GSI_SOURCE_ID, {
        type: "raster",
        tiles: [GSI_SEAMLESSPHOTO_TILE_URL],
        tileSize: 256,
        minzoom: 14,
        maxzoom: 18,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">国土地理院 全国最新写真（シームレス）</a>',
      });
    }
    if (!map.getLayer(GSI_LAYER_ID)) {
      // 最上層に置き、航空写真モードではBrightの文字や道路を重ねない。
      // z14未満はシームレス写真が提供されないためBrightがフォールバック表示される。
      map.addLayer({
        id: GSI_LAYER_ID,
        type: "raster",
        source: GSI_SOURCE_ID,
        minzoom: 13,
        paint: {
          "raster-opacity": 1,
          "raster-fade-duration": 0,
        },
      });
    }
    return;
  }

  if (map.getLayer(GSI_LAYER_ID)) map.removeLayer(GSI_LAYER_ID);
  if (map.getSource(GSI_SOURCE_ID)) map.removeSource(GSI_SOURCE_ID);
}

function nearlyEqual(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) <= epsilon;
}

export function MapLibre2DMap({
  center,
  zoom,
  mapType,
  onViewChange,
  onTap,
  onError,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMapLike | null>(null);
  const mapTypeRef = useRef(mapType);
  const viewRef = useRef({ center, zoom });
  const onViewChangeRef = useRef(onViewChange);
  const onTapRef = useRef(onTap);
  const onErrorRef = useRef(onError);
  const frameRef = useRef<number | null>(null);
  const applyingExternalViewRef = useRef(false);

  mapTypeRef.current = mapType;
  viewRef.current = { center, zoom };
  onViewChangeRef.current = onViewChange;
  onTapRef.current = onTap;
  onErrorRef.current = onError;

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (!container) return;

    let resizeObserver: ResizeObserver | null = null;

    void loadMapLibreModule()
      .then((maplibre) => {
        if (disposed || !containerRef.current) return;

        const initialView = viewRef.current;
        const map = new maplibre.Map({
          container: containerRef.current,
          style: OPENFREEMAP_BRIGHT_STYLE_URL,
          center: [initialView.center.longitude, initialView.center.latitude],
          zoom: toMapLibreZoom(initialView.zoom),
          minZoom: toMapLibreZoom(3),
          maxZoom: toMapLibreZoom(20),
          bearing: 0,
          pitch: 0,
          maxPitch: 0,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          attributionControl: true,
          cooperativeGestures: false,
          fadeDuration: 0,
        });
        mapRef.current = map;
        map.touchZoomRotate?.disableRotation?.();

        const publishView = () => {
          if (applyingExternalViewRef.current) return;
          if (frameRef.current !== null) return;
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            if (disposed || mapRef.current !== map) return;
            const currentCenter = map.getCenter();
            onViewChangeRef.current({
              center: {
                latitude: currentCenter.lat,
                longitude: currentCenter.lng,
              },
              zoom: fromMapLibreZoom(map.getZoom()),
            });
          });
        };

        const handleLoad = () => {
          if (disposed || mapRef.current !== map) return;
          syncSatelliteLayer(map, mapTypeRef.current);
          map.resize();
        };
        const handleStyleData = () => {
          if (disposed || mapRef.current !== map) return;
          syncSatelliteLayer(map, mapTypeRef.current);
        };
        const handleClick = (event?: any) => {
          const lngLat = event?.lngLat;
          if (!lngLat || !onTapRef.current) return;
          onTapRef.current({ latitude: lngLat.lat, longitude: lngLat.lng });
        };
        const handleError = (event?: any) => {
          const detail = event?.error?.message || event?.message;
          onErrorRef.current?.(
            detail
              ? `2D地図を読み込めませんでした：${String(detail)}`
              : "2D地図を読み込めませんでした"
          );
        };

        map.on("load", handleLoad);
        map.on("styledata", handleStyleData);
        map.on("move", publishView);
        map.on("zoom", publishView);
        map.on("click", handleClick);
        map.on("error", handleError);

        resizeObserver = new ResizeObserver(() => map.resize());
        resizeObserver.observe(container);
      })
      .catch((error: unknown) => {
        console.error("MapLibre GL JSの読み込みに失敗しました", error);
        onErrorRef.current?.(
          "2D地図エンジン（MapLibre）を読み込めませんでした。通信状態を確認してください"
        );
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // 初期生成時のviewだけを使い、以後のprop同期は下のeffectで行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncSatelliteLayer(map, mapType);
  }, [mapType]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const currentCenter = map.getCenter();
    const currentAppZoom = fromMapLibreZoom(map.getZoom());
    if (
      nearlyEqual(currentCenter.lat, center.latitude, 1e-9) &&
      nearlyEqual(currentCenter.lng, center.longitude, 1e-9) &&
      nearlyEqual(currentAppZoom, zoom, 1e-6)
    ) {
      return;
    }

    applyingExternalViewRef.current = true;
    map.jumpTo({
      center: [center.longitude, center.latitude],
      zoom: toMapLibreZoom(zoom),
      bearing: 0,
      pitch: 0,
    });
    // jumpToは同期的にviewを反映する。イベントからAppへ同値を書き戻さないため
    // microtask後に外部同期フラグを解除する。
    queueMicrotask(() => {
      applyingExternalViewRef.current = false;
    });
  }, [center.latitude, center.longitude, zoom]);

  return (
    <div
      ref={containerRef}
      className="maplibre-2d-map"
      aria-label={mapType === "satellite" ? "国土地理院 航空写真" : "OpenFreeMap Bright 通常地図"}
    />
  );
}
