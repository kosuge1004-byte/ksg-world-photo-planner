import {
  Body,
  DefineStar,
  Equator,
  Horizon,
  Illumination,
  Libration,
  MoonPhase,
  Observer,
  Refraction,
} from "astronomy-engine";

import type {
  CalculationMode,
  CameraSettings,
  CameraViewCorrection,
} from "../types/camera";
import type {
  CelestialBodyId,
  CelestialScreenPoint,
  CelestialTrack,
  HorizontalCoordinates,
  MilkyWayPathPoint,
} from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { zonedDateParts } from "../time/zonedTime";
import { sensorDimensionsMm } from "./camera";
import { calculateElevationAngleDegrees } from "./geometry";
import { calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import {
  weatherForDate,
  weatherRefractionCorrectionDegrees,
  type RefractionWeatherContext,
} from "../search/refractionWeather";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const AU_KILOMETERS = 149_597_870.7;
const BODY_RADIUS_KILOMETERS = {
  sun: 695_700,
  moon: 1_737.4,
} as const;

/**
 * 太陽・月の視直径（度）を返す。天の川・北極星は点光源として扱い 0 を返す。
 * ②の建物3D遮蔽の詳細判定（円盤の縁を複数点サンプリング）で使用する。
 */
export function celestialAngularDiameterDegrees(
  celestialId: CelestialBodyId,
  date: Date,
  observerPoint: GroundPoint
): number {
  if (celestialId !== "sun" && celestialId !== "moon") return 0;
  const body = celestialId === "sun" ? Body.Sun : Body.Moon;
  const observer = new Observer(
    observerPoint.latitude,
    observerPoint.longitude,
    observerPoint.height
  );
  const equatorial = Equator(body, date, observer, true, true);
  const distanceKilometers = equatorial.dist * AU_KILOMETERS;
  const radius = BODY_RADIUS_KILOMETERS[body === Body.Moon ? "moon" : "sun"];
  const angularRadius = Math.asin(
    Math.min(1, radius / Math.max(radius, distanceKilometers))
  );
  return 2 * angularRadius * RAD;
}

type LocalVector = { east: number; north: number; up: number };

export type CameraProjection = {
  horizontalFov: number;
  verticalFov: number;
  right: LocalVector;
  up: LocalVector;
  forward: LocalVector;
};

// J2000 coordinates. Star1 = Polaris, Star2 = Galactic Center (Milky Way core).
DefineStar(Body.Star1, 2.530301, 89.26411, 433);
DefineStar(Body.Star2, 17.761122, -29.00781, 26000);

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function calculateCelestialHorizontalCoordinates(
  id: CelestialBodyId,
  date: Date,
  observerPoint: GroundPoint,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): HorizontalCoordinates {
  const observer = new Observer(
    observerPoint.latitude,
    observerPoint.longitude,
    observerPoint.height
  );

  const body =
    id === "sun"
      ? Body.Sun
      : id === "moon"
        ? Body.Moon
        : id === "milkyWay"
          ? Body.Star2
          : Body.Star1;

  // ofdate=true is required before converting to horizontal coordinates.
  const equatorial = Equator(body, date, observer, true, true);
  const useWeather = refractionWeather?.effectiveMode === "weather";
  const geometricHorizon = Horizon(
    date,
    observer,
    equatorial.ra,
    equatorial.dec,
    undefined
  );
  const geometricAltitudeDegrees = geometricHorizon.altitude;
  let azimuthDegrees = geometricHorizon.azimuth;
  let altitudeDegrees = geometricAltitudeDegrees;
  if (calculationMode === "pro" && !useWeather) {
    // 標準大気差を使う場合も、診断と幾何比較用に補正前高度を保持する。
    const apparentHorizon = Horizon(
      date,
      observer,
      equatorial.ra,
      equatorial.dec,
      "normal"
    );
    azimuthDegrees = apparentHorizon.azimuth;
    altitudeDegrees = apparentHorizon.altitude;
  }
  if (useWeather) {
    const weather = weatherForDate(refractionWeather, date);
    const correction = weather
      ? weatherRefractionCorrectionDegrees(altitudeDegrees, weather)
      : null;
    if (correction !== null) altitudeDegrees += correction;
  }

  return {
    azimuthDegrees: normalizeDegrees(azimuthDegrees),
    altitudeDegrees,
    geometricAltitudeDegrees,
  };
}

function observerAtLens(
  tripod: GroundPoint,
  settings: CameraSettings
): GroundPoint {
  return {
    ...tripod,
    height: tripod.height + settings.lensCenterHeightMeters,
  };
}

function dot(a: LocalVector, b: LocalVector): number {
  return a.east * b.east + a.north * b.north + a.up * b.up;
}

function normalize(vector: LocalVector): LocalVector {
  const length = Math.hypot(vector.east, vector.north, vector.up);
  if (length < 1e-12) return { east: 0, north: 0, up: 0 };
  return {
    east: vector.east / length,
    north: vector.north / length,
    up: vector.up / length,
  };
}

function horizontalDirection(
  horizontal: HorizontalCoordinates
): LocalVector {
  const azimuth = horizontal.azimuthDegrees * DEG;
  const altitude = horizontal.altitudeDegrees * DEG;
  const horizontalLength = Math.cos(altitude);
  return {
    east: horizontalLength * Math.sin(azimuth),
    north: horizontalLength * Math.cos(azimuth),
    up: Math.sin(altitude),
  };
}

export function createCameraProjection(
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  previewAspectRatio: number,
  viewCorrection?: CameraViewCorrection
): CameraProjection {
  const line = calculateKarneyLineMetrics(tripod, subject);
  const cameraAltitude = calculateElevationAngleDegrees(
    observerAtLens(tripod, settings),
    subject
  );
  const sensor = sensorDimensionsMm(previewAspectRatio);
  const horizontalFov =
    2 * Math.atan(sensor.width / (2 * settings.focalLengthMm)) * RAD;
  const verticalFov =
    2 * Math.atan(sensor.height / (2 * settings.focalLengthMm)) * RAD;
  const cameraAzimuth = line.bearingDegrees + (viewCorrection?.azimuthDegrees ?? 0);
  const correctedCameraAltitude = cameraAltitude + (viewCorrection?.altitudeDegrees ?? 0);
  const cameraAzimuthRadians = cameraAzimuth * DEG;
  const cameraAltitudeRadians = correctedCameraAltitude * DEG;
  const forward = horizontalDirection({
    azimuthDegrees: cameraAzimuth,
    altitudeDegrees: correctedCameraAltitude,
  });
  const right = {
    east: Math.cos(cameraAzimuthRadians),
    north: -Math.sin(cameraAzimuthRadians),
    up: 0,
  };
  const cameraUp = {
    east: -Math.sin(cameraAzimuthRadians) * Math.sin(cameraAltitudeRadians),
    north: -Math.cos(cameraAzimuthRadians) * Math.sin(cameraAltitudeRadians),
    up: Math.cos(cameraAltitudeRadians),
  };
  return {
    horizontalFov,
    verticalFov,
    right,
    up: cameraUp,
    forward,
  };
}

function projectDirectionToImagePlane(
  direction: LocalVector,
  projection: CameraProjection
): { x: number; y: number; inFront: boolean } {
  const forwardDistance = dot(direction, projection.forward);
  if (forwardDistance <= 1e-8) {
    return { x: 0, y: 0, inFront: false };
  }
  return {
    x: dot(direction, projection.right) / forwardDistance,
    // 画像座標は下向きを正にする。
    y: -dot(direction, projection.up) / forwardDistance,
    inFront: true,
  };
}

export function projectHorizontalToPreview(
  horizontal: HorizontalCoordinates,
  projection: CameraProjection
): {
  xPercent: number;
  yPercent: number;
  visibleInFrame: boolean;
  inFront: boolean;
} {
  // 方位差の線形換算ではなく、実カメラと同じ中心投影で画面座標へ変換する。
  const plane = projectDirectionToImagePlane(
    horizontalDirection(horizontal),
    projection
  );
  const xPercent =
    50 + 50 * plane.x / Math.tan(projection.horizontalFov * DEG / 2);
  const yPercent =
    50 + 50 * plane.y / Math.tan(projection.verticalFov * DEG / 2);

  return {
    xPercent,
    yPercent,
    visibleInFrame:
      plane.inFront &&
      horizontal.altitudeDegrees > -1 &&
      xPercent >= 0 &&
      xPercent <= 100 &&
      yPercent >= 0 &&
      yPercent <= 100,
    inFront: plane.inFront,
  };
}

export function angularDistanceFromCameraCenterDegrees(
  horizontal: HorizontalCoordinates,
  projection: CameraProjection
): number {
  const direction = horizontalDirection(horizontal);
  return Math.acos(Math.max(-1, Math.min(1, dot(direction, projection.forward)))) * RAD;
}

function apparentDisc(
  body: typeof Body.Sun | typeof Body.Moon,
  date: Date,
  observerPoint: GroundPoint,
  projection: CameraProjection,
  geometricAltitudeDegrees: number,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): {
  angularDiameterDegrees: number;
  verticalAngularDiameterDegrees: number;
  diameterWidthPercent: number;
  diameterHeightPercent: number;
  distanceKilometers: number;
} {
  const observer = new Observer(
    observerPoint.latitude,
    observerPoint.longitude,
    observerPoint.height
  );
  const equatorial = Equator(body, date, observer, true, true);
  const distanceKilometers = equatorial.dist * AU_KILOMETERS;
  const radius = body === Body.Moon
    ? BODY_RADIUS_KILOMETERS.moon
    : BODY_RADIUS_KILOMETERS.sun;
  const angularRadius = Math.asin(
    Math.min(1, radius / Math.max(radius, distanceKilometers))
  );
  const angularDiameterDegrees = 2 * angularRadius * RAD;
  // 中心高度の大気差補正と同じ経路（実況気象のBennett式、なければ標準大気式）を
  // 円盤上端・下端にも使う。円盤中心と縁で補正元が食い違うと、天気補正の
  // 適用時だけ「潰れ」の見え方が標準大気のままになる非対称が生じるため。
  const weather = refractionWeather?.effectiveMode === "weather"
    ? weatherForDate(refractionWeather, date)
    : null;
  const refractionAtDegrees = (altitudeDegrees: number): number => {
    if (weather) {
      const correction = weatherRefractionCorrectionDegrees(altitudeDegrees, weather);
      if (correction !== null) return correction;
    }
    return Refraction("normal", altitudeDegrees);
  };
  const verticalAngularDiameterDegrees = calculationMode === "pro"
    ? (
        geometricAltitudeDegrees + angularDiameterDegrees / 2 +
        refractionAtDegrees(geometricAltitudeDegrees + angularDiameterDegrees / 2)
      ) - (
        geometricAltitudeDegrees - angularDiameterDegrees / 2 +
        refractionAtDegrees(geometricAltitudeDegrees - angularDiameterDegrees / 2)
      )
    : angularDiameterDegrees;

  return {
    angularDiameterDegrees,
    verticalAngularDiameterDegrees,
    // tanを使い、長焦点でもピンホール投影と同じセンサー占有率にする。
    diameterWidthPercent:
      100 * Math.tan(angularRadius) /
      Math.tan(projection.horizontalFov * DEG / 2),
    diameterHeightPercent:
      100 * Math.tan(verticalAngularDiameterDegrees * DEG / 2) /
      Math.tan(projection.verticalFov * DEG / 2),
    distanceKilometers,
  };
}

/**
 * プレビューと日時検索で共有するフレーム内判定。
 * 太陽・月は現行プレビュー仕様どおり円盤の一部が入れば可視、
 * 天の川・北極星は中心点が入る場合だけ可視とする。
 */
export function isCelestialInCameraFrame(
  id: CelestialBodyId,
  date: Date,
  observerPoint: GroundPoint,
  horizontal: HorizontalCoordinates,
  projection: CameraProjection,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): boolean {
  const projected = projectHorizontalToPreview(horizontal, projection);
  if (id !== "sun" && id !== "moon") return projected.visibleInFrame;
  const geometricAltitudeDegrees = calculateCelestialHorizontalCoordinates(
    id,
    date,
    observerPoint,
    "standard"
  ).altitudeDegrees;
  const disc = apparentDisc(
    id === "sun" ? Body.Sun : Body.Moon,
    date,
    observerPoint,
    projection,
    geometricAltitudeDegrees,
    calculationMode,
    refractionWeather
  );
  return (
    projected.inFront &&
    horizontal.altitudeDegrees + disc.angularDiameterDegrees / 2 > -1 &&
    projected.xPercent + disc.diameterWidthPercent / 2 >= 0 &&
    projected.xPercent - disc.diameterWidthPercent / 2 <= 100 &&
    projected.yPercent + disc.diameterHeightPercent / 2 >= 0 &&
    projected.yPercent - disc.diameterHeightPercent / 2 <= 100
  );
}

function brightLimbAngleDegrees(
  moonHorizontal: HorizontalCoordinates,
  sunHorizontal: HorizontalCoordinates,
  projection: CameraProjection
): number {
  const moon = horizontalDirection(moonHorizontal);
  const sun = horizontalDirection(sunHorizontal);
  const separationProjection = dot(sun, moon);
  const tangent = normalize({
    east: sun.east - moon.east * separationProjection,
    north: sun.north - moon.north * separationProjection,
    up: sun.up - moon.up * separationProjection,
  });
  if (Math.hypot(tangent.east, tangent.north, tangent.up) < 1e-8) return 0;
  const epsilon = 0.0001;
  const towardSun = normalize({
    east: moon.east + tangent.east * epsilon,
    north: moon.north + tangent.north * epsilon,
    up: moon.up + tangent.up * epsilon,
  });
  const center = projectDirectionToImagePlane(moon, projection);
  const brightSide = projectDirectionToImagePlane(towardSun, projection);
  if (!center.inFront || !brightSide.inFront) return 0;
  return Math.atan2(
    brightSide.y - center.y,
    brightSide.x - center.x
  ) * RAD;
}

function moonNorthAngleDegrees(
  date: Date,
  observerPoint: GroundPoint,
  calculationMode: CalculationMode,
  moonHorizontal: HorizontalCoordinates,
  projection: CameraProjection
): number {
  const observer = new Observer(
    observerPoint.latitude,
    observerPoint.longitude,
    observerPoint.height
  );
  const equatorial = Equator(Body.Moon, date, observer, true, true);
  const north = Horizon(
    date,
    observer,
    equatorial.ra,
    Math.min(89.99, equatorial.dec + 0.01),
    calculationMode === "pro" ? "normal" : undefined
  );
  const centerDirection = horizontalDirection(moonHorizontal);
  const northDirection = horizontalDirection({
    azimuthDegrees: normalizeDegrees(north.azimuth),
    altitudeDegrees: north.altitude,
  });
  const center = projectDirectionToImagePlane(centerDirection, projection);
  const northPoint = projectDirectionToImagePlane(northDirection, projection);
  if (!center.inFront || !northPoint.inFront) return -90;
  return Math.atan2(
    northPoint.y - center.y,
    northPoint.x - center.x
  ) * RAD;
}

function moonAppearance(date: Date): {
  illuminationFraction: number;
  waxing: boolean;
  phaseAngleDegrees: number;
  librationLongitudeDegrees: number;
  librationLatitudeDegrees: number;
} {
  const info = Illumination(Body.Moon, date);
  const phaseAngle = MoonPhase(date); // 0=new, 90=first quarter, 180=full.
  const libration = Libration(date);

  return {
    illuminationFraction: Math.min(1, Math.max(0, info.phase_fraction)),
    waxing: phaseAngle < 180,
    phaseAngleDegrees: info.phase_angle,
    librationLongitudeDegrees: libration.elon,
    librationLatitudeDegrees: libration.elat,
  };
}

export function calculateCelestialScreenPoints(
  date: Date,
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  previewAspectRatio: number,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection,
  refractionWeather?: RefractionWeatherContext
): CelestialScreenPoint[] {
  const projection = createCameraProjection(
    tripod,
    subject,
    settings,
    previewAspectRatio,
    viewCorrection
  );

  const moon = moonAppearance(date);
  const lensObserver = observerAtLens(tripod, settings);

  const definitions: Array<{
    id: CelestialBodyId;
    label: string;
  }> = [
    { id: "sun", label: "太陽" },
    { id: "moon", label: "月" },
    { id: "milkyWay", label: "天の川" },
    { id: "polaris", label: "北極星" },
  ];

  const observations = definitions.map(({ id, label }) => ({
    id,
    label,
    horizontal: calculateCelestialHorizontalCoordinates(
      id,
      date,
      lensObserver,
      calculationMode,
      refractionWeather
    ),
  }));
  const sunHorizontal = observations.find(({ id }) => id === "sun")?.horizontal;
  const moonHorizontal = observations.find(({ id }) => id === "moon")?.horizontal;

  return observations.map(({ id, label, horizontal }) => {
    const { inFront, ...projected } = projectHorizontalToPreview(
      horizontal,
      projection
    );
    if (id !== "sun" && id !== "moon") {
      return { id, label, ...horizontal, ...projected, inFront };
    }

    const disc = apparentDisc(
      id === "sun" ? Body.Sun : Body.Moon,
      date,
      lensObserver,
      projection,
      calculationMode === "pro"
        ? calculateCelestialHorizontalCoordinates(
            id,
            date,
            lensObserver,
            "standard"
          ).altitudeDegrees
        : horizontal.altitudeDegrees,
      calculationMode,
      refractionWeather
    );
    const visibleInFrame = isCelestialInCameraFrame(
      id,
      date,
      lensObserver,
      horizontal,
      projection,
      calculationMode,
      refractionWeather
    );

    return {
      id,
      label,
      ...horizontal,
      ...projected,
      inFront,
      visibleInFrame,
      ...disc,
      ...(id === "moon"
        ? {
            ...moon,
            brightLimbAngleDegrees:
              moonHorizontal && sunHorizontal
                ? brightLimbAngleDegrees(
                    moonHorizontal,
                    sunHorizontal,
                    projection
                  )
                : 0,
            moonNorthAngleDegrees:
              moonHorizontal
                ? moonNorthAngleDegrees(
                    date,
                    lensObserver,
                    calculationMode,
                    moonHorizontal,
                    projection
                  )
                : -90,
          }
        : {}),
    };
  });
}

export function calculateCelestialScreenTracks(
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  previewAspectRatio: number,
  calculationMode: CalculationMode,
  dayStart: Date,
  dayEnd: Date,
  timeZone: string,
  viewCorrection?: CameraViewCorrection,
  refractionWeather?: RefractionWeatherContext
): CelestialTrack[] {
  const projection = createCameraProjection(
    tripod,
    subject,
    settings,
    previewAspectRatio,
    viewCorrection
  );
  const lensObserver = observerAtLens(tripod, settings);
  const definitions: Array<{ id: CelestialBodyId; label: string }> = [
    { id: "sun", label: "太陽" },
    { id: "moon", label: "月" },
    { id: "milkyWay", label: "天の川" },
    { id: "polaris", label: "北極星" },
  ];

  // 長焦点でも軌跡がフレームを飛び越えないよう、画角に応じて1～10分間隔へ細分化する。
  const minimumFovDegrees = Math.min(
    projection.horizontalFov,
    projection.verticalFov
  );
  const sampleMinutes = Math.max(
    1,
    Math.min(10, Math.floor(minimumFovDegrees))
  );
  const durationMilliseconds = Math.max(
    0,
    dayEnd.getTime() - dayStart.getTime()
  );
  const sampleMilliseconds = sampleMinutes * 60_000;

  return definitions.map(({ id, label }) => ({
    id,
    label,
    points: Array.from({
      length: Math.max(1, Math.floor(durationMilliseconds / sampleMilliseconds) + 1),
    }, (_, index) => {
      const sampleDate = new Date(
        Math.min(dayEnd.getTime(), dayStart.getTime() + index * sampleMilliseconds)
      );
      const horizontal = calculateCelestialHorizontalCoordinates(
        id,
        sampleDate,
        lensObserver,
        calculationMode,
        refractionWeather
      );
      const screenPoint = projectHorizontalToPreview(horizontal, projection);
      const projected = {
        xPercent: screenPoint.xPercent,
        yPercent: screenPoint.yPercent,
        inFront: screenPoint.inFront,
        visibleInFrame: screenPoint.visibleInFrame,
      };
      const { hour, minute } = zonedDateParts(sampleDate, timeZone);
      return {
        ...horizontal,
        ...projected,
        timestampMilliseconds: sampleDate.getTime(),
        timeLabel: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        showTimeLabel: minute === 0 && hour % 2 === 0,
      };
    }),
  }));
}


function galacticCoordinatesEquatorial(
  galacticLongitudeDegrees: number,
  galacticLatitudeDegrees = 0
): {
  raHours: number;
  decDegrees: number;
} {
  const l = galacticLongitudeDegrees * DEG;
  const b = galacticLatitudeDegrees * DEG;
  const xg = Math.cos(b) * Math.cos(l);
  const yg = Math.cos(b) * Math.sin(l);
  const zg = Math.sin(b);

  // IAU J2000 galactic -> equatorial rotation matrix.
  const x = -0.0548755604 * xg + 0.4941094279 * yg - 0.8676661490 * zg;
  const y = -0.8734370902 * xg - 0.44482963 * yg - 0.1980763734 * zg;
  const z = -0.4838350155 * xg + 0.7469822445 * yg + 0.4559837762 * zg;

  const raDegrees = normalizeDegrees(Math.atan2(y, x) * RAD);
  return {
    raHours: raDegrees / 15,
    decDegrees: Math.asin(Math.max(-1, Math.min(1, z))) * RAD,
  };
}

function milkyWayHalfWidthDegrees(galacticLongitudeDegrees: number): number {
  const distanceFromCore = Math.min(
    galacticLongitudeDegrees,
    360 - galacticLongitudeDegrees
  );
  // 銀河中心付近を太く、その他を細くした概略輪郭。中心線だけより実際の帯を把握しやすい。
  return 7 + 8 * Math.exp(-((distanceFromCore / 38) ** 2));
}

export function calculateMilkyWayScreenPath(
  date: Date,
  tripod: GroundPoint,
  subject: GroundPoint,
  settings: CameraSettings,
  previewAspectRatio: number,
  calculationMode: CalculationMode,
  viewCorrection?: CameraViewCorrection,
  sampleStepDegrees = 5,
  refractionWeather?: RefractionWeatherContext
): MilkyWayPathPoint[] {
  const projection = createCameraProjection(
    tripod,
    subject,
    settings,
    previewAspectRatio,
    viewCorrection
  );
  const observer = new Observer(
    tripod.latitude,
    tripod.longitude,
    tripod.height + settings.lensCenterHeightMeters
  );

  const path: MilkyWayPathPoint[] = [];
  const safeStep = Math.max(5, Math.min(90, sampleStepDegrees));
  for (let l = 0; l <= 360; l += safeStep) {
    const projectGalactic = (latitudeDegrees: number) => {
      const eq = galacticCoordinatesEquatorial(l, latitudeDegrees);
      const useWeather = refractionWeather?.effectiveMode === "weather";
      const horizon = Horizon(
        date,
        observer,
        eq.raHours,
        eq.decDegrees,
        calculationMode === "pro" && !useWeather ? "normal" : undefined
      );
      const weather = useWeather ? weatherForDate(refractionWeather, date) : null;
      const correction = weather
        ? weatherRefractionCorrectionDegrees(horizon.altitude, weather)
        : null;
      const horizontal = {
        azimuthDegrees: normalizeDegrees(horizon.azimuth),
        altitudeDegrees: horizon.altitude + (correction ?? 0),
      };
      return {
        ...horizontal,
        ...projectHorizontalToPreview(horizontal, projection),
      };
    };
    const halfWidth = milkyWayHalfWidthDegrees(l);
    const center = projectGalactic(0);
    const northEdge = projectGalactic(halfWidth);
    const southEdge = projectGalactic(-halfWidth);
    const inExtendedFrame = (point: typeof center) =>
      point.inFront &&
      point.xPercent >= -15 && point.xPercent <= 115 &&
      point.yPercent >= -15 && point.yPercent <= 115;
    path.push({
      azimuthDegrees: center.azimuthDegrees,
      altitudeDegrees: center.altitudeDegrees,
      xPercent: center.xPercent,
      yPercent: center.yPercent,
      northEdgeAzimuthDegrees: northEdge.azimuthDegrees,
      northEdgeAltitudeDegrees: northEdge.altitudeDegrees,
      northEdgeXPercent: northEdge.xPercent,
      northEdgeYPercent: northEdge.yPercent,
      southEdgeAzimuthDegrees: southEdge.azimuthDegrees,
      southEdgeAltitudeDegrees: southEdge.altitudeDegrees,
      southEdgeXPercent: southEdge.xPercent,
      southEdgeYPercent: southEdge.yPercent,
      visibleInFrame:
        center.altitudeDegrees > -8 &&
        (inExtendedFrame(center) ||
          inExtendedFrame(northEdge) ||
          inExtendedFrame(southEdge)),
    });
  }
  return path;
}
