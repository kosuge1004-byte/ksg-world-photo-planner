import { useEffect, useRef, useState } from "react";
import {
  Cartesian3,
  Cesium3DTileStyle,
  Cesium3DTileset,
  CesiumTerrainProvider,
  Color,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  PerspectiveFrustum,
  UrlTemplateImageryProvider,
  Viewer,
} from "cesium";

import type { ArDeviceLocation, ArDeviceOrientation } from "../ar/deviceTracking";
import { calculateCelestialHorizontalCoordinates } from "../cesium/celestial";
import { celestialWorldDirection } from "../cesium/celestialOcclusion";
import { loadGooglePhotorealisticTilesetWithRetry } from "../cesium/createMapViewer";
import { markAsGoogleTileset } from "../cesium/googleTilesetMarker";
import { dateFromZonedDateTimeLocal, daySerialFromDateText, dateTextFromDaySerial, zonedDateParts } from "../time/zonedTime";
import type { CalculationMode } from "../types/camera";
import type { CelestialBodyId, CelestialVisibility, HorizontalCoordinates } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { AccuracyMode } from "../types/precision";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import type { ArCameraProjection } from "./ArCameraScreen";

const GSI_STANDARD_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png";
const PLATEAU_BUILDINGS_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-maxlod2-latest/tileset.json";
const PLATEAU_TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain/";

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
 *
 * pitch/rollは、W3Cのalpha/beta/gamma回転行列（compassHeadingFromEulerと同じ規約）を
 * 使って「背面カメラの向き（-Z軸）」と「端末上端の向き（+Y軸）」をワールドENU座標へ
 * 変換し、そこから幾何学的に求める。betaだけ・gammaだけを個別に流用すると、
 * 端末を上下に傾けた時に符号が反転したり、左右に傾けた時に本来の傾きと無関係な値
 * （betaが90°付近ではgammaの変化がほぼ方位側に化けてしまう等）が混入するため、
 * 単純な角度の付け替えでは正しい姿勢にならない。
 */
