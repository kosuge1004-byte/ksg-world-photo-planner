import { useEffect, useRef, useState } from "react";
import {
  Cartesian3,
  Cesium3DTileStyle,
  Cesium3DTileset,
  CesiumTerrainProvider,
  Color,
  ImageryLayer,
  Math as CesiumMath,
  PerspectiveFrustum,
  UrlTemplateImageryProvider,
  Viewer,
} from "cesium";

import type { ArDeviceLocation, ArDeviceOrientation } from "../ar/deviceTracking";
import { calculateCelestialHorizontalCoordinates } from "../cesium/celestial";
import { celestialWorldDirection } from "../cesium/celestialOcclusion";
import { dateFromZonedDateTimeLocal, daySerialFromDateText, dateTextFromDaySerial, zonedDateParts } from "../time/zonedTime";
import type { CalculationMode } from "../types/camera";
import type { CelestialBodyId, CelestialVisibility, HorizontalCoordinates } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import type { ArCameraProjection } from "./ArCameraScreen";

const GSI_STANDARD_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png";
const PLATEAU_BUILDINGS_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-maxlod2-latest/tileset.json";
const PLATEAU_TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain/";
const CAMERA_EYE_HEIGHT_METERS = 1.6;

const SUBJECT_PIN_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="34" height="48" viewBox="0 0 34 48">
    <path d="M17 47C13 38 3 29 3 17A14 14 0 0 1 31 17c0 12-10 21-14 30Z" fill="#e53935" stroke="#fff" stroke-width="2"/>
    <circle cx="17" cy="17" r="5" fill="#fff"/>
  </svg>
`)}`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * DeviceOrientation beta=90° を「端末を縦に持ち、背面カメラが水平を向く」基準とする。
 * ARCore/ARKit接続前のPhase 4では、磁気方位＋姿勢センサーをCesiumカメラへ直接接続する。
 */
function orientationToCesiumPose(orientation: ArDeviceOrientation | null): {
  headingRadians: number;
  pitchRadians: number;
  rollRadians: number;
} | null {
  const heading = orientation?.headingDegrees;
  if (heading === null || heading === undefined || !Number.isFinite(heading)) return null;

  const beta = orientation?.betaDegrees;
  const gamma = orientation?.gammaDegrees;
  const pitchDegrees = beta === null || beta === undefined
    ? 0
    : clamp(90 - beta, -85, 85);
  const rollDegrees = gamma === null || gamma === undefined
    ? 0
    : clamp(-gamma, -45, 45);

  return {
    headingRadians: CesiumMath.toRadians(heading),
    pitchRadians: CesiumMath.toRadians(pitchDegrees),
    rollRadians: CesiumMath.toRadians(rollDegrees),
  };
}

function applyCameraFov(viewer: Viewer, projection: ArCameraProjection | null): void {
  if (!projection) return;
  const frustum = viewer.camera.frustum;
  if (!(frustum instanceof PerspectiveFrustum)) return;
  const vertical = projection.verticalFovDeg;
  if (!Number.isFinite(vertical) || vertical <= 1 || vertical >= 175) return;
  frustum.fov = CesiumMath.toRadians(vertical);
}

function resolveObserverAltitude(viewer: Viewer, location: ArDeviceLocation): number {
  if (location.altitudeMeters !== null && Number.isFinite(location.altitudeMeters)) {
    return location.altitudeMeters + CAMERA_EYE_HEIGHT_METERS;
  }
  const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(
    Cartesian3.fromDegrees(location.longitude, location.latitude, 0)
  );
  if (cartographic) {
    const terrainHeight = viewer.scene.globe.getHeight(cartographic);
    if (terrainHeight !== undefined && Number.isFinite(terrainHeight)) {
      return terrainHeight + CAMERA_EYE_HEIGHT_METERS;
    }
  }
  // 高さが未確定の間に地中へ入るのを避けるため、初期表示だけ安全な高さを使用する。
  return 30;
}


