/**
 * 自由ビューモードの天体・軌跡（2026-10-09）。
 *
 * 観測地点は自由ビューの視点だけ。被写体は使わない（仮の被写体も作らない）。
 * 天体位置・大気差・月相は既存の celestial.ts の計算をそのまま呼び、
 * カメラの向きは cameraModelFactory.createFreeViewCameraModel のモデルから作った
 * 投影基底（Cesiumの実カメラと同じモデル）で画面座標へ変換する。
 */
import type { CalculationMode } from "../types/camera";
import type {
  CelestialOcclusionMap,
  CelestialScreenPoint,
  CelestialTrack,
  CelestialVisibility,
  MilkyWayPathPoint,
} from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { GeometryCameraModel } from "../cesium/cameraModelFactory";
import {
  calculateCelestialScreenPointsForProjection,
  calculateCelestialTrackSamples,
  calculateMilkyWayScreenPathForProjection,
  cameraProjectionFromModel,
  celestialTrackSampleMinutes,
  projectCelestialTrackSamples,
  type CelestialTrackSamples,
} from "../cesium/celestial";
import { selectCelestialTrackPass } from "../cesium/celestialTrackPass";
import {
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
} from "../time/zonedTime";

export type FreeViewBody = "sun" | "moon" | "milkyWay";

/** 上部プレビューと同じ: 深夜をまたぐ通過が0:00で途切れないよう前後12時間延長する。 */
export const FREE_VIEW_TRACK_EXTENSION_MS = 12 * 60 * 60 * 1000;

export type FreeViewDayRange = {
  date: Date;
  dayStart: Date;
  dayEnd: Date;
};

/** 視点のタイムゾーンでの「選択日」の0時〜翌0時と、選択時刻の絶対時刻。 */
export function freeViewDayRange(dateTimeLocal: string, timeZone: string): FreeViewDayRange | null {
  const date = dateFromZonedDateTimeLocal(dateTimeLocal, timeZone);
  const dateText = dateTimeLocal.slice(0, 10);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}$/u.test(dateText)) return null;
  const dayStart = dateFromZonedDateTimeLocal(`${dateText}T00:00`, timeZone);
  const dayEnd = dateFromZonedDateTimeLocal(
    `${dateTextFromDaySerial(daySerialFromDateText(dateText) + 1)}T00:00`,
    timeZone
  );
  if (Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime())) return null;
  return { date, dayStart, dayEnd };
}

/** 軌跡の刻み（分）。既存と同じく画角に応じて1〜10分。 */
export function freeViewTrackSampleMinutes(model: GeometryCameraModel): number {
  return celestialTrackSampleMinutes(cameraProjectionFromModel(model));
}

/**
 * 選択中の天体の軌跡（各時刻の方位・高度）。カメラの向きには依存しないので、
 * 視線を回している間は計算し直さない（投影だけ freeViewCelestialFrame でやり直す）。
 */
export function freeViewTrackSamples(
  lensObserver: GroundPoint,
  calculationMode: CalculationMode,
  range: FreeViewDayRange,
  timeZone: string,
  sampleMinutes: number,
  body: FreeViewBody
): CelestialTrackSamples[] {
  return calculateCelestialTrackSamples(
    lensObserver,
    calculationMode,
    new Date(range.dayStart.getTime() - FREE_VIEW_TRACK_EXTENSION_MS),
    new Date(range.dayEnd.getTime() + FREE_VIEW_TRACK_EXTENSION_MS),
    timeZone,
    sampleMinutes,
    undefined,
    [body]
  );
}

export type FreeViewCelestialFrame = {
  points: CelestialScreenPoint[];
  tracks: CelestialTrack[];
  milkyWayPath: MilkyWayPathPoint[];
  visibility: CelestialVisibility;
  occlusion: CelestialOcclusionMap;
};

export function freeViewCelestialFrame(input: {
  model: GeometryCameraModel;
  date: Date;
  calculationMode: CalculationMode;
  body: FreeViewBody;
  showCelestial: boolean;
  showTracks: boolean;
  trackSamples: readonly CelestialTrackSamples[];
}): FreeViewCelestialFrame {
  const { model, date, calculationMode, body } = input;
  const projection = cameraProjectionFromModel(model);
  const lensObserver = model.observerPoint;
  // 描画側（CelestialOverlay）は visibility が真の天体だけ本体・軌跡を描く。
  // 本体だけ消して軌跡を残せるよう、どちらかが表示なら真にし、本体は points を空にして消す。
  const shown = input.showCelestial || input.showTracks;
  const visibility: CelestialVisibility = {
    sun: shown && body === "sun",
    moon: shown && body === "moon",
    milkyWay: shown && body === "milkyWay",
    polaris: false,
  };

  const points = input.showCelestial
    ? calculateCelestialScreenPointsForProjection(date, lensObserver, projection, calculationMode)
    : [];

  // 地平線より下の太陽・月は、円盤を描かず「位置」だけの表示にする
  // （既存の遮蔽判定が高度0度以下で返すのと同じ扱い）。
  // 地形・建物で隠れるかどうかは判定していない（未判定のまま。隠れたとは表示しない）。
  const occlusion: CelestialOcclusionMap = {};
  for (const point of points) {
    if ((point.id === "sun" || point.id === "moon") && point.altitudeDegrees <= 0) {
      occlusion[point.id] = {
        verificationState: "dem-only",
        visible: false,
        verified: true,
        terrainObstructed: false,
        photorealisticMeshObstructed: false,
        reason: "below-horizon",
        celestialApparentAltitudeDegrees: point.altitudeDegrees,
        celestialGeometricAltitudeDegrees: point.geometricAltitudeDegrees ?? point.altitudeDegrees,
      };
    }
  }

  // 軌跡: 前後12時間へ延長した範囲から、選択時刻を含む（無ければ最も近い）1回の通過だけ残す。
  const tracks = input.showTracks
    ? projectCelestialTrackSamples(
        input.trackSamples.filter((track) => track.id === body),
        projection
      ).map((track) => selectCelestialTrackPass(track, date.getTime()))
    : [];

  // 天の川: その時刻の銀河面の帯。地平線より下の部分は塗らない（輪郭だけ）。
  const milkyWayPath = input.showCelestial && body === "milkyWay"
    ? calculateMilkyWayScreenPathForProjection(date, lensObserver, projection, calculationMode, 5)
        .map((point) => ({ ...point, lineOfSightVisible: point.altitudeDegrees > 0 }))
    : [];

  return { points, tracks, milkyWayPath, visibility, occlusion };
}