function orientationToCesiumPose(orientation: ArDeviceOrientation | null): {
  headingRadians: number;
  pitchRadians: number;
  rollRadians: number;
} | null {
  const heading = orientation?.headingDegrees;
  if (heading === null || heading === undefined || !Number.isFinite(heading)) return null;

  const betaDeg = orientation?.betaDegrees;
  const gammaDeg = orientation?.gammaDegrees;

  let pitchDegrees = 0;
  let rollDegrees = 0;

  if (
    betaDeg !== null && betaDeg !== undefined && Number.isFinite(betaDeg) &&
    gammaDeg !== null && gammaDeg !== undefined && Number.isFinite(gammaDeg)
  ) {
    const degToRad = Math.PI / 180;
    const beta = betaDeg * degToRad;
    const gamma = gammaDeg * degToRad;
    const cB = Math.cos(beta);
    const sB = Math.sin(beta);
    const cG = Math.cos(gamma);
    const sG = Math.sin(gamma);

    // alpha（方位）はpitch/rollの値そのものには影響しない（headingは別途webkit-compass/
    // Euler由来の値をそのまま使う）ため、alpha=0の場合の式まで簡約して計算する。
    // forward: 背面カメラが向く方向（端末の-Z軸）をワールドENU(East, North, Up)で表したもの。
    const forward = { east: -sG, north: cG * sB, up: -cB * cG };
    // deviceUp: 端末上端が向く方向（端末の+Y軸）をワールドENUで表したもの。
    const deviceUp = { east: 0, north: cB, up: sB };

    pitchDegrees = clamp(Math.asin(clamp(forward.up, -1, 1)) / degToRad, -85, 85);

    // "傾き無し"の基準up（ワールドUpのうちforwardに直交する成分）に対して、
    // deviceUpがforward軸周りにどれだけ回転しているかをrollとする。
    const worldUpDotForward = forward.up; // worldUp=(0,0,1)とforwardの内積
    const refUp = {
      east: -forward.east * worldUpDotForward,
      north: -forward.north * worldUpDotForward,
      up: 1 - forward.up * worldUpDotForward,
    };
    const refUpLength = Math.hypot(refUp.east, refUp.north, refUp.up);
    // forward×worldUp = forwardをforward軸周りでrollゼロの"right"方向とする基準ベクトル。
    const right = { east: forward.north, north: -forward.east, up: 0 };
    const rightLength = Math.hypot(right.east, right.north, right.up);

    if (refUpLength > 1e-6 && rightLength > 1e-6) {
      const refUpNorm = { east: refUp.east / refUpLength, north: refUp.north / refUpLength, up: refUp.up / refUpLength };
      const rightNorm = { east: right.east / rightLength, north: right.north / rightLength, up: right.up / rightLength };
      const rollRight = deviceUp.east * rightNorm.east + deviceUp.north * rightNorm.north + deviceUp.up * rightNorm.up;
      const rollUp = deviceUp.east * refUpNorm.east + deviceUp.north * refUpNorm.north + deviceUp.up * refUpNorm.up;
      rollDegrees = clamp(Math.atan2(rollRight, rollUp) / degToRad, -89, 89);
    }
    // refUpLength/rightLengthがほぼ0（真上・真下を向いている等）の場合はrollを定義できないため0のまま。
  } else if (betaDeg !== null && betaDeg !== undefined && Number.isFinite(betaDeg)) {
    pitchDegrees = clamp(betaDeg - 90, -85, 85);
  }

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

function resolveObserverAltitude(
  viewer: Viewer,
  location: ArDeviceLocation,
  eyeHeightMeters: number
): number {
  if (location.altitudeMeters !== null && Number.isFinite(location.altitudeMeters)) {
    return location.altitudeMeters + eyeHeightMeters;
  }
  // Googleタイルモードはglobeを表示しない（globe: false）ため、
  // viewer.scene.globeがundefinedになる。GSI/PLATEAU側の地表高を使った
  // フォールバックはglobeがある場合のみ試みる。
  const globe = viewer.scene.globe;
  if (globe) {
    const cartographic = globe.ellipsoid.cartesianToCartographic(
      Cartesian3.fromDegrees(location.longitude, location.latitude, 0)
    );
    if (cartographic) {
      const terrainHeight = globe.getHeight(cartographic);
      if (terrainHeight !== undefined && Number.isFinite(terrainHeight)) {
        return terrainHeight + eyeHeightMeters;
      }
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

function observerPointFromArLocation(
  viewer: Viewer,
  location: ArDeviceLocation,
  eyeHeightMeters: number
): GroundPoint {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    // resolveObserverAltitudeと同じ計算に統一する（GPS高度→地形高→安全な
    // 既定値30mの順でフォールバックする）。以前はここだけ0mへ単純フォール
    // バックしており、GPS高度欠測時にAR系の中で基準がバラついていた。
    height: resolveObserverAltitude(viewer, location, eyeHeightMeters),
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
  accuracyMode: AccuracyMode;
  cesiumIonToken: string | undefined;
  lensCenterHeightMeters: number;
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
  accuracyMode,
  cesiumIonToken,
  lensCenterHeightMeters,
  onStatusChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active || !containerRef.current) return;
    let disposed = false;
    let viewer: Viewer | null = null;

    // AR用の透過3Dシーン共通設定。GSI/Googleどちらの中身でも、背後のカメラ映像が
    // 透けて見えるようにする点は共通のため、ここへ集約する。
    function configureTransparentArScene(target: Viewer): void {
      target.scene.backgroundColor = Color.TRANSPARENT;
      if (target.scene.skyBox) target.scene.skyBox.show = false;
      if (target.scene.skyAtmosphere) target.scene.skyAtmosphere.show = false;
      if (target.scene.sun) target.scene.sun.show = false;
      if (target.scene.moon) target.scene.moon.show = false;
      target.scene.fog.enabled = false;
      target.scene.screenSpaceCameraController.enableInputs = false;
    }

    const commonViewerOptions = {
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
    } as const;

    // メインの3Dマップ（標準＝国土地理院＋PLATEAU／Googleタイル＝Google Photorealistic
    // 3D Tiles）と同じソースをAR側でも表示する。GSI/PLATEAUは地表判定（高度の
    // フォールバック等）にも使うためglobeを維持するが、Googleタイルは
    // メインマップと同様globe非表示でタイルセットのみを描画する。
    async function createGsiViewer(container: HTMLDivElement): Promise<Viewer> {
      let terrainProvider: CesiumTerrainProvider | undefined;
      try {
        terrainProvider = await CesiumTerrainProvider.fromUrl(PLATEAU_TERRAIN_URL, {
          requestVertexNormals: true,
        });
      } catch (error) {
        console.warn("AR PLATEAU terrain load failed", error);
      }
      if (disposed) throw new Error("disposed");

      const baseLayer = new ImageryLayer(new UrlTemplateImageryProvider({
        url: GSI_STANDARD_TILE_URL,
        credit: "地理院タイル（国土地理院）",
        maximumLevel: 18,
      }));

      const gsiViewer = new Viewer(container, {
        ...commonViewerOptions,
        baseLayer,
        terrainProvider,
      });

      if (disposed) {
        gsiViewer.destroy();
        throw new Error("disposed");
      }

      configureTransparentArScene(gsiViewer);
      gsiViewer.scene.globe.depthTestAgainstTerrain = true;
      gsiViewer.scene.globe.enableLighting = false;

      if (terrainProvider) {
        try {
          const buildings = await Cesium3DTileset.fromUrl(PLATEAU_BUILDINGS_TILESET_URL);
          if (!disposed && !gsiViewer.isDestroyed()) {
            buildings.maximumScreenSpaceError = 8;
            buildings.dynamicScreenSpaceError = true;
            buildings.skipLevelOfDetail = true;
            buildings.preferLeaves = true;
            buildings.style = new Cesium3DTileStyle({
              color: 'color("white", 0.92)',
            });
            gsiViewer.scene.primitives.add(buildings);
          } else {
            buildings.destroy();
          }
        } catch (error) {
          console.warn("AR PLATEAU buildings load failed", error);
        }
      }

      onStatusChange?.(
        terrainProvider
          ? "AR 3D：PLATEAU地形・建物を半透明表示中"
          : "AR 3D：地形未取得のため地理院地図を表示中"
      );
      return gsiViewer;
    }

    async function createGoogleViewer(container: HTMLDivElement): Promise<Viewer> {
      if (!cesiumIonToken) {
        throw new Error("Cesium ionアカウントが接続されていないため、Googleタイルモードは利用できません");
      }

      // 2026-08-25追記: 旧来はここで開発者共有アカウントの月間利用件数
      // チェック（authorizeHighPrecisionSession）を行っていたが、BYOA化に
      // より数える対象が実態と合わなくなったため一旦外している
      // （src/App.tsxの同じ変更と対）。
      if (disposed) throw new Error("disposed");

      Ion.defaultAccessToken = cesiumIonToken;

      const googleViewer = new Viewer(container, {
        ...commonViewerOptions,
        globe: false,
      });

      if (disposed) {
        googleViewer.destroy();
        throw new Error("disposed");
      }

      onStatusChange?.("AR 3D：Google 3Dデータを読み込んでいます…");
      let tileset;
      try {
        tileset = await loadGooglePhotorealisticTilesetWithRetry(
          (message) => onStatusChange?.(`AR 3D：${message}`)
        );
      } catch (error) {
        googleViewer.destroy();
        throw error;
      }

      if (disposed || googleViewer.isDestroyed()) {
        tileset.destroy();
        googleViewer.destroy();
        throw new Error("disposed");
      }

      configureTransparentArScene(googleViewer);
      markAsGoogleTileset(tileset);
      googleViewer.scene.primitives.add(tileset);
      onStatusChange?.("AR 3D：Google Photorealistic 3D Tilesを半透明表示中");
      return googleViewer;
    }

    async function create() {
      const container = containerRef.current;
      if (!container) return;
      onStatusChange?.("AR 3D地図を準備しています…");

      let createdViewer: Viewer;
      if (accuracyMode === "highest") {
        try {
          createdViewer = await createGoogleViewer(container);
        } catch (error) {
          if (disposed) return;
          console.warn("AR Google 3D viewer initialization failed; falling back to GSI", error);
          onStatusChange?.("AR 3D：Google 3Dを利用できないため国土地理院地図で表示します");
          createdViewer = await createGsiViewer(container);
        }
      } else {
        createdViewer = await createGsiViewer(container);
      }

      if (disposed || createdViewer.isDestroyed()) {
        if (!createdViewer.isDestroyed()) createdViewer.destroy();
        return;
      }

      viewer = createdViewer;
      viewerRef.current = createdViewer;
      applyCameraFov(createdViewer, projection);
      setReady(true);
      createdViewer.scene.requestRender();
    }

    void create().catch((error) => {
      if (disposed) return;
      console.error("AR 3D viewer initialization failed", error);
      onStatusChange?.("AR 3D地図を開始できませんでした");
    });

    return () => {
      disposed = true;
      setReady(false);
      viewerRef.current = null;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
    };
    // projectionは意図的に依存配列へ含めない。ここでは新規Viewer作成時の
    // 初期FOV設定にのみ使う。ズーム操作等でのprojection変化への追従は、
    // 下のuseEffect（[projection, ready]）がViewerを再生成せずに行う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, accuracyMode, cesiumIonToken, onStatusChange]);

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

    const altitude = resolveObserverAltitude(viewer, location, lensCenterHeightMeters);
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(location.longitude, location.latitude, altitude),
      orientation: {
        heading: pose.headingRadians,
        pitch: pose.pitchRadians,
        roll: pose.rollRadians,
      },
    });
    viewer.scene.requestRender();
  }, [location, orientation, ready, lensCenterHeightMeters]);

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

    const observerPoint = observerPointFromArLocation(viewer, location, lensCenterHeightMeters);
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
    lensCenterHeightMeters,
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