const AR_CELESTIAL_PREFIX = "astrosight-ar-celestial-";
const AR_CELESTIAL_RAY_METERS = 1_000_000;
const AR_TRACK_SAMPLE_MINUTES = 10;

const AR_CELESTIAL_DEFINITIONS: Array<{
  id: Exclude<CelestialBodyId, "polaris">;
  label: string;
  color: Color;
  pointSize: number;
}> = [
  { id: "sun", label: "太陽", color: Color.GOLD, pointSize: 18 },
  { id: "moon", label: "月", color: Color.LIGHTCYAN, pointSize: 16 },
  { id: "milkyWay", label: "天の川", color: Color.fromCssColorString("#d8d0c5"), pointSize: 13 },
];

function celestialRayTarget(
  observer: Cartesian3,
  horizontal: HorizontalCoordinates
): Cartesian3 {
  return Cartesian3.add(
    observer,
    Cartesian3.multiplyByScalar(
      celestialWorldDirection(observer, horizontal),
      AR_CELESTIAL_RAY_METERS,
      new Cartesian3()
    ),
    new Cartesian3()
  );
}

function removeArCelestialEntities(viewer: Viewer): void {
  for (const entity of [...viewer.entities.values]) {
    if (typeof entity.id === "string" && entity.id.startsWith(AR_CELESTIAL_PREFIX)) {
      viewer.entities.remove(entity);
    }
  }
}

function splitVisibleTrackSegments(
  points: Array<{ horizontal: HorizontalCoordinates; position: Cartesian3 }>
): Cartesian3[][] {
  const result: Cartesian3[][] = [];
  let current: Cartesian3[] = [];
  for (const point of points) {
    if (point.horizontal.altitudeDegrees <= -1) {
      if (current.length > 1) result.push(current);
      current = [];
      continue;
    }
    current.push(point.position);
  }
  if (current.length > 1) result.push(current);
  return result;
}

function observerPointFromArLocation(location: ArDeviceLocation): GroundPoint {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    height: (location.altitudeMeters ?? 0) + CAMERA_EYE_HEIGHT_METERS,
    label: "AR現在地",
  };
}

type Props = {
  active: boolean;
  location: ArDeviceLocation | null;
  orientation: ArDeviceOrientation | null;
  projection: ArCameraProjection | null;
  subjectPoint: GroundPoint | null;
  dateTimeLocal: string;
  timeZone: string;
  calculationMode: CalculationMode;
  refractionWeather?: RefractionWeatherContext;
  visibility: CelestialVisibility;
  opacity: number;
  onStatusChange?: (message: string) => void;
};

export function ArCesiumOverlay({
  active,
  location,
  orientation,
  projection,
  subjectPoint,
  dateTimeLocal,
  timeZone,
  calculationMode,
  refractionWeather,
  visibility,
  opacity,
  onStatusChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active || !containerRef.current) return;
    let disposed = false;
    let viewer: Viewer | null = null;

    async function create() {
      const container = containerRef.current;
      if (!container) return;
      onStatusChange?.("AR 3D地図を準備しています…");

      let terrainProvider: CesiumTerrainProvider | undefined;
      try {
        terrainProvider = await CesiumTerrainProvider.fromUrl(PLATEAU_TERRAIN_URL, {
          requestVertexNormals: true,
        });
      } catch (error) {
        console.warn("AR PLATEAU terrain load failed", error);
      }
      if (disposed) return;

      const baseLayer = new ImageryLayer(new UrlTemplateImageryProvider({
        url: GSI_STANDARD_TILE_URL,
        credit: "地理院タイル（国土地理院）",
        maximumLevel: 18,
      }));

      viewer = new Viewer(container, {
        baseLayer,
        terrainProvider,
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        navigationHelpButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        requestRenderMode: true,
        maximumRenderTimeChange: Number.POSITIVE_INFINITY,
        contextOptions: {
          webgl: {
            alpha: true,
            antialias: true,
          },
        },
      });

      if (disposed) {
        viewer.destroy();
        return;
      }

      viewerRef.current = viewer;
      viewer.scene.backgroundColor = Color.TRANSPARENT;
      if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
      if (viewer.scene.sun) viewer.scene.sun.show = false;
      if (viewer.scene.moon) viewer.scene.moon.show = false;
      viewer.scene.fog.enabled = false;
      viewer.scene.globe.depthTestAgainstTerrain = true;
      viewer.scene.globe.enableLighting = false;
      viewer.scene.screenSpaceCameraController.enableInputs = false;

      if (terrainProvider) {
        try {
          const buildings = await Cesium3DTileset.fromUrl(PLATEAU_BUILDINGS_TILESET_URL);
          if (!disposed && viewer && !viewer.isDestroyed()) {
            buildings.maximumScreenSpaceError = 8;
            buildings.dynamicScreenSpaceError = true;
            buildings.skipLevelOfDetail = true;
            buildings.preferLeaves = true;
            buildings.style = new Cesium3DTileStyle({
              color: 'color("white", 0.92)',
            });
            viewer.scene.primitives.add(buildings);
          } else {
            buildings.destroy();
          }
        } catch (error) {
          console.warn("AR PLATEAU buildings load failed", error);
        }
      }

      if (disposed || !viewer || viewer.isDestroyed()) return;
      applyCameraFov(viewer, projection);
      setReady(true);
      onStatusChange?.(
        terrainProvider
          ? "AR 3D：PLATEAU地形・建物を半透明表示中"
          : "AR 3D：地形未取得のため地理院地図を表示中"
      );
      viewer.scene.requestRender();
    }

    void create().catch((error) => {
      console.error("AR 3D viewer initialization failed", error);
      if (!disposed) onStatusChange?.("AR 3D地図を開始できませんでした");
    });

    return () => {
      disposed = true;
      setReady(false);
      viewerRef.current = null;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
    };
  }, [active, onStatusChange]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !ready) return;
    applyCameraFov(viewer, projection);
    viewer.scene.requestRender();
  }, [projection, ready]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !ready || !location) return;
    const pose = orientationToCesiumPose(orientation);
    if (!pose) return;

    const altitude = resolveObserverAltitude(viewer, location);
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(location.longitude, location.latitude, altitude),
      orientation: {
        heading: pose.headingRadians,
        pitch: pose.pitchRadians,
        roll: pose.rollRadians,
      },
    });
    viewer.scene.requestRender();
  }, [location, orientation, ready]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !ready) return;
    const existing = viewer.entities.getById("astrosight-ar-subject-pin");
    if (existing) viewer.entities.remove(existing);
    if (subjectPoint) {
      viewer.entities.add({
        id: "astrosight-ar-subject-pin",
        name: subjectPoint.label || "被写体",
        position: Cartesian3.fromDegrees(
          subjectPoint.longitude,
          subjectPoint.latitude,
          subjectPoint.height
        ),
        billboard: {
          image: SUBJECT_PIN_IMAGE,
          width: 24,
          height: 34,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    viewer.scene.requestRender();
  }, [ready, subjectPoint]);


  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !ready || !location) return;

    removeArCelestialEntities(viewer);

    const selectedDate = dateFromZonedDateTimeLocal(dateTimeLocal, timeZone);
    if (Number.isNaN(selectedDate.getTime())) {
      viewer.scene.requestRender();
      return;
    }

    const observerPoint = observerPointFromArLocation(location);
    const observerCartesian = Cartesian3.fromDegrees(
      observerPoint.longitude,
      observerPoint.latitude,
      observerPoint.height
    );

    const dateText = dateTimeLocal.slice(0, 10);
    const daySerial = daySerialFromDateText(dateText);
    const dayStart = dateFromZonedDateTimeLocal(`${dateText}T00:00`, timeZone);
    const nextDateText = dateTextFromDaySerial(daySerial + 1);
    const dayEnd = dateFromZonedDateTimeLocal(`${nextDateText}T00:00`, timeZone);

    for (const definition of AR_CELESTIAL_DEFINITIONS) {
      if (!visibility[definition.id]) continue;

      const currentHorizontal = calculateCelestialHorizontalCoordinates(
        definition.id,
        selectedDate,
        observerPoint,
        calculationMode,
        refractionWeather
      );

      if (currentHorizontal.altitudeDegrees > -1) {
        viewer.entities.add({
          id: `${AR_CELESTIAL_PREFIX}${definition.id}-current`,
          name: `${definition.label} 現在位置`,
          position: celestialRayTarget(observerCartesian, currentHorizontal),
          point: {
            pixelSize: definition.pointSize,
            color: definition.color,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: definition.label,
            font: "bold 14px sans-serif",
            fillColor: definition.color,
            outlineColor: Color.BLACK,
            outlineWidth: 3,
            showBackground: true,
            backgroundColor: Color.BLACK.withAlpha(0.45),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }

      if (Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime())) continue;
      const sampleMs = AR_TRACK_SAMPLE_MINUTES * 60_000;
      const trackPoints: Array<{ date: Date; horizontal: HorizontalCoordinates; position: Cartesian3 }> = [];
      for (let timestamp = dayStart.getTime(); timestamp <= dayEnd.getTime(); timestamp += sampleMs) {
        const date = new Date(Math.min(timestamp, dayEnd.getTime()));
        const horizontal = calculateCelestialHorizontalCoordinates(
          definition.id,
          date,
          observerPoint,
          calculationMode,
          refractionWeather
        );
        trackPoints.push({
          date,
          horizontal,
          position: celestialRayTarget(observerCartesian, horizontal),
        });
      }

      splitVisibleTrackSegments(trackPoints).forEach((positions, segmentIndex) => {
        viewer.entities.add({
          id: `${AR_CELESTIAL_PREFIX}${definition.id}-track-${segmentIndex}`,
          name: `${definition.label} 軌跡`,
          polyline: {
            positions,
            width: definition.id === "milkyWay" ? 3 : 2.5,
            material: definition.color.withAlpha(definition.id === "milkyWay" ? 0.72 : 0.88),
            depthFailMaterial: definition.color.withAlpha(0.55),
          },
        });
      });

      for (const point of trackPoints) {
        if (point.horizontal.altitudeDegrees <= -1) continue;
        const parts = zonedDateParts(point.date, timeZone);
        if (parts.minute !== 0) continue;
        const timeLabel = `${String(parts.hour).padStart(2, "0")}:00`;
        viewer.entities.add({
          id: `${AR_CELESTIAL_PREFIX}${definition.id}-hour-${point.date.getTime()}`,
          name: `${definition.label} ${timeLabel}`,
          position: point.position,
          point: {
            pixelSize: 6,
            color: definition.color.withAlpha(0.95),
            outlineColor: Color.BLACK,
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: parts.hour % 2 === 0 ? {
            text: timeLabel,
            font: "bold 11px sans-serif",
            fillColor: definition.color,
            outlineColor: Color.BLACK,
            outlineWidth: 3,
            showBackground: true,
            backgroundColor: Color.BLACK.withAlpha(0.42),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          } : undefined,
        });
      }
    }

    viewer.scene.requestRender();
    return () => {
      if (!viewer.isDestroyed()) {
        removeArCelestialEntities(viewer);
        viewer.scene.requestRender();
      }
    };
  }, [
    calculationMode,
    dateTimeLocal,
    location,
    ready,
    refractionWeather,
    timeZone,
    visibility,
  ]);

  return (
    <div
      ref={containerRef}
      className="ar-camera-cesium-overlay"
      style={{ opacity: clamp(opacity, 0, 1) }}
      aria-hidden="true"
    />
  );
}
